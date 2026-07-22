// [invoicing-engine 2026-06-16] Single source of truth for auto-creating a
// job's invoice when the job transitions to `complete`. Called from EVERY
// completion path — the office modal (PATCH /api/jobs/:id) and the two field
// clock-out paths (timeclock last-tech clock-out, tech-clock field clock_out).
//
// Scope 1 (per-visit) + Scope 2 (batch tagging):
//   - [auto-issue 2026-07-08; accounts 2026-07-21] When companies.
//     auto_issue_invoices is ON, completion ISSUES a real per-visit invoice
//     (status 'sent' with sent_at NULL → every surface labels it "ISSUED",
//     never "SENT"; NO email is ever sent — emailing/charging stays a human
//     action). This now covers residential AND commercial-account jobs alike
//     (Sal: "every account, every cleaning" — accounts used to be forced to
//     draft and hand-converted one by one). When the flag is OFF, everything
//     lands as a plain draft. billing_terms still routes the batch workflow:
//       per_visit (default)  → issued per visit (or draft if flag off).
//       batch_invoice        → draft with batch_status='pending' — the
//                              month-end consolidate step folds it into the
//                              month's first invoice.
//     A $0/unpriced ACCOUNT visit is held as a pending draft (never issued at
//     $0) so an unset rate stays visible.
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
//   - [edge-cases 2026-07-22] WORK DONE is the only billing trigger:
//       * status must be 'complete'. Scheduled/rescheduled never invoice — a
//         reschedule moves the visit, and the invoice follows it to the new
//         completion date. Re-completing an already-invoiced job is caught by
//         the idempotency check, so a move never doubles up.
//       * cancelled / called-off / no_show_marked_by_tech never invoice. A
//         cancellation FEE stays a deliberate office charge, never an automatic
//         by-product of the cancel.
//       * jobs.invoice_hold = office hold on this one visit (billable, but not
//         by the robot). Skipped, and stays in the "not yet invoiced" queue.
//       * accounts.auto_issue_enabled = false turns the whole account off.
//         Default true, so legacy rows keep working.
//       * a $0 commercial visit is an UNSET RATE — held as a pending draft,
//         never issued into AR at $0.
//     Everything skipped here remains visible in the "not yet invoiced" queue.
//     The office override is unchanged and total: edit, hold, void, or invoice
//     by hand at any point — auto-issue only ever acts on the untouched path.
//   - Commercial accounts (account_id) auto-issue per visit like residential
//     ONLY when accounts.invoice_frequency = 'per_job' (PPM, Weed Man, the
//     condo assocs). [cadence 2026-07-22] weekly/monthly/custom accounts hold
//     each visit as a pending draft instead — lib/invoice-cadence.ts bundles
//     the window into one invoice at period end (National Able weekly Mon–Fri,
//     Cucci/KMA/Daveco monthly). One invoice per job still holds either way;
//     bundling merges those per-visit documents, it never re-prices them.
//
// Fully non-fatal: any hiccup is swallowed so it never breaks the job/clock write.
// QB push is fire-and-forget and only fires for RESIDENTIAL invoices that are
// actually issued (per-visit 'sent'), still subject to quickbooks-sync's
// ar_invoices_only gating. ACCOUNT invoices never push from here (Sal: "no
// pushing"); batch 'pending' drafts do NOT push either.
import { db } from "@workspace/db";
import { jobsTable, invoicesTable, accountsTable, companiesTable, clientsTable } from "@workspace/db/schema";
import { eq, and, ne } from "drizzle-orm";
import { getNextInvoiceNumber } from "./invoice-number.js";
import { derivePaymentSource } from "./payment-source.js";
import { buildJobLineItems } from "./invoice-line-items.js";

// [cutover-guard 2026-06-17; billing-cutover 2026-07-02] Phes billing cutover.
// Everything scheduled BEFORE this date was invoiced + PAID in MaidCentral, so
// Qleno must never bill it: the completion engine never auto-invoices these, AND
// the "Not yet invoiced" queues (main Invoices screen + each account's Uninvoiced
// Jobs tab) hide them so pre-cutover work doesn't clutter the billing queue.
// Set to 2026-07-01 (Sal confirmed the switch-over; was 06-27, which risked
// double-billing June 27–30). Single hardcoded constant for Phes; move to
// tenant_settings when multi-tenant cutovers arrive (mirrors LATE_THRESHOLD_MINUTES).
export const INVOICE_CUTOVER_DATE = "2026-07-01";

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
        non_billable: jobsTable.non_billable,
        status: jobsTable.status,
        no_show_marked_by_tech: jobsTable.no_show_marked_by_tech,
        invoice_hold: jobsTable.invoice_hold,
      })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)))
      .limit(1);
    if (!job) return NO_OP;

    // [edge-cases 2026-07-22] WORK DONE is the only thing that bills.
    //
    // Completion is the trigger, full stop. A scheduled or rescheduled job never
    // invoices — a reschedule just moves the visit, and its invoice is created
    // (or re-dated) when the job actually completes at the new date. Because
    // completion is what fires this, moving a job that has ALREADY completed
    // does not spawn a second invoice either: the idempotency check above hands
    // back the existing one.
    //
    // Cancelled, called-off and no-show visits never invoice. Nobody cleaned, so
    // there is nothing to bill — and a cancellation FEE is a separate, deliberate
    // charge the office raises by hand, never an artifact of the cancel itself.
    // A no-show is the customer's accountability signal (per the job-status
    // model), not a billing event.
    if (job.status !== "complete") return NO_OP;
    if (job.no_show_marked_by_tech) return NO_OP;

    // [redo-service 2026-07-10] A redo/re-clean is free to the client under the
    // guarantee — never invoice it, not even a $0 draft on a commercial account.
    if (job.non_billable) return NO_OP;

    // [auto-issue-hold 2026-07-22] Office hold on this specific visit. The job
    // WILL be billed — just not by the robot. It stays in the "not yet invoiced"
    // queue until someone lifts the hold, which is the whole point: a disputed
    // or unresolved visit should be visible, not quietly invoiced.
    if (job.invoice_hold) return NO_OP;

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
    let termsDays = 0;
    let billingTerms: string = "per_visit";
    let paymentSource: string | null = null;
    // [auto-issue 2026-07-08] Per-company flag: completion ISSUES the per-visit
    // invoice instead of parking a draft.
    // [account-auto-issue 2026-07-21] Extended to commercial ACCOUNTS too (Sal:
    // "every account, every cleaning"). Account jobs used to be FORCED to draft
    // (the old `accountDraft`), so the office had to hand-convert every one
    // (Maribel: "the draft is there but I have to manually convert them"). Now
    // account jobs auto-issue a real per-visit invoice exactly like residential,
    // gated by the same company flag. Still NO email (sent_at stays null →
    // labeled "ISSUED", never emailed) and — per Sal — NO QuickBooks push for
    // account invoices (guarded on the QB block below). A $0/unpriced account
    // job still stays a pending draft (the "rate needs setting" signal).
    const [co] = await db
      .select({ payment_terms_days: companiesTable.payment_terms_days, auto_issue_invoices: companiesTable.auto_issue_invoices })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);
    const autoIssue = co?.auto_issue_invoices === true;

    // [cadence 2026-07-22] An account's invoice_frequency decides WHETHER this
    // visit becomes its own document. per_job issues immediately (#1174).
    // weekly/monthly hold the visit as a pending draft so the period-close step
    // (lib/invoice-cadence.ts) can bundle the window into ONE invoice — Sal:
    // National Able bundles Mon–Fri, Cucci/KMA/Daveco bundle the month.
    let accountCadence: string | null = null;
    if (job.account_id) {
      const [acct] = await db
        .select({
          payment_terms_days: accountsTable.payment_terms_days,
          invoice_frequency: accountsTable.invoice_frequency,
          auto_issue_enabled: accountsTable.auto_issue_enabled,
        })
        .from(accountsTable)
        .where(eq(accountsTable.id, job.account_id))
        .limit(1);
      termsDays = acct?.payment_terms_days ?? 30;
      accountCadence = acct?.invoice_frequency ?? "per_job";
      // [auto-issue-toggle 2026-07-22] Account-level opt-out. Default is ON, so
      // a missing/legacy row still auto-invoices; only an explicit false stops
      // it. Nothing is created at all — the completed job simply stays in the
      // "not yet invoiced" queue for the office.
      if (acct?.auto_issue_enabled === false) return NO_OP;
    } else {
      termsDays = co?.payment_terms_days ?? 0;
    }

    // Client-driven billing_terms + payment_source (residential / per-client).
    let clientType: string | null = null;
    if (job.client_id) {
      const [cli] = await db
        .select({
          billing_terms: clientsTable.billing_terms,
          payment_source: clientsTable.payment_source,
          stripe_payment_method_id: clientsTable.stripe_payment_method_id,
          payment_terms: clientsTable.payment_terms,
          client_type: clientsTable.client_type,
        })
        .from(clientsTable)
        .where(eq(clientsTable.id, job.client_id))
        .limit(1);
      if (cli) {
        clientType = cli.client_type ?? null;
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

    // Residential batch_invoice clients accumulate as pending drafts for a
    // month-end consolidation/merge. Account jobs are NO LONGER forced here —
    // they auto-issue per visit like residential (see [account-auto-issue]).
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

    // [invoice-zero-guard 2026-06-20; commercial-exception 2026-07-03] Skip $0
    // auto-invoices for RESIDENTIAL jobs — a cancelled/credited occurrence would
    // otherwise spawn a $0 draft that clutters AR. But COMMERCIAL jobs (account
    // like KMA/PPM, or a commercial client) MUST get an invoice even at $0: the
    // office reconciles the day one-invoice-per-job, and a $0 draft is the signal
    // that a rate still needs setting on that common-areas/turnover visit.
    const isCommercialJob = !!job.account_id || clientType === "commercial";
    if (netAmount <= 0 && !isCommercialJob) return NO_OP;

    // [account-auto-issue 2026-07-21] Issue a REAL invoice now when the company
    // flag is on, it's not a batch_invoice client, and the visit is priced.
    // Applies to residential AND account jobs alike. A $0 commercial visit
    // (allowed through the guard above so an unpriced job stays visible) is held
    // as a pending draft — never issued into AR at $0.
    // [cadence 2026-07-22] A bundled account (weekly/monthly) never issues its
    // own per-visit document — the visit is held as a pending draft and the
    // period close folds the window into one invoice. 'custom' is treated as
    // monthly (the only custom cadence in use is a month-end bundle); per_job
    // and residential are unaffected.
    const isBundledAccount = !!job.account_id && (accountCadence === "weekly" || accountCadence === "monthly" || accountCadence === "custom");
    const issueNow = !isBatch && !isBundledAccount && autoIssue && netAmount > 0;

    const [newInv] = await db
      .insert(invoicesTable)
      .values({
        company_id: companyId,
        job_id: jobId,
        client_id: job.client_id ?? null,
        account_id: job.account_id ?? null,
        // [auto-issue 2026-07-08] Third iteration of this lifecycle, keep the
        // history straight:
        //   1. [invoice-lifecycle 2026-06-21] completion finalized as 'sent'
        //      — but the UI showed "Sent: <completion time>", which read as
        //      "the customer was emailed" when nothing was ever emailed.
        //   2. [no-auto-issue 2026-07-06] everything became a DRAFT to kill
        //      that lie — but then drafts piled up and the office had to
        //      hand-finalize every completed job (Sal: "we should not have
        //      to manually create all these invoices", HCP parity).
        //   3. Now: when companies.auto_issue_invoices is ON, a per-visit
        //      completion invoice is ISSUED (status 'sent', enters AR, QB
        //      push below) with sent_at NULL — and every surface labels
        //      sent-with-no-sent_at as "ISSUED", never "SENT", so both
        //      complaints stay fixed. Emailing/charging remains a human
        //      action. batch_invoice clients + account jobs keep the
        //      draft+pending tag for month-end consolidation/merge.
        status: issueNow ? "sent" : "draft",
        // Drafts held for consolidation/merge stay 'pending': residential
        // batch_invoice clients and any account job that didn't issue (e.g. a
        // $0 unpriced visit awaiting a rate).
        batch_status: !issueNow && (isBatch || !!job.account_id) ? "pending" : null,
        sent_at: null,
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

    // [auto-issue 2026-07-08] An ISSUED invoice enters the books immediately,
    // so push it to QuickBooks now (idempotent — syncInvoice finds-by-
    // DocNumber before create, #881). Drafts still never push; their push
    // happens when the office finalizes (Mark as invoiced / Send / mark-paid).
    // [account-auto-issue 2026-07-21] ACCOUNT invoices never push from here —
    // Sal's directive is "no pushing" for the auto-issued account flow (they
    // now auto-issue for AR inside Qleno only). Residential is unchanged and
    // still routes through quickbooks-sync's own ar_invoices_only gating.
    if (issueNow && !job.account_id) {
      import("../services/quickbooks-sync.js").then(({ syncInvoice }) => {
        syncInvoice(companyId, newInv.id).catch((e: any) => console.error("[ensure-invoice] QB push non-fatal:", e));
      }).catch((e) => console.error("[ensure-invoice] QB module load non-fatal:", e));
    }

    return { created: true, skipped: false, invoiceId: newInv.id, status: newInv.status, total: newInv.total, error: false };
  } catch (err) {
    console.error("[ensure-invoice] Auto-invoice error (non-fatal):", err);
    return { created: false, skipped: false, invoiceId: null, status: null, total: null, error: true };
  }
}
