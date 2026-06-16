// [invoice-on-completion 2026-06-16] Single source of truth for auto-creating a
// job's DRAFT invoice when the job transitions to `complete`. Extracted from the
// inline block that used to live only in PATCH /api/jobs/:id so that EVERY
// completion path generates an invoice — the office modal (PATCH) AND the two
// field/tech clock-out paths (timeclock last-tech clock-out, tech-clock field
// clock_out) that previously flipped status='complete' without ever invoicing.
//
// Behavior preserved verbatim from the old inline block:
//   - Idempotent: if an invoice already exists for (job_id, company_id) it is
//     returned untouched, never duplicated.
//   - Residential (no account_id): always auto-creates a draft.
//   - Commercial (account_id): only auto-creates when invoice_frequency is
//     'per_job'; weekly/monthly are deliberately skipped (batched elsewhere).
//   - Discounts itemized as negative line items so the total nets out.
//   - Fire-and-forget QuickBooks push (no-op for non-connected tenants;
//     accounting, not outbound comms — does not respect COMMS_ENABLED).
//   - Fully non-fatal: any hiccup is swallowed so it can never break the
//     underlying job/clock write.
import { db } from "@workspace/db";
import { jobsTable, invoicesTable, accountsTable, companiesTable, jobDiscountsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

export type EnsureInvoiceResult = {
  created: boolean;
  skipped: boolean;
  invoiceId: number | null;
  status: string | null;
  total: string | null;
  error: boolean;
};

const NO_OP: EnsureInvoiceResult = {
  created: false, skipped: true, invoiceId: null, status: null, total: null, error: false,
};

export async function ensureInvoiceForCompletedJob(
  companyId: number,
  jobId: number,
  userId: number | null,
): Promise<EnsureInvoiceResult> {
  try {
    // Idempotency: a job gets at most one invoice. If one already exists, hand
    // it back so callers can surface it without creating a duplicate.
    const existing = await db
      .select({ id: invoicesTable.id, status: invoicesTable.status, total: invoicesTable.total })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.job_id, jobId), eq(invoicesTable.company_id, companyId)))
      .limit(1);
    if (existing[0]) {
      return { created: false, skipped: false, invoiceId: existing[0].id, status: existing[0].status, total: existing[0].total, error: false };
    }

    const [job] = await db
      .select({
        account_id: jobsTable.account_id,
        client_id: jobsTable.client_id,
        service_type: jobsTable.service_type,
        base_fee: jobsTable.base_fee,
        billed_amount: jobsTable.billed_amount,
        billed_hours: jobsTable.billed_hours,
        hourly_rate: jobsTable.hourly_rate,
      })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
      .limit(1);
    if (!job) return NO_OP;

    // Resolve payment terms + whether this job should auto-invoice at all.
    let skipAutoInvoice = false;
    let termsDays = 0;
    if (job.account_id) {
      const [acct] = await db
        .select({ invoice_frequency: accountsTable.invoice_frequency, payment_terms_days: accountsTable.payment_terms_days })
        .from(accountsTable)
        .where(eq(accountsTable.id, job.account_id))
        .limit(1);
      if (acct) {
        termsDays = acct.payment_terms_days ?? 30;
        // Only auto-invoice on per_job; weekly/monthly get batched via consolidate endpoint
        if (acct.invoice_frequency !== "per_job") {
          skipAutoInvoice = true;
        }
      }
    } else {
      const [co] = await db
        .select({ payment_terms_days: companiesTable.payment_terms_days })
        .from(companiesTable)
        .where(eq(companiesTable.id, companyId))
        .limit(1);
      termsDays = co?.payment_terms_days ?? 0;
    }

    if (skipAutoInvoice) return NO_OP;

    const today = new Date();
    const due = new Date(today);
    due.setDate(due.getDate() + termsDays);
    const dueDateStr = due.toISOString().split("T")[0];

    const termsLabel =
      termsDays === 30 ? "net_30" :
      termsDays === 15 ? "net_15" :
      termsDays === 7  ? "net_7"  : "due_on_receipt";

    // Use billed_amount for hourly jobs; otherwise base_fee.
    const amount = job.billed_amount
      ? parseFloat(String(job.billed_amount))
      : parseFloat(String(job.base_fee ?? "0"));
    const svcLabel = (job.service_type ?? "Cleaning Service")
      .split("_").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const qty = job.billed_hours ? parseFloat(String(job.billed_hours)) : 1;
    const unitPrice = job.hourly_rate ? parseFloat(String(job.hourly_rate)) : amount;

    const lineItems: any[] = [{ description: svcLabel, quantity: qty, unit_price: unitPrice, total: amount }];

    // Itemize any discounts applied to this job as negative lines so the
    // invoice total nets them out (matches the live draft-sync helper).
    const jobDisc = await db.select().from(jobDiscountsTable)
      .where(and(eq(jobDiscountsTable.job_id, jobId), eq(jobDiscountsTable.company_id, companyId)));
    let discTotal = 0;
    for (const d of jobDisc) {
      const amt = parseFloat(String(d.amount));
      discTotal += amt;
      const label = `Discount${d.code ? ` ${d.code}` : (d.type === "percent" ? ` ${parseFloat(String(d.value))}%` : "")}${d.reason && d.reason !== d.code ? ` — ${d.reason}` : ""}`;
      lineItems.push({ description: label, quantity: 1, unit_price: -amt, total: -amt });
    }
    const netAmount = Math.max(0, Math.round((amount - discTotal) * 100) / 100);

    const [newInv] = await db
      .insert(invoicesTable)
      .values({
        company_id: companyId,
        job_id: jobId,
        client_id: job.client_id ?? null,
        account_id: job.account_id ?? null,
        status: "draft",
        line_items: lineItems,
        subtotal: netAmount.toFixed(2),
        total: netAmount.toFixed(2),
        due_date: dueDateStr,
        payment_terms: termsLabel,
        created_by: userId,
      })
      .returning({ id: invoicesTable.id, status: invoicesTable.status, total: invoicesTable.total });

    // [AF] Fire-and-forget QB invoice push. Enqueue regardless of whether this
    // tenant is QB-connected — the cron drain (syncAll) checks getValidToken()
    // and no-ops cleanly for tenants without a connection, so queueing is always
    // safe. Does NOT respect COMMS_ENABLED: QB push is accounting, not comms.
    try {
      const { syncInvoice } = await import("../services/quickbooks-sync.js");
      syncInvoice(companyId, newInv.id).catch(qbErr => {
        console.error("[AF] QB invoice push error (non-fatal):", qbErr);
      });
    } catch (qbImportErr) {
      console.error("[AF] QB sync module load error (non-fatal):", qbImportErr);
    }

    return { created: true, skipped: false, invoiceId: newInv.id, status: newInv.status, total: newInv.total, error: false };
  } catch (err) {
    console.error("[ensure-invoice] Auto-invoice error (non-fatal):", err);
    return { created: false, skipped: false, invoiceId: null, status: null, total: null, error: true };
  }
}
