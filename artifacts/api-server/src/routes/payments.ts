import { Router } from "express";
import { db } from "@workspace/db";
import { paymentsTable, invoicesTable, clientsTable } from "@workspace/db/schema";
import { eq, and, desc, sum } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { sendNotification } from "../services/notificationService.js";

const router = Router();

// [real-card-charge 2026-07-22] Fire the payment_received email/SMS. Extracted
// from POST / so the real-charge endpoint below can reuse it verbatim instead
// of duplicating the lookup + merge-var block.
function firePaymentReceivedNotification(
  companyId: number,
  clientId: number,
  amount: number,
  invoiceId: number | null,
): void {
  db.select({ first_name: clientsTable.first_name, email: clientsTable.email, phone: clientsTable.phone })
    .from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1)
    .then(async ([cl]) => {
      if (!cl) return;
      // [account-comms-toggle] Skip if this client's account paused comms.
      const { isClientAccountCommsPaused } = await import("../lib/account-comms.js");
      if (await isClientAccountCommsPaused(clientId)) return;
      let invNum = invoiceId ? String(invoiceId) : "";
      if (invoiceId) {
        const [inv] = await db.select({ invoice_number: invoicesTable.invoice_number })
          .from(invoicesTable).where(eq(invoicesTable.id, invoiceId)).limit(1);
        if (inv?.invoice_number) invNum = inv.invoice_number;
      }
      const mv = {
        first_name:      cl.first_name || "",
        payment_amount:  amount.toFixed(2),
        payment_date:    new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
        invoice_number:  invNum,
      };
      sendNotification("payment_received", "email", companyId, cl.email, null, mv).catch(() => {});
      sendNotification("payment_received", "sms",   companyId, null, cl.phone, mv).catch(() => {});
    }).catch(() => {});
}

// ─── POST /payments/charge-card — REAL off-session charge of the card on file ──
// [real-card-charge 2026-07-22] The "Charge this card" button on the customer
// profile used to POST to `POST /payments`, which only RECORDS a payment: it
// inserts a completed row, marks the invoice paid, and emails/texts the customer
// a receipt — WITHOUT ever contacting Stripe. That endpoint is correct for
// logging outside payments (cash, check, Square), but wiring a *charge* action
// to it issued a receipt for money that never moved.
//
// This endpoint actually charges. Stripe runs FIRST; nothing is recorded and no
// receipt goes out unless Stripe returns succeeded. A decline surfaces Stripe's
// own message so the office knows why.
router.post("/charge-card", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const clientId = parseInt(String(req.body?.client_id ?? ""), 10);
    const amount = Number(req.body?.amount);
    const invoiceId = req.body?.invoice_id ? parseInt(String(req.body.invoice_id), 10) : null;
    const memo = typeof req.body?.memo === "string" ? req.body.memo.slice(0, 500) : null;

    if (!clientId || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "client_id and a positive amount are required" });
    }

    const [client] = await db
      .select({
        id: clientsTable.id,
        first_name: clientsTable.first_name,
        stripe_customer_id: clientsTable.stripe_customer_id,
        stripe_payment_method_id: clientsTable.stripe_payment_method_id,
        card_last_four: clientsTable.card_last_four,
        card_brand: clientsTable.card_brand,
        square_customer_id: clientsTable.square_customer_id,
        square_card_last4: clientsTable.square_card_last4,
        square_card_brand: clientsTable.square_card_brand,
      })
      .from(clientsTable)
      .where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, companyId)));
    if (!client) return res.status(404).json({ error: "Client not found" });

    // [square-charge 2026-07-24] Route by processor so ONE "Charge card on file"
    // button works for both. A Stripe card wins; otherwise a Square-linked client
    // is charged against their Square card on file. Runs before the Stripe-secret
    // check so a Square client never trips "Stripe is not configured".
    const hasStripeCard = !!(client.stripe_customer_id && client.stripe_payment_method_id);
    if (!hasStripeCard && client.square_customer_id) {
      const { chargeSquareCard } = await import("../lib/square-charge.js");
      const idempotencyKey = invoiceId
        ? `inv-${invoiceId}-${companyId}`
        : `chg-${clientId}-${companyId}-${Date.now()}`;
      const result = await chargeSquareCard({
        squareCustomerId: client.square_customer_id,
        amountCents: Math.round(amount * 100),
        idempotencyKey,
      });
      if (!result.ok) {
        const status = result.code === "not_configured" ? 503 : result.code === "no_card" ? 400 : 402;
        const error = result.code === "declined" ? "CHARGE_DECLINED"
          : result.code === "no_card" ? "NO_CHARGEABLE_CARD" : "SQUARE_CHARGE_FAILED";
        console.error("[charge-card] Square charge failed:", result.message, { clientId, amount });
        return res.status(status).json({ error, message: result.message });
      }
      const [sp] = await db.insert(paymentsTable).values({
        company_id: companyId,
        client_id: clientId,
        invoice_id: invoiceId,
        amount: amount.toString(),
        method: "square",
        status: "completed",
        last_4: client.square_card_last4 ?? null,
        card_brand: client.square_card_brand ?? null,
        square_payment_id: result.paymentId,
        processed_by: req.auth!.userId,
      } as any).returning();
      if (invoiceId) {
        await db.update(invoicesTable)
          .set({ paid_at: new Date(), status: "paid" as any, square_payment_id: result.paymentId } as any)
          .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)));
      }
      firePaymentReceivedNotification(companyId, clientId, amount, invoiceId);
      return res.status(201).json({ ...sp, charged: true, square_payment_id: result.paymentId });
    }

    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret || secret === "payments disabled") {
      return res.status(503).json({ error: "Stripe is not configured in this environment" });
    }

    // A last-4 on the record is NOT proof the card is chargeable — the
    // chargeable handle is stripe_payment_method_id. Say so plainly rather
    // than letting Stripe fail with something cryptic.
    if (!client.stripe_customer_id || !client.stripe_payment_method_id) {
      return res.status(400).json({
        error: "NO_CHARGEABLE_CARD",
        message: "This client has no chargeable Stripe card on file. Send them a card-on-file link to save one.",
      });
    }

    let intent: any;
    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(secret, { apiVersion: "2024-06-20" as any });
      intent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: "usd",
        customer: client.stripe_customer_id,
        payment_method: client.stripe_payment_method_id,
        confirm: true,
        off_session: true,
        description: memo || `Payment for ${client.first_name ?? "client"}`,
        metadata: {
          company_id: String(companyId),
          client_id: String(clientId),
          ...(invoiceId ? { invoice_id: String(invoiceId) } : {}),
          source: "office_charge_card_on_file",
        },
      });
    } catch (err: any) {
      // Declines arrive as a thrown StripeCardError with a human-readable message.
      const msg = err?.raw?.message || err?.message || "The card was declined.";
      console.error("[charge-card] Stripe charge failed:", msg, { clientId, amount });
      return res.status(402).json({ error: "CHARGE_DECLINED", message: msg });
    }

    if (intent?.status !== "succeeded") {
      return res.status(402).json({
        error: "CHARGE_NOT_COMPLETED",
        message: `Stripe returned status "${intent?.status}". No payment was recorded.`,
      });
    }

    // Stripe succeeded — NOW record it.
    const [p] = await db.insert(paymentsTable).values({
      company_id: companyId,
      client_id: clientId,
      invoice_id: invoiceId,
      amount: amount.toString(),
      method: "card",
      status: "completed",
      last_4: client.card_last_four,
      card_brand: client.card_brand,
      stripe_payment_id: intent.id,
      processed_by: req.auth!.userId,
    }).returning();

    if (invoiceId) {
      await db.update(invoicesTable)
        .set({ paid_at: new Date(), status: "paid" as any })
        .where(and(eq(invoicesTable.id, invoiceId), eq(invoicesTable.company_id, companyId)));
    }

    firePaymentReceivedNotification(companyId, clientId, amount, invoiceId);

    res.status(201).json({ ...p, charged: true, stripe_payment_intent_id: intent.id });
  } catch (e: any) {
    console.error("Charge card error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const clientId = req.query.client_id ? parseInt(req.query.client_id as string) : undefined;
    const conditions: any[] = [eq(paymentsTable.company_id, req.auth!.companyId)];
    if (clientId) conditions.push(eq(paymentsTable.client_id, clientId));
    const payments = await db
      .select()
      .from(paymentsTable)
      .where(and(...conditions))
      .orderBy(desc(paymentsTable.created_at));
    res.json(payments);
  } catch (e: any) {
    console.error("List payments error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { client_id, invoice_id, amount, method, last_4, card_brand, stripe_payment_id } = req.body;
    if (!client_id || !amount) return res.status(400).json({ error: "client_id and amount required" });
    const companyId = req.auth!.companyId;
    const [p] = await db.insert(paymentsTable).values({
      company_id: companyId,
      client_id: parseInt(client_id),
      invoice_id: invoice_id ? parseInt(invoice_id) : null,
      amount: amount.toString(),
      method: method || "card",
      status: "completed",
      last_4, card_brand, stripe_payment_id,
      processed_by: req.auth!.userId,
    }).returning();
    if (invoice_id) {
      await db.update(invoicesTable)
        .set({ paid_at: new Date(), status: "paid" as any })
        .where(and(eq(invoicesTable.id, parseInt(invoice_id)), eq(invoicesTable.company_id, companyId)));
    }
    // fire payment_received notification (non-blocking)
    firePaymentReceivedNotification(
      companyId,
      parseInt(client_id),
      parseFloat(amount),
      invoice_id ? parseInt(invoice_id) : null,
    );
    res.status(201).json(p);
  } catch (e: any) {
    console.error("Create payment error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/:id/refund", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    const [p] = await db
      .update(paymentsTable)
      .set({ status: "refunded", refunded_at: new Date(), refund_reason: reason || "" })
      .where(and(eq(paymentsTable.id, id), eq(paymentsTable.company_id, req.auth!.companyId)))
      .returning();
    if (!p) return res.status(404).json({ error: "Not found" });
    res.json(p);
  } catch (e: any) {
    console.error("Refund payment error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

// ── GET /api/payments/failed ─── Failed Stripe charges queue ─────────────────
router.get("/failed", requireAuth, async (req, res) => {
  try {
    const { sql: drizzleSql } = await import("drizzle-orm");
    const companyId = req.auth!.companyId;
    const rows = await db.execute(drizzleSql`
      SELECT p.id, p.job_id, p.client_id, p.amount, p.stripe_error_code,
             p.stripe_error_message, p.attempted_at, p.last_4, p.card_brand,
             c.first_name, c.last_name,
             j.service_type, j.scheduled_date
      FROM payments p
      JOIN clients c ON c.id = p.client_id
      LEFT JOIN jobs j ON j.id = p.job_id
      WHERE p.company_id = ${companyId}
        AND p.status = 'failed'
        AND p.stripe_error_code IS NOT NULL
      ORDER BY p.attempted_at DESC
      LIMIT 100
    `);
    return res.json({ data: rows.rows });
  } catch (e: any) {
    console.error("GET /payments/failed error:", e);
    return res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

export default router;
