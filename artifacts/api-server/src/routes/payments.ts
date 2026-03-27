import { Router } from "express";
import { db } from "@workspace/db";
import { paymentsTable, invoicesTable, clientsTable } from "@workspace/db/schema";
import { eq, and, desc, sum } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { sendNotification } from "../services/notificationService.js";

const router = Router();

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
    db.select({ first_name: clientsTable.first_name, email: clientsTable.email, phone: clientsTable.phone })
      .from(clientsTable).where(eq(clientsTable.id, parseInt(client_id))).limit(1)
      .then(async ([cl]) => {
        if (!cl) return;
        let invNum = invoice_id ? String(invoice_id) : "";
        if (invoice_id) {
          const [inv] = await db.select({ invoice_number: invoicesTable.invoice_number })
            .from(invoicesTable).where(eq(invoicesTable.id, parseInt(invoice_id))).limit(1);
          if (inv?.invoice_number) invNum = inv.invoice_number;
        }
        const mv = {
          first_name:      cl.first_name || "",
          payment_amount:  parseFloat(amount).toFixed(2),
          payment_date:    new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
          invoice_number:  invNum,
        };
        sendNotification("payment_received", "email", companyId, cl.email, null, mv).catch(() => {});
        sendNotification("payment_received", "sms",   companyId, null, cl.phone, mv).catch(() => {});
      }).catch(() => {});
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
