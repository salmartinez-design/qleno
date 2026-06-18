// [invoicing-engine 2026-06-16] Single source of truth for auto-creating a
// job's invoice when the job transitions to `complete`. Called from EVERY
// completion path — the office modal (PATCH /api/jobs/:id) and the two field
// clock-out paths (timeclock last-tech clock-out, tech-clock field clock_out).
//
// Scope 1 (per-visit) + Scope 2 (batch tagging):
//   - billing_terms drives behavior, resolved from the client:
//       per_visit (default)  → invoice created and SENT immediately.
//       batch_invoice        → invoice created as DRAFT, batch_status='pending',
//                              NOT sent, NOT charged — the month-end consolidate
//                              step folds it into the month's first invoice.
//   - payment_source stamped from the client at creation (derive rule: a Stripe
//     payment method on file → 'stripe', else 'square'); an explicit check/ach
//     stamp on the client is preserved.
//   - Line items from the job's LOCKED pricing (never recomputed): scope line
//     (base_fee, or billed_amount/hourly for hourly jobs) + one line per
//     job_add_ons row (covers add-ons AND fee rules like parking) + each
//     job_discounts row as a negative line so the total nets out.
//   - invoice_number minted from the shared bare-integer sequence (6082+).
//
// Idempotency / guards:
//   - At most one invoice per job: if a non-void invoice already exists it is
//     returned untouched, never duplicated.
//   - Skip jobs already charged (jobs.charge_succeeded_at IS NOT NULL).
//   - Commercial accounts (account_id) keep the legacy guard: auto-invoice only
//     when invoice_frequency='per_job'. (The separate commercial-billing concern
//     is unchanged here.)
//
// Fully non-fatal: any hiccup is swallowed so it never breaks the job/clock write.
// QB push is fire-and-forget and only fires for invoices that are actually issued
// (per-visit 'sent'); batch 'pending' drafts do NOT push — only their
// consolidated parent does (Scope 2/5).
import { db } from "@workspace/db";
import { jobsTable, invoicesTable, accountsTable, companiesTable, clientsTable } from "@workspace/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { getNextInvoiceNumber } from "./invoice-number.js";
import { derivePaymentSource } from "./payment-source.js";
import { buildJobLineItems } from "./invoice-line-items.js";

// [cutover-guard 2026-06-17] Qleno go-live date. Jobs scheduled before this are
// billed in MaidCentral; the completion engine never auto-invoices them. Single
// hardcoded constant for Phes go-live; move to tenant_settings when multi-tenant
// cutovers arrive (mirrors the LATE_THRESHOLD_MINUTES pattern in job-status.ts).
const INVOICE_CUTOVER_DATE = "2026-07-01";

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
    // Idempotency: a job gets at most one live invoice. A pre-existing non-void
    // invoice is handed back so callers can surface it without duplicating. A
    // voided invoice does NOT block re-issue (office voided it deliberately).
    const existing = await db
      .select({ id: invoicesTable.id, status: invoicesTable.status, total: invoicesTable.total })
      .from(invoicesTable)
      .where(and(
        eq(invoicesTable.job_id, jobId),
        eq(invoicesTable.company_id, companyId),
        ne(invoicesTable.status, "void"),
      ))
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
        charge_succeeded_at: jobsTable.charge_succeeded_at,
        scheduled_date: jobsTable.scheduled_date,
      })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
      .limit(1);
    if (!job) return NO_OP;

    // [cutover-guard 2026-06-17] Pre-cutover jobs are billed in MaidCentral, NOT
    // Qleno. Never auto-invoice a job scheduled before the Qleno go-live date —
    // otherwise a stale June job closed out in Qleno after July 1 would double-bill
    // a customer already invoiced in MC. Scoped to the completion engine only;
    // the office can still manually invoice a pre-cutover job if it ever needs it.
    const sched = job.scheduled_date ? String(job.scheduled_date).slice(0, 10) : null;
    if (sched && sched < INVOICE_CUTOVER_DATE) return NO_OP;

    // Skip jobs already charged — money already moved, so an invoice would be a
    // duplicate AR artifact (spec §1 idempotency).
    if (job.charge_succeeded_at) return NO_OP;

    // Resolve terms + billing_terms + payment_source.
    let skipAutoInvoice = false;
    let termsDays = 0;
    let billingTerms: string = "per_visit";
    let paymentSource: string | null = null;

    if (job.account_id) {
      // Commercial account path — unchanged legacy behavior (per_job only).
      const [acct] = await db
        .select({ invoice_frequency: accountsTable.invoice_frequency, payment_terms_days: accountsTable.payment_terms_days })
        .from(accountsTable)
        .where(eq(accountsTable.id, job.account_id))
        .limit(1);
      if (acct) {
        termsDays = acct.payment_terms_days ?? 30;
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

    // Client-driven billing_terms + payment_source (residential / per-client).
    if (job.client_id) {
      const [cli] = await db
        .select({
          billing_terms: clientsTable.billing_terms,
          payment_source: clientsTable.payment_source,
          stripe_payment_method_id: clientsTable.stripe_payment_method_id,
          payment_terms: clientsTable.payment_terms,
        })
        .from(clientsTable)
        .where(eq(clientsTable.id, job.client_id))
        .limit(1);
      if (cli) {
        billingTerms = cli.billing_terms || "per_visit";
        // Stamp the processor: prefer an explicit client.payment_source (covers
        // office-set check/ach), else derive from card-on-file state.
        const explicit = (cli.payment_source || "").toLowerCase();
        paymentSource = (explicit === "stripe" || explicit === "square" || explicit === "check" || explicit === "ach")
          ? explicit
          : derivePaymentSource({ stripe_payment_method_id: cli.stripe_payment_method_id });
        // Honor per-client net terms when the company default is 0/unset.
        if (!termsDays && cli.payment_terms) {
          termsDays = cli.payment_terms === "net_30" ? 30 : cli.payment_terms === "net_15" ? 15 : 0;
        }
      }
    }

    if (skipAutoInvoice) return NO_OP;

    const isBatch = billingTerms === "batch_invoice";

    const today = new Date();
    const due = new Date(today);
    due.setDate(due.getDate() + termsDays);
    const dueDateStr = due.toISOString().split("T")[0];
    const termsLabel =
      termsDays === 30 ? "net_30" :
      termsDays === 15 ? "net_15" :
      termsDays === 7  ? "net_7"  : "due_on_receipt";

    // Build line items from the job's LOCKED pricing via the shared builder
    // (scope + ALL add-ons + ALL discounts) — same code the draft re-sync and
    // the office recalc use, so they can never diverge.
    const built = await buildJobLineItems(companyId, jobId);
    const lineItems = built?.lineItems ?? [];
    const netAmount = built?.subtotal ?? 0;

    const [newInv] = await db
      .insert(invoicesTable)
      .values({
        company_id: companyId,
        job_id: jobId,
        client_id: job.client_id ?? null,
        account_id: job.account_id ?? null,
        // per_visit issues immediately (sent); batch stays a pending draft.
        status: isBatch ? "draft" : "sent",
        batch_status: isBatch ? "pending" : null,
        sent_at: isBatch ? null : today,
        payment_source: paymentSource,
        line_items: lineItems,
        subtotal: netAmount.toFixed(2),
        total: netAmount.toFixed(2),
        due_date: dueDateStr,
        payment_terms: termsLabel,
        created_by: userId,
      })
      .returning({ id: invoicesTable.id, status: invoicesTable.status, total: invoicesTable.total });

    // Mint the canonical bare-integer invoice number (6082+ sequence).
    try {
      const invNum = await getNextInvoiceNumber(companyId, newInv.id);
      await db.update(invoicesTable).set({ invoice_number: invNum }).where(eq(invoicesTable.id, newInv.id));
    } catch (numErr) {
      console.error("[ensure-invoice] invoice-number assignment non-fatal:", numErr);
    }

    // Fire-and-forget QB push — ONLY for issued (per-visit) invoices. Batch
    // 'pending' drafts never push; their consolidated parent pushes later. No-op
    // for non-connected tenants. Accounting, not comms — ignores COMMS_ENABLED.
    if (!isBatch) {
      try {
        const { syncInvoice } = await import("../services/quickbooks-sync.js");
        syncInvoice(companyId, newInv.id).catch(qbErr => {
          console.error("[invoicing] QB invoice push error (non-fatal):", qbErr);
        });
      } catch (qbImportErr) {
        console.error("[invoicing] QB sync module load error (non-fatal):", qbImportErr);
      }
    }

    return { created: true, skipped: false, invoiceId: newInv.id, status: newInv.status, total: newInv.total, error: false };
  } catch (err) {
    console.error("[ensure-invoice] Auto-invoice error (non-fatal):", err);
    return { created: false, skipped: false, invoiceId: null, status: null, total: null, error: true };
  }
}
