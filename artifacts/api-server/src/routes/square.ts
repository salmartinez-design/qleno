// [square 2026-07-22] Office-facing Square surfaces. Two queues, both READ-ONLY
// against Square — nothing here charges a card, creates a Square object, or
// touches QuickBooks.
//
//   /api/square/customers     — the customer map + its review queue. This is
//                               where the 72 needs-review and 61 email-mismatch
//                               rows from the initial sync get cleaned up.
//   /api/square/payments      — the payment reconciliation ledger + its review
//                               queue: payments that arrived but couldn't be
//                               matched to exactly one open invoice.
//
// Both queues exist because the alternative is guessing. A wrongly linked
// customer or a payment credited to the wrong one of five identical $420 visits
// is worse than an unresolved row, because it looks settled.
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { reconcileSquarePayment, decimalToCents } from "../lib/square-payment-reconcile.js";

const router = Router();

const officeOnly = [requireAuth, requireRole("owner", "admin", "office")] as const;

// ── Customer map ────────────────────────────────────────────────────────────

/** GET /api/square/customers?status=needs_review|linked|unmatched|ignored&email_mismatch=1&q= */
router.get("/customers", ...officeOnly, async (req: any, res) => {
  try {
    const companyId = req.user.company_id;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const mismatchOnly = req.query.email_mismatch === "1" || req.query.email_mismatch === "true";
    const q = typeof req.query.q === "string" && req.query.q.trim() ? `%${req.query.q.trim()}%` : null;

    const rows = (await db.execute(sql`
      SELECT m.*, (c.first_name || ' ' || c.last_name) AS client_name, c.email AS client_email,
             a.account_name AS account_name, p.property_name AS property_name
        FROM square_customer_map m
        LEFT JOIN clients c ON c.id = m.client_id
        LEFT JOIN accounts a ON a.id = m.account_id
        LEFT JOIN account_properties p ON p.id = m.account_property_id
       WHERE m.company_id = ${companyId}
         AND (${status}::text IS NULL OR m.status = ${status}::text)
         AND (${mismatchOnly} = false OR m.email_mismatch = true)
         AND (${q}::text IS NULL
              OR m.square_customer_name ILIKE ${q}::text
              OR m.square_email ILIKE ${q}::text
              OR m.square_company_name ILIKE ${q}::text)
       ORDER BY m.status, m.square_customer_name NULLS LAST
       LIMIT 500`) as any).rows;

    // Counts for the tab badges — computed over the whole map, not the filtered
    // page, so the queue size stays honest while the office filters around.
    const counts = (await db.execute(sql`
      SELECT status, count(*)::int AS n,
             count(*) FILTER (WHERE email_mismatch)::int AS mismatched
        FROM square_customer_map WHERE company_id = ${companyId}
       GROUP BY status`) as any).rows;

    res.json({ rows, counts });
  } catch (err: any) {
    console.error("[square/customers]", err?.message ?? err);
    res.status(500).json({ error: "Failed to load Square customer map" });
  }
});

/**
 * PATCH /api/square/customers/:id — the office resolving one review row.
 * Body: { client_id?, account_id?, account_property_id?, status?, is_account_primary? }
 * Setting status='linked' is what makes the row usable by the reconciler, so it
 * is deliberately a human action.
 */
router.patch("/customers/:id", ...officeOnly, async (req: any, res) => {
  try {
    const companyId = req.user.company_id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const before = (await db.execute(sql`
      SELECT * FROM square_customer_map WHERE id = ${id} AND company_id = ${companyId}`) as any).rows[0];
    if (!before) return res.status(404).json({ error: "Map row not found" });

    const b = req.body ?? {};
    const status: string | null = typeof b.status === "string" ? b.status : null;
    if (status && !["linked", "needs_review", "unmatched", "ignored"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const clientId = b.client_id === undefined ? before.client_id : (b.client_id === null ? null : Number(b.client_id));
    const accountId = b.account_id === undefined ? before.account_id : (b.account_id === null ? null : Number(b.account_id));
    const propertyId = b.account_property_id === undefined ? before.account_property_id
      : (b.account_property_id === null ? null : Number(b.account_property_id));

    // A linked row must actually point somewhere, or the reconciler will resolve
    // an identity to nothing and every payment for it lands back in review.
    if ((status ?? before.status) === "linked" && !clientId && !accountId) {
      return res.status(400).json({ error: "A linked customer must point to a client or an account" });
    }
    if (clientId && accountId) {
      return res.status(400).json({ error: "Pick a client OR an account, not both — the billing entity must be unambiguous" });
    }

    await db.execute(sql`
      UPDATE square_customer_map SET
        client_id = ${clientId}, account_id = ${accountId}, account_property_id = ${propertyId},
        is_account_primary = ${b.is_account_primary === undefined ? before.is_account_primary : !!b.is_account_primary},
        status = ${status ?? before.status},
        match_method = CASE WHEN ${status}::text = 'linked' THEN 'manual' ELSE match_method END,
        review_reason = CASE WHEN ${status}::text = 'linked' THEN NULL ELSE review_reason END,
        reviewed_at = now(), reviewed_by_user_id = ${req.user.id},
        linked_at = CASE WHEN ${status}::text = 'linked' THEN now() ELSE linked_at END,
        linked_by_user_id = CASE WHEN ${status}::text = 'linked' THEN ${req.user.id} ELSE linked_by_user_id END
      WHERE id = ${id} AND company_id = ${companyId}`);

    logAudit(req, "UPDATE", "square_customer_map", id,
      { client_id: before.client_id, account_id: before.account_id, status: before.status },
      { client_id: clientId, account_id: accountId, status: status ?? before.status });

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[square/customers PATCH]", err?.message ?? err);
    res.status(500).json({ error: "Failed to update Square customer map" });
  }
});

// ── Payment reconciliation queue ────────────────────────────────────────────

/** GET /api/square/payments?resolution=needs_review|applied|skipped|ignored */
router.get("/payments", ...officeOnly, async (req: any, res) => {
  try {
    const companyId = req.user.company_id;
    const resolution = typeof req.query.resolution === "string" ? req.query.resolution : null;

    const rows = (await db.execute(sql`
      SELECT e.id, e.square_payment_id, e.square_customer_id, e.amount, e.currency,
             e.card_brand, e.card_last4, e.square_status, e.square_created_at,
             e.resolution, e.review_reason, e.candidate_invoice_ids,
             e.matched_invoice_id, e.created_at, e.processed_at,
             m.square_customer_name, m.square_email,
             (c.first_name || ' ' || c.last_name) AS client_name, a.account_name AS account_name,
             i.invoice_number AS matched_invoice_number
        FROM square_payment_events e
        LEFT JOIN square_customer_map m
               ON m.company_id = e.company_id AND m.square_customer_id = e.square_customer_id
        LEFT JOIN clients c ON c.id = e.resolved_client_id
        LEFT JOIN accounts a ON a.id = e.resolved_account_id
        LEFT JOIN invoices i ON i.id = e.matched_invoice_id
       WHERE e.company_id = ${companyId}
         AND (${resolution}::text IS NULL OR e.resolution = ${resolution}::text)
       ORDER BY e.square_created_at DESC NULLS LAST, e.id DESC
       LIMIT 300`) as any).rows;

    const counts = (await db.execute(sql`
      SELECT resolution, count(*)::int AS n, sum(amount)::numeric AS total
        FROM square_payment_events WHERE company_id = ${companyId}
       GROUP BY resolution`) as any).rows;

    // For each needs_review row, hydrate the candidate invoices so the office
    // can pick without a second round-trip per row.
    const candidateIds = Array.from(new Set(
      rows.flatMap((r: any) => Array.isArray(r.candidate_invoice_ids) ? r.candidate_invoice_ids : [])
    )) as number[];
    let candidates: any[] = [];
    if (candidateIds.length) {
      candidates = (await db.execute(sql`
        SELECT id, invoice_number, total, status::text AS status, due_date::text AS due_date
          FROM invoices WHERE company_id = ${companyId} AND id = ANY(${candidateIds}::int[])`) as any).rows;
    }

    res.json({ rows, counts, candidates });
  } catch (err: any) {
    console.error("[square/payments]", err?.message ?? err);
    res.status(500).json({ error: "Failed to load Square payments" });
  }
});

/**
 * POST /api/square/payments/:id/retry — re-run the reconciler for one event.
 * The normal use: a payment landed as needs_review because the customer wasn't
 * mapped yet or the invoice hadn't been issued. Fix that, hit retry.
 */
router.post("/payments/:id/retry", ...officeOnly, async (req: any, res) => {
  try {
    const companyId = req.user.company_id;
    const id = Number(req.params.id);
    const ev = (await db.execute(sql`
      SELECT * FROM square_payment_events WHERE id = ${id} AND company_id = ${companyId}`) as any).rows[0];
    if (!ev) return res.status(404).json({ error: "Payment event not found" });
    if (ev.resolution === "applied") return res.status(409).json({ error: "Already applied" });

    const result = await reconcileSquarePayment({
      companyId,
      squarePaymentId: ev.square_payment_id,
      squareCustomerId: ev.square_customer_id,
      amountCents: decimalToCents(ev.amount),
      squareStatus: ev.square_status,
    });

    await db.execute(sql`
      UPDATE square_payment_events SET
        resolution = ${result.resolution}, review_reason = ${result.review_reason},
        resolved_client_id = ${result.client_id}, resolved_account_id = ${result.account_id},
        matched_invoice_id = ${result.matched_invoice_id},
        applied_payment_id = ${result.applied_payment_id},
        candidate_invoice_ids = ${JSON.stringify(result.candidate_invoice_ids)}::jsonb,
        processed_at = now(), reviewed_at = now(), reviewed_by_user_id = ${req.user.id}
      WHERE id = ${id} AND company_id = ${companyId}`);

    logAudit(req, "UPDATE", "square_payment_event", id, { resolution: ev.resolution }, { resolution: result.resolution });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[square/payments retry]", err?.message ?? err);
    res.status(500).json({ error: "Retry failed" });
  }
});

/**
 * POST /api/square/payments/:id/apply — the office resolving an ambiguous match
 * by hand: { invoice_id }. This is the deliberate human answer to "which of the
 * five identical $420 visits was this?" — the reconciler will never guess it.
 */
router.post("/payments/:id/apply", ...officeOnly, async (req: any, res) => {
  try {
    const companyId = req.user.company_id;
    const id = Number(req.params.id);
    const invoiceId = Number(req.body?.invoice_id);
    if (!Number.isFinite(invoiceId)) return res.status(400).json({ error: "invoice_id is required" });

    const ev = (await db.execute(sql`
      SELECT * FROM square_payment_events WHERE id = ${id} AND company_id = ${companyId}`) as any).rows[0];
    if (!ev) return res.status(404).json({ error: "Payment event not found" });
    if (ev.resolution === "applied") return res.status(409).json({ error: "Already applied" });

    let paymentId: number | null = null;
    try {
      await db.transaction(async (tx) => {
        const inv = (await tx.execute(sql`
          SELECT id, client_id, account_id, status::text AS status FROM invoices
           WHERE id = ${invoiceId} AND company_id = ${companyId}
             AND status IN ('draft','sent','overdue')
           FOR UPDATE`) as any).rows[0];
        if (!inv) throw new Error("NOT_OPEN");

        const ins = (await tx.execute(sql`
          INSERT INTO payments (company_id, client_id, invoice_id, amount, method, status, square_payment_id, processed_by)
          VALUES (${companyId}, ${inv.client_id}, ${invoiceId}, ${ev.amount}, 'square', 'completed',
                  ${ev.square_payment_id}, ${req.user.id})
          RETURNING id`) as any).rows[0];
        paymentId = ins?.id ?? null;

        await tx.execute(sql`UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = ${invoiceId} AND company_id = ${companyId}`);
      });
    } catch (e: any) {
      if (e?.message === "NOT_OPEN") {
        return res.status(409).json({ error: "That invoice is not open — it may already be paid or voided." });
      }
      throw e;
    }

    await db.execute(sql`
      UPDATE square_payment_events SET
        resolution = 'applied', review_reason = NULL, matched_invoice_id = ${invoiceId},
        applied_payment_id = ${paymentId}, processed_at = now(),
        reviewed_at = now(), reviewed_by_user_id = ${req.user.id}
      WHERE id = ${id} AND company_id = ${companyId}`);

    logAudit(req, "UPDATE", "square_payment_event", id,
      { resolution: ev.resolution }, { resolution: "applied", invoice_id: invoiceId, manual: true });

    res.json({ ok: true, invoice_id: invoiceId, payment_id: paymentId });
  } catch (err: any) {
    console.error("[square/payments apply]", err?.message ?? err);
    res.status(500).json({ error: "Failed to apply payment" });
  }
});

/** POST /api/square/payments/:id/ignore — not Qleno AR (a tip, a retail sale, a test). */
router.post("/payments/:id/ignore", ...officeOnly, async (req: any, res) => {
  try {
    const companyId = req.user.company_id;
    const id = Number(req.params.id);
    const ev = (await db.execute(sql`
      SELECT resolution FROM square_payment_events WHERE id = ${id} AND company_id = ${companyId}`) as any).rows[0];
    if (!ev) return res.status(404).json({ error: "Payment event not found" });
    // Ignoring an applied payment would leave a paid invoice with no visible
    // reason it was paid. Reverse the payment first if that's really the intent.
    if (ev.resolution === "applied") {
      return res.status(409).json({ error: "This payment is already applied to an invoice — reverse it there instead." });
    }
    await db.execute(sql`
      UPDATE square_payment_events SET resolution = 'ignored',
        review_reason = ${typeof req.body?.reason === "string" ? req.body.reason : null},
        reviewed_at = now(), reviewed_by_user_id = ${req.user.id}
      WHERE id = ${id} AND company_id = ${companyId}`);
    logAudit(req, "UPDATE", "square_payment_event", id, { resolution: ev.resolution }, { resolution: "ignored" });
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[square/payments ignore]", err?.message ?? err);
    res.status(500).json({ error: "Failed to ignore payment" });
  }
});

export default router;
