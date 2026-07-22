// [square-webhook 2026-07-22] Resolve a Square payment to a Qleno invoice.
//
// READ-ONLY AGAINST SQUARE. This module never charges a card, never creates a
// Square order, and never touches QuickBooks. Money already moved in Square;
// all this does is notice, and credit the matching Qleno invoice.
//
// THE CHAIN:
//   square_customer_id → square_customer_map (status='linked') → client/account
//   → that entity's OPEN invoices → match by amount → mark paid.
//
// WHERE IT REFUSES TO GUESS (all land in needs_review, nothing written):
//   - the Square customer isn't in the map, or is in it as needs_review /
//     unmatched. An unconfirmed identity must never move money in the books.
//   - no open invoice for that entity.
//   - no open invoice at that amount.
//   - MORE than one open invoice at that amount. This is the common real case
//     for National Able (five identical $420 visits in a week) and exactly the
//     situation where a guess would look right and be wrong. The office picks.
//
// Amount matching is done in integer CENTS. Square reports minor units; Qleno
// stores decimal strings. Comparing floats here would drop payments over
// rounding noise, so both sides are normalised to cents before comparison.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Square's minor-unit amount → cents. USD is 1/100; this stays explicit so a
// future non-USD tenant fails loudly rather than silently off by 100x.
export function squareAmountToCents(amountMoney: any): number {
  const n = Number(amountMoney?.amount ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function decimalToCents(v: string | number | null | undefined): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export type ReconcileResult = {
  resolution: "applied" | "needs_review" | "skipped";
  review_reason: string | null;
  client_id: number | null;
  account_id: number | null;
  matched_invoice_id: number | null;
  applied_payment_id: number | null;
  candidate_invoice_ids: number[];
  message: string | null;
};

const NONE = (resolution: ReconcileResult["resolution"], reason: string | null, message: string | null = null): ReconcileResult => ({
  resolution, review_reason: reason, client_id: null, account_id: null,
  matched_invoice_id: null, applied_payment_id: null, candidate_invoice_ids: [], message,
});

/**
 * Reconcile one COMPLETED Square payment. Writes at most: one `payments` row and
 * one invoice status flip, both inside a transaction. Everything else is a
 * read. Never throws — a failure resolves to needs_review so the payment stays
 * visible rather than disappearing into a log line.
 */
export async function reconcileSquarePayment(opts: {
  companyId: number;
  squarePaymentId: string;
  squareCustomerId: string | null;
  amountCents: number;
  squareStatus: string | null;
  dryRun?: boolean;
}): Promise<ReconcileResult> {
  const { companyId, squarePaymentId, squareCustomerId, amountCents, squareStatus, dryRun = false } = opts;

  try {
    // Only a settled payment is money. APPROVED/PENDING can still fail, and
    // crediting an invoice for one would show a customer as paid when they
    // aren't. Square fires payment.updated again on settlement, so nothing is
    // lost by waiting.
    if ((squareStatus || "").toUpperCase() !== "COMPLETED") {
      return NONE("skipped", "not_completed", `Square status is ${squareStatus ?? "unknown"} — not settled yet`);
    }
    if (amountCents <= 0) {
      return NONE("skipped", "not_completed", "Zero or negative amount (refund/void) — not a payment to apply");
    }
    if (!squareCustomerId) {
      return NONE("needs_review", "unmapped_customer", "Square payment carries no customer_id — cannot identify the payer");
    }

    // --- identity: only a CONFIRMED link is allowed to move money -----------
    const mapRow = (await db.execute(sql`
      SELECT client_id, account_id, status, square_customer_name, square_email
        FROM square_customer_map
       WHERE company_id = ${companyId} AND square_customer_id = ${squareCustomerId}
       LIMIT 1`) as any).rows[0];

    if (!mapRow) {
      return NONE("needs_review", "unmapped_customer",
        `Square customer ${squareCustomerId} is not in the customer map`);
    }
    if (mapRow.status !== "linked") {
      return NONE("needs_review", "customer_needs_review",
        `Square customer ${mapRow.square_customer_name ?? squareCustomerId} is '${mapRow.status}' in the map — confirm the link first`);
    }
    const clientId: number | null = mapRow.client_id ?? null;
    const accountId: number | null = mapRow.account_id ?? null;
    if (!clientId && !accountId) {
      return NONE("needs_review", "unmapped_customer",
        `Map row for ${squareCustomerId} is linked but points at neither a client nor an account`);
    }

    const withEntity = (r: ReconcileResult): ReconcileResult => ({ ...r, client_id: clientId, account_id: accountId });

    // --- the open invoices for that entity ----------------------------------
    // 'draft' counts as open: an account visit held for bundling is a real
    // receivable, and a customer paying it early is exactly the case that
    // should reconcile rather than sit in review. void/paid/superseded are out.
    const open = (await db.execute(sql`
      SELECT i.id, i.invoice_number, i.total, i.status::text AS status, i.due_date::text AS due_date
        FROM invoices i
       WHERE i.company_id = ${companyId}
         AND i.status IN ('draft', 'sent', 'overdue')
         AND (${accountId}::int IS NOT NULL AND i.account_id = ${accountId}::int
              OR ${clientId}::int IS NOT NULL AND i.client_id = ${clientId}::int)
       ORDER BY i.due_date ASC NULLS LAST, i.id ASC`) as any).rows as any[];

    if (!open.length) {
      return withEntity(NONE("needs_review", "no_open_invoice",
        `No open invoice for this customer — payment of $${(amountCents / 100).toFixed(2)} has nothing to apply to`));
    }

    const exact = open.filter(r => decimalToCents(r.total) === amountCents);

    if (exact.length === 0) {
      return { ...withEntity(NONE("needs_review", "no_amount_match",
        `$${(amountCents / 100).toFixed(2)} matches none of the ${open.length} open invoice(s)`)),
        candidate_invoice_ids: open.map(r => r.id) };
    }
    if (exact.length > 1) {
      // Deliberately NOT resolved by "oldest wins". Five identical $420 visits
      // is the normal shape of a commercial week; picking one would credit the
      // wrong visit and quietly corrupt which service dates are outstanding.
      return { ...withEntity(NONE("needs_review", "ambiguous_amount",
        `$${(amountCents / 100).toFixed(2)} matches ${exact.length} open invoices (#${exact.map(r => r.invoice_number ?? r.id).join(", #")}) — office picks`)),
        candidate_invoice_ids: exact.map(r => r.id) };
    }

    // --- exactly one match: apply -------------------------------------------
    const inv = exact[0];
    if (dryRun) {
      return { ...withEntity(NONE("applied", null, `Would mark invoice #${inv.invoice_number ?? inv.id} paid`)),
        matched_invoice_id: inv.id, candidate_invoice_ids: [inv.id] };
    }

    let paymentId: number | null = null;
    await db.transaction(async (tx) => {
      // Guard inside the transaction: a concurrent webhook retry or an office
      // Mark Paid between the read and the write must not double-credit.
      const stillOpen = (await tx.execute(sql`
        SELECT id FROM invoices
         WHERE id = ${inv.id} AND company_id = ${companyId}
           AND status IN ('draft','sent','overdue')
         FOR UPDATE`) as any).rows[0];
      if (!stillOpen) throw new Error("ALREADY_SETTLED");

      const ins = (await tx.execute(sql`
        INSERT INTO payments (company_id, client_id, invoice_id, amount, method, status, square_payment_id)
        VALUES (${companyId}, ${clientId}, ${inv.id}, ${(amountCents / 100).toFixed(2)},
                'square', 'completed', ${squarePaymentId})
        RETURNING id`) as any).rows[0];
      paymentId = ins?.id ?? null;

      await tx.execute(sql`
        UPDATE invoices SET status = 'paid', paid_at = now()
         WHERE id = ${inv.id} AND company_id = ${companyId}`);
    });

    return { ...withEntity(NONE("applied", null,
      `Invoice #${inv.invoice_number ?? inv.id} marked paid from Square payment ${squarePaymentId}`)),
      matched_invoice_id: inv.id, applied_payment_id: paymentId, candidate_invoice_ids: [inv.id] };
  } catch (err: any) {
    if (err?.message === "ALREADY_SETTLED") {
      return NONE("needs_review", "already_paid",
        "Invoice was settled by another path between match and write — no double credit applied");
    }
    console.error("[square-reconcile] non-fatal:", err?.message ?? err);
    return NONE("needs_review", null, `Reconcile failed: ${err?.message ?? "unknown error"}`);
  }
}
