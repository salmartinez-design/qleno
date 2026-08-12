/**
 * [unexcused back to 3/4/5 2026-08-12] Dismiss the disciplinary records the
 * restored ladder would never have issued.
 *
 * The unexcused ladder ran at 1/2/3 between 2026-07-11 and 2026-08-12, so a
 * cleaner's FIRST unexcused day drew a written warning and the SECOND a final
 * warning. The ladder is back to 3/4/5 (written / final / termination), which
 * means every record written for step 1 or step 2 describes a rung that no
 * longer exists.
 *
 * Scope, deliberately narrow:
 *   - unexcused only. The tardy ladder never changed (tardy-occ rows untouched).
 *   - steps s=1 and s=2 only. s=3+ is a rung on BOTH scales, so those stand.
 *   - pending_review = true only. A record the office already Confirmed is a
 *     decision a human made; this script does not reach back through it.
 *   - dismissed = false, so re-running can't churn rows it already handled.
 *
 * Dismissal here is exactly what the office's Dismiss button does
 * (PUT /hr-discipline/:id/dismiss): dismissed = true, pending_review = false.
 * Nothing is deleted — the record stays on the profile as dismissed history.
 *
 * DRY RUN BY DEFAULT. Prints what it would touch and exits.
 *   pnpm tsx scripts/ag_unexcused_ladder_revert.ts           # preview
 *   pnpm tsx scripts/ag_unexcused_ladder_revert.ts --apply   # write
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

// Steps that exist on the tightened scale but not on 3/4/5. The ladder writer
// stamps `unexcused-occ s=<step> by=<date> count=<n>` into reason, so the step
// it fired for is recoverable from the row itself.
const DEAD_STEPS = [1, 2];

async function main() {
  console.log(`=== unexcused ladder revert — ${APPLY ? "APPLY" : "DRY RUN"} ===\n`);

  const candidates = await db.execute(sql`
    SELECT d.id, d.employee_id, d.company_id, d.discipline_type, d.custom_label,
           d.reason, d.effective_date, d.created_at,
           NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS employee_name,
           (regexp_match(d.reason, 'unexcused-occ s=(\\d+)'))[1]::int AS step
      FROM employee_discipline_log d
      LEFT JOIN users u ON u.id = d.employee_id
     WHERE d.pending_review = true
       AND d.dismissed = false
       AND d.reason LIKE 'unexcused-occ %'
       AND (regexp_match(d.reason, 'unexcused-occ s=(\\d+)'))[1]::int = ANY(${sql.raw(`ARRAY[${DEAD_STEPS.join(",")}]`)})
     ORDER BY d.company_id, d.employee_id, d.effective_date
  `);

  const rows = candidates.rows as any[];
  if (!rows.length) {
    console.log("No pending unexcused records at step 1 or 2. Nothing to do.");
    return;
  }

  console.table(rows.map(r => ({
    id: r.id,
    employee: r.employee_name ?? `#${r.employee_id}`,
    step: r.step,
    type: r.discipline_type,
    label: r.custom_label,
    effective: String(r.effective_date).slice(0, 10),
    reason: r.reason,
  })));
  console.log(`\n${rows.length} record(s) would be dismissed.`);

  // What is deliberately being left alone, so the preview shows both sides.
  const kept = await db.execute(sql`
    SELECT count(*)::int AS n
      FROM employee_discipline_log
     WHERE pending_review = true AND dismissed = false
       AND reason LIKE 'unexcused-occ %'
       AND (regexp_match(reason, 'unexcused-occ s=(\\d+)'))[1]::int >= 3
  `);
  const confirmed = await db.execute(sql`
    SELECT count(*)::int AS n
      FROM employee_discipline_log
     WHERE pending_review = false AND dismissed = false
       AND reason LIKE 'unexcused-occ %'
       AND (regexp_match(reason, 'unexcused-occ s=(\\d+)'))[1]::int = ANY(ARRAY[1,2])
  `);
  console.log(`Left alone: ${(kept.rows[0] as any).n} pending record(s) at step 3+ (a rung on both scales).`);
  console.log(`Left alone: ${(confirmed.rows[0] as any).n} already-confirmed step 1-2 record(s) — a human decided those.`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to dismiss.");
    return;
  }

  const ids = rows.map(r => Number(r.id));
  const updated = await db.execute(sql`
    UPDATE employee_discipline_log
       SET dismissed = true, pending_review = false
     WHERE id = ANY(${sql.raw(`ARRAY[${ids.join(",")}]`)})
    RETURNING id
  `);
  console.log(`\nDismissed ${updated.rows.length} record(s).`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
