/**
 * [auto-issue killed the revert 2026-08-12] Find and heal the jobs that are
 * still ticked Complete with every clock punch deleted.
 *
 * The forward fix stops NEW ones. This is for the backlog Maribel has been
 * re-reporting — jobs where she deleted a mistaken clock, the auto-revert
 * refused because completion had auto-ISSUED an invoice (status 'sent',
 * sent_at NULL, never emailed), and the checkmark stayed.
 *
 * The startup heal deliberately still uses the ORIGINAL tight predicate, so it
 * will not touch these unattended at boot. That is on purpose: quietly
 * reverting a batch of jobs and voiding their invoices during a deploy is not
 * something that should happen without a person watching. Hence this script.
 *
 * What qualifies — the same rules as the forward revert:
 *   status = 'complete'
 *   completed_by_user_id IS NOT NULL   (a clock-out or office completion)
 *   locked_at IS NULL                  (not an office Mark Complete / charged cancel)
 *   charge_succeeded_at IS NULL        (never charged)
 *   zero timeclock rows                (no clock evidence of any kind remains)
 *   no invoice that LEFT THE BUILDING  (nothing emailed, paid, or in real AR)
 *
 * Applying reverts each job to 'scheduled', clears the completion stamps, voids
 * the unsent invoice, and writes a status-change audit row that shows in the
 * client's Activity feed. Nothing is deleted.
 *
 * DRY RUN BY DEFAULT.
 *   pnpm tsx scripts/ah_ghost_completion_audit.ts           # preview
 *   pnpm tsx scripts/ah_ghost_completion_audit.ts --apply   # heal
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logJobStatusChange } from "../src/lib/audit.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(`=== ghost completions — ${APPLY ? "APPLY" : "DRY RUN"} ===\n`);

  const rows = (await db.execute(sql`
    SELECT j.id, j.company_id, j.scheduled_date::text AS scheduled_date, j.status,
           CASE WHEN j.account_id IS NOT NULL THEN a.account_name
                ELSE NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') END AS client_name,
           NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS assigned_to,
           (SELECT count(*)::int FROM invoices inv
             WHERE inv.job_id = j.id AND inv.status IN ('draft','sent')
               AND inv.sent_at IS NULL AND inv.paid_at IS NULL) AS unsent_invoices
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
      LEFT JOIN users u ON u.id = j.assigned_user_id
     WHERE j.status = 'complete'
       AND j.completed_by_user_id IS NOT NULL
       AND j.locked_at IS NULL
       AND j.charge_succeeded_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM timeclock tc WHERE tc.job_id = j.id)
       AND NOT EXISTS (
         SELECT 1 FROM invoices inv
          WHERE inv.job_id = j.id
            AND (inv.status IN ('paid','overdue') OR inv.sent_at IS NOT NULL OR inv.paid_at IS NOT NULL))
     ORDER BY j.scheduled_date DESC, j.id
     LIMIT 500`) as any).rows;

  if (!rows.length) {
    console.log("No stuck completions found. Nothing to do.");
    return;
  }

  console.table(rows.map((r: any) => ({
    job: r.id,
    date: r.scheduled_date,
    client: r.client_name ?? "—",
    tech: r.assigned_to ?? "—",
    unsent_invoices: r.unsent_invoices,
  })));
  console.log(`\n${rows.length} job(s) would be reverted to Scheduled.`);
  console.log(`${rows.reduce((n: number, r: any) => n + Number(r.unsent_invoices || 0), 0)} unsent invoice(s) would be voided.`);

  // The other side of the ledger — what is deliberately being left alone, so
  // the preview shows both halves rather than implying this is everything.
  const held = (await db.execute(sql`
    SELECT count(*)::int AS n FROM jobs j
     WHERE j.status = 'complete' AND j.completed_by_user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM timeclock tc WHERE tc.job_id = j.id)
       AND (j.locked_at IS NOT NULL OR j.charge_succeeded_at IS NOT NULL
            OR EXISTS (SELECT 1 FROM invoices inv WHERE inv.job_id = j.id
                        AND (inv.status IN ('paid','overdue') OR inv.sent_at IS NOT NULL OR inv.paid_at IS NOT NULL)))`) as any).rows[0];
  console.log(`Left alone: ${held.n} clock-less completion(s) that are locked, charged, emailed or paid — those need a human decision, not a sweep.`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to heal.");
    return;
  }

  let healed = 0;
  for (const r of rows) {
    const jobId = Number(r.id);
    const companyId = Number(r.company_id);
    // Re-check inside the UPDATE so a punch added since the SELECT makes this a
    // no-op rather than a wrong revert.
    const upd = await db.execute(sql`
      UPDATE jobs AS j SET status = 'scheduled', completed_by_user_id = NULL, actual_end_time = NULL
       WHERE j.id = ${jobId} AND j.company_id = ${companyId}
         AND j.status = 'complete' AND j.completed_by_user_id IS NOT NULL
         AND j.locked_at IS NULL AND j.charge_succeeded_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM timeclock tc WHERE tc.job_id = j.id)
       RETURNING j.id`);
    if (!upd.rows[0]) continue;

    const voided = await db.execute(sql`
      UPDATE invoices SET status = 'void'
       WHERE job_id = ${jobId} AND company_id = ${companyId}
         AND status IN ('draft','sent') AND sent_at IS NULL AND paid_at IS NULL
      RETURNING id`);

    await logJobStatusChange({
      companyId, jobId, actorUserId: null, actorName: "Qleno",
      priorStatus: "complete", newStatus: "scheduled", source: "ghost-heal",
      note: `Reverted out of Complete — no clock evidence remains${voided.rows.length ? `, ${voided.rows.length} unsent invoice(s) voided` : ""}`,
    });
    healed++;
  }
  console.log(`\nHealed ${healed} job(s).`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
