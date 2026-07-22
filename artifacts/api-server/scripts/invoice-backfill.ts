// [cadence 2026-07-22] Backfill: no completed job left uninvoiced.
//
// Two passes, in order:
//   1. Every completed, billable, post-cutover job with NO live invoice gets one
//      through the SAME engine completion uses (ensureInvoiceForCompletedJob),
//      so pricing, terms and the per_job-vs-bundle decision are identical to a
//      job that completed today. Nothing is priced here.
//   2. Every bundled account's elapsed windows are closed (forced), folding the
//      drafts pass 1 just created — plus any that were already sitting there —
//      into one issued invoice per window.
//
// Usage:
//   tsx --env-file=.env artifacts/api-server/scripts/invoice-backfill.ts --company=1 --from=2026-07-01 --dry-run
//   tsx --env-file=.env artifacts/api-server/scripts/invoice-backfill.ts --company=1 --from=2026-07-01 --apply
//
// --dry-run (the default) writes NOTHING: it lists the jobs pass 1 would
// invoice and previews pass 2's windows.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ensureInvoiceForCompletedJob, INVOICE_CUTOVER_DATE } from "../src/lib/ensure-invoice.js";
import { closeAccountWindow, windowsBetween, bundleCadence } from "../src/lib/invoice-cadence.js";

const arg = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.split("=")[1];
const has = (k: string) => process.argv.includes(`--${k}`);

const companyId = Number(arg("company") ?? 1);
const from = arg("from") ?? INVOICE_CUTOVER_DATE;
const to = arg("to") ?? new Date().toISOString().slice(0, 10);
const dryRun = !has("apply");

async function main() {
  console.log(`\nInvoice backfill — company ${companyId} — ${from}..${to} — ${dryRun ? "DRY RUN (no writes)" : "APPLY"}\n`);

  // ---- Pass 1: completed jobs with no live invoice ------------------------
  const missing = await db.execute(sql`
    SELECT j.id, j.scheduled_date, j.account_id, a.account_name, a.invoice_frequency,
           COALESCE(j.billed_amount, j.base_fee, 0) AS amt
      FROM jobs j
      LEFT JOIN accounts a ON a.id = j.account_id
      LEFT JOIN invoices i ON i.job_id = j.id AND i.status <> 'void'
     WHERE j.company_id = ${companyId}
       AND j.status = 'complete'
       AND j.scheduled_date >= ${from} AND j.scheduled_date <= ${to}
       AND COALESCE(j.non_billable, false) = false
       AND j.charge_succeeded_at IS NULL
       AND i.id IS NULL
     ORDER BY j.scheduled_date, j.id`);
  const rows = (missing as any).rows as any[];

  console.log(`── Pass 1: completed jobs with NO invoice (${rows.length}) ──`);
  for (const r of rows) {
    console.log(`  job#${r.id}  ${String(r.scheduled_date).slice(0, 10)}  ${r.account_name ?? "(residential)"}  $${Number(r.amt).toFixed(2)}`);
  }

  let created = 0, issued = 0, drafted = 0, skipped = 0;
  if (!dryRun) {
    for (const r of rows) {
      const out = await ensureInvoiceForCompletedJob(companyId, r.id, null);
      if (out.created) {
        created++;
        if (out.status === "sent") issued++; else drafted++;
      } else skipped++;
    }
    console.log(`\n  created ${created} (issued ${issued}, held as draft ${drafted}), skipped ${skipped}`);
  }

  // ---- Pass 2: close every elapsed window for bundled accounts ------------
  // Forced, because the backfill is deliberately billing windows that closed in
  // the past. Idempotent per (account, window), so already-closed windows come
  // back 'already_closed' rather than double-billing.
  console.log(`\n── Pass 2: bundled-account windows ──`);
  const accts = await db.execute(sql`
    SELECT id, account_name, invoice_frequency FROM accounts
     WHERE company_id = ${companyId} AND is_active = true
       AND invoice_frequency IN ('weekly','monthly','custom') ORDER BY id`);

  // Walk EVERY elapsed window in the range, not just the latest — a weekly
  // account has one per week and each has to be closed on its own.
  for (const a of (accts as any).rows as any[]) {
    const cadence = bundleCadence(a.invoice_frequency);
    const wins = windowsBetween(cadence, from, to);
    console.log(`\n  acct#${a.id} ${a.account_name} — ${a.invoice_frequency} — ${wins.length} elapsed window(s)`);
    if (!wins.length) {
      console.log(`      (the current window has not closed yet — it bills on its close date)`);
    }
    for (const w of wins) {
      const r = await closeAccountWindow({
        companyId, accountId: a.id, cadence, window: w, dryRun,
        email: cadence === "weekly", userId: null,
      });
      const money = r.total ? ` $${r.total.toFixed(2)}` : "";
      const held = r.unpriced_invoice_ids.length ? `  [${r.unpriced_invoice_ids.length} unpriced held]` : "";
      const mail = r.emailed ? "  emailed" : r.email_reason ? `  email: ${r.email_reason}` : "";
      console.log(`      ${w.label.padEnd(16)} ${r.status.padEnd(15)} ${String(r.visit_count).padStart(2)} visit(s)${money}${held}${mail}`);
    }
  }

  // ---- What's left: the honest remainder ---------------------------------
  // $0 drafts can't be issued (issuing at $0 would hide an unset rate), so they
  // are reported as work for the office rather than quietly "handled".
  const stillDraft = await db.execute(sql`
    SELECT COALESCE(a.account_name, '(residential)') AS acct, count(*)::int AS n,
           round(sum(i.total)::numeric, 2) AS amt
      FROM invoices i
      LEFT JOIN accounts a ON a.id = i.account_id
      LEFT JOIN jobs j ON j.id = i.job_id
     WHERE i.company_id = ${companyId} AND i.status = 'draft'
       AND j.scheduled_date >= ${from} AND j.scheduled_date <= ${to}
     GROUP BY 1 ORDER BY n DESC`);
  console.log(`\n── Still DRAFT after backfill (needs a rate, not an invoice) ──`);
  const sd = (stillDraft as any).rows as any[];
  if (!sd.length) console.log("  (none)");
  for (const r of sd) console.log(`  ${String(r.acct).padEnd(34)} ${r.n} draft(s)  $${r.amt}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
