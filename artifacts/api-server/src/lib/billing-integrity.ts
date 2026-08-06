// [batch-invoicing 2026-08-03] Billing integrity check — design §5 S-3.
//
// The July KMA failure was silent. Nothing in the system said "seven documents
// exist for this account, they don't sum to what you billed, and two of them
// cover the same visit." The office found out when the customer asked, and
// Maribel found out when the invoices "disapeared."
//
// So the third leg of making the fix stick is a report that runs on its own and
// says what's wrong before anyone has to ask. It is READ-ONLY by design: it
// never repairs, never voids, never bills. It reports, and a person decides.
// Automatic repair is how a one-visit discrepancy becomes a month of quiet
// double-billing.
//
// Four checks, each mapping to a defect that actually happened:
//   uncovered_visits   — completed, billable, priced work with no live invoice.
//                        The one that costs money directly. Priced by EITHER
//                        billed_amount or base_fee — see the note below.
//   contested_visits   — one visit claimed by two live invoices. Should be
//                        IMPOSSIBLE once the partial unique index is in place;
//                        if this is ever non-empty the index is missing.
//   unpriced_visits    — completed work that BILLS $0.00 (its invoice totals
//                        zero, or it has no invoice and no price), which reads
//                        as "handled" on every screen while earning nothing (D8)
//   stale_windows      — a bundled account whose billing window closed and was
//                        never invoiced
// [integrity-signal 2026-08-06] Checks 1 and 3 both asked whether
// `jobs.billed_amount` was zero. It is NOT the price — lib/job-billed.ts
// (computeJobBilledGross, the resolver the dispatch board and the invoice both
// use) treats it as an OPTIONAL OVERRIDE and falls back to base_fee + mods.
// Most jobs leave it NULL. So the two checks were wrong in opposite
// directions, and the expensive one was the quiet one:
//
//   check 3 (unpriced)  reported every fully-priced job as $0 — 230 phantoms
//                       on 2026-08-06, so the report said ok:false every night
//                       and became the console warning nobody reads that D-8
//                       and S-3 exist to prevent;
//   check 1 (uncovered) gated on `billed_amount > 0`, so a visit priced only in
//                       base_fee was INVISIBLE to the one check whose whole job
//                       is finding work we did and never billed. Verified live:
//                       jobs 15630 and 15631 (Jennifer Halper, Jul 13 + Jul 20,
//                       $210 each) had no invoice and did not appear.
//
// Both now read the invoice — the document that actually bills — and fall back
// to the same base_fee the resolver does.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { cutoverDate } from "./billing-cutover.js";

/**
 * A visit's price, for REPORTING. Mirrors computeJobBilledGross's residential
 * fallback (`billed_amount` when set, else `base_fee`) in SQL.
 *
 * Deliberately an approximation: the real resolver also folds in mods, add-ons,
 * discounts, and a commercial rate×hours branch, none of which belong in a
 * monitoring query. It only ever decides "is this zero or not," and both inputs
 * being zero is the signal we want either way.
 */
const effectivePrice = sql`COALESCE(NULLIF(j.billed_amount, 0), j.base_fee, 0)`;

/**
 * [cancel-fee-blindspot 2026-08-06] This visit's money already came in as a
 * CANCELLATION or LOCKOUT FEE, so there is nothing left to invoice.
 *
 * A charged cancellation deliberately lives as `jobs.status = 'complete'` — see
 * the note in routes/reports.ts: "charged cancellations live as
 * status='complete'". The fee is recorded in cancellation_log, NOT as an
 * invoice, and the job keeps its full base_fee. To every check that reasons
 * from jobs + invoices alone, that is indistinguishable from "we cleaned a
 * house for $1,000 and never billed it."
 *
 * Verified on production 2026-08-06: of 11 uncovered_visits, THREE were
 * collected fees — Arlin Uddberg job 20293 ($1,000 cancellation, Jul 31), PPM
 * job 20280 ($150 lockout), and job 8589 ($200 lockout). $1,350 of a $2,775.82
 * "unbilled" total was money already in the bank. The Fees Collected report had
 * it right the whole time; this sweep was reading the wrong ledger.
 */
const feeAlreadyCollected = sql`EXISTS (
  SELECT 1 FROM cancellation_log cl
   WHERE cl.company_id = j.company_id
     AND cl.job_id = j.id
     AND cl.cancel_action IN ('cancel', 'lockout')
     AND COALESCE(cl.customer_charge_amount, 0) > 0)`;

/** The live invoice covering this visit, if any. NULL when nothing covers it. */
const liveInvoiceTotal = sql`(
  SELECT i.total
    FROM invoice_job_links l
    JOIN invoices i ON i.id = l.invoice_id
   WHERE l.company_id = j.company_id AND l.job_id = j.id AND l.is_live
   LIMIT 1)`;

export type IntegrityFinding = {
  job_id: number;
  scheduled_date: string | null;
  customer: string | null;
  amount: string | null;
  detail?: string | null;
};

export type BillingIntegrityReport = {
  company_id: number;
  as_of: string;
  ok: boolean;
  uncovered_visits: IntegrityFinding[];
  uncovered_total: number;
  contested_visits: IntegrityFinding[];
  unpriced_visits: IntegrityFinding[];
  stale_windows: { account_id: number; account_name: string | null; window_end: string; cadence: string | null }[];
};

// Nothing before the cutover is in scope — pre-cutover money lived in the
// system the tenant migrated from and is not Qleno's to reconcile.
// [tenant-billing 2026-08-05] This was a SECOND hardcoded copy of Phes's
// 2026-07-01, independent of the one in ensure-invoice: two constants that had
// to be edited together and nothing saying so. Both are now
// companies.invoice_cutover_date.

export async function runBillingIntegrityCheck(
  companyId: number,
  asOf?: string,
): Promise<BillingIntegrityReport> {
  const today = asOf || new Date().toISOString().slice(0, 10);

  // 1. Completed billable visits with no live billing document. This is the
  //    "we did the work and never billed it" number — the one that costs money
  //    directly rather than just looking wrong.
  const uncovered = (await db.execute(sql`
    SELECT j.id AS job_id,
           j.scheduled_date::text AS scheduled_date,
           COALESCE(a.account_name, concat(c.first_name, ' ', c.last_name)) AS customer,
           ${effectivePrice}::text AS amount
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
     WHERE j.company_id = ${companyId}
       AND j.status = 'complete'
       AND j.scheduled_date >= ${cutoverDate(companyId)}
       AND j.scheduled_date <= ${today}::date
       AND COALESCE(j.non_billable, FALSE) = FALSE
       -- Priced by EITHER carrier. The old billed_amount > 0 test hid every
       -- visit priced only in base_fee, which is most of them. A $0 visit is a
       -- real problem too, it just belongs in unpriced_visits rather than here.
       AND ${effectivePrice} > 0
       AND NOT EXISTS (
         SELECT 1 FROM invoice_job_links l
          WHERE l.company_id = j.company_id AND l.job_id = j.id AND l.is_live)
       AND NOT ${feeAlreadyCollected}
     ORDER BY j.scheduled_date DESC`) as any).rows as IntegrityFinding[];

  // 2. Two live invoices for one visit. The partial unique index
  //    invoice_job_links_one_live_per_job makes this a constraint violation at
  //    write time, so a non-empty result here means the index did not get
  //    created — which is a deploy problem, not a data problem. Report it
  //    loudly rather than assuming the guarantee holds.
  const contested = (await db.execute(sql`
    SELECT l.job_id,
           j.scheduled_date::text AS scheduled_date,
           COALESCE(a.account_name, concat(c.first_name, ' ', c.last_name)) AS customer,
           NULL::text AS amount,
           string_agg(l.invoice_id::text, ', ' ORDER BY l.invoice_id) AS detail
      FROM invoice_job_links l
      JOIN jobs j ON j.id = l.job_id
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
     WHERE l.company_id = ${companyId} AND l.is_live
     GROUP BY l.job_id, j.scheduled_date, a.account_name, c.first_name, c.last_name
    HAVING COUNT(*) > 1`) as any).rows as IntegrityFinding[];

  // 3. Completed billable work that bills $0.00 — an unset rate. It produces a
  //    zero-dollar document that reads as "handled" on every screen while
  //    earning nothing (D-8).
  //
  //    "Bills $0" means the INVOICE covering it totals zero, which is the same
  //    definition lib/invoice-cadence.ts already uses to refuse to fold a visit
  //    into a bundle (`held_unpriced`). When nothing covers the visit yet, fall
  //    back to its own price. Reading jobs.billed_amount instead is what
  //    produced 230 false positives against production on 2026-08-06 — every
  //    one of the five sampled had a correct non-zero invoice.
  const unpriced = (await db.execute(sql`
    SELECT j.id AS job_id,
           j.scheduled_date::text AS scheduled_date,
           COALESCE(a.account_name, concat(c.first_name, ' ', c.last_name)) AS customer,
           '0.00'::text AS amount,
           CASE WHEN ${liveInvoiceTotal} IS NOT NULL
                THEN 'invoice totals $0' ELSE 'no rate set, not yet invoiced' END AS detail
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
     WHERE j.company_id = ${companyId}
       AND j.status = 'complete'
       AND j.scheduled_date >= ${cutoverDate(companyId)}
       AND j.scheduled_date <= ${today}::date
       AND COALESCE(j.non_billable, FALSE) = FALSE
       AND COALESCE(${liveInvoiceTotal}, ${effectivePrice}) = 0
       -- A cancelled visit that was charged a fee is not an unset rate.
       AND NOT ${feeAlreadyCollected}
     ORDER BY j.scheduled_date DESC`) as any).rows as IntegrityFinding[];

  // 4. Bundled accounts whose window has closed with work still sitting
  //    uninvoiced. D4 was exactly this: one blocked window stayed blocked
  //    forever and nobody was told.
  const stale = (await db.execute(sql`
    SELECT a.id AS account_id, a.account_name,
           MAX(j.scheduled_date)::text AS window_end,
           a.invoice_frequency::text AS cadence
      FROM accounts a
      JOIN jobs j ON j.account_id = a.id AND j.company_id = a.company_id
     WHERE a.company_id = ${companyId}
       AND a.invoice_frequency IN ('weekly', 'monthly', 'custom')
       AND j.status = 'complete'
       AND j.scheduled_date >= ${cutoverDate(companyId)}
       AND j.scheduled_date < date_trunc('month', ${today}::date)
       AND COALESCE(j.non_billable, FALSE) = FALSE
       AND NOT EXISTS (
         SELECT 1 FROM invoice_job_links l
          WHERE l.company_id = j.company_id AND l.job_id = j.id AND l.is_live)
     GROUP BY a.id, a.account_name, a.invoice_frequency
     ORDER BY a.account_name`) as any).rows as BillingIntegrityReport["stale_windows"];

  const uncoveredTotal = Math.round(
    uncovered.reduce((s, r) => s + parseFloat(r.amount || "0"), 0) * 100,
  ) / 100;

  return {
    company_id: companyId,
    as_of: today,
    ok: !uncovered.length && !contested.length && !unpriced.length && !stale.length,
    uncovered_visits: uncovered,
    uncovered_total: uncoveredTotal,
    contested_visits: contested,
    unpriced_visits: unpriced,
    stale_windows: stale,
  };
}

/**
 * Cron entry point — runs the check for every tenant and logs a one-line
 * summary per tenant that has something wrong. Silent when everything is
 * clean, so a noisy log means real work is waiting.
 */
export async function runBillingIntegrityCron(asOf?: string): Promise<{
  companies: number;
  flagged: number;
  reports: BillingIntegrityReport[];
}> {
  const companies = (await db.execute(sql`SELECT id FROM companies ORDER BY id`) as any).rows as { id: number }[];
  const reports: BillingIntegrityReport[] = [];
  let flagged = 0;

  for (const c of companies) {
    try {
      const report = await runBillingIntegrityCheck(Number(c.id), asOf);
      reports.push(report);
      if (report.ok) continue;
      flagged++;
      console.warn(
        `[billing-integrity] company ${c.id}: ` +
        `${report.uncovered_visits.length} uninvoiced ($${report.uncovered_total.toFixed(2)}), ` +
        `${report.contested_visits.length} double-billed, ` +
        `${report.unpriced_visits.length} unpriced, ` +
        `${report.stale_windows.length} stale window(s)`,
      );
      if (report.contested_visits.length) {
        // This should be structurally impossible. If it fires, the unique index
        // is missing and double-billing is live again.
        console.error(
          `[billing-integrity] company ${c.id}: DOUBLE-BILLED VISITS — ` +
          `the one-live-invoice-per-job index may not exist. Jobs: ` +
          report.contested_visits.map((v) => `${v.job_id} (invoices ${v.detail})`).join("; "),
        );
      }
    } catch (err) {
      // One tenant's failure must not stop the sweep.
      console.error(`[billing-integrity] company ${c.id} check failed:`, err);
    }
  }

  return { companies: companies.length, flagged, reports };
}
