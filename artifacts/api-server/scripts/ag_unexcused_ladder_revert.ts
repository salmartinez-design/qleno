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
 * [earned-rungs 2026-08-14] Sal confirmed the scale stays at 3/4/5, ending at
 * FIVE. That makes the step-only rule wrong: the ladder counts OCCURRENCES, and
 * a record's count= survives a change of scale even though its step index does
 * not. A step-2 record with count=4 is a Final warning genuinely earned under
 * 3/4/5, and dismissing it would erase real attendance history. Two of the
 * eight in the first preview were exactly that (Hilda Gallegos, Anissa Bello).
 *
 * So a record is dismissed only when the LIVE ladder would not issue that same
 * discipline at that occurrence count. Records that are still earned print in
 * their own table and are left untouched.
 *
 * DRY RUN BY DEFAULT. Prints what it would touch and exits.
 *   pnpm tsx scripts/ag_unexcused_ladder_revert.ts           # preview
 *   pnpm tsx scripts/ag_unexcused_ladder_revert.ts --apply   # write
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

// Steps that exist on the tightened scale but not on 3/4/5. The ladder writer
// stamps `unexcused-occ s=<step> by=<date> count=<n>` into reason, so both the
// step it fired for AND the occurrence count at the time are recoverable from
// the row itself.
const DEAD_STEPS = [1, 2];

/**
 * [earned-rungs 2026-08-14] Selecting on step alone was wrong.
 *
 * The ladder is OCCURRENCE-based: on the restored 3/4/5 scale the 3rd
 * occurrence earns a written warning, the 4th a final, the 5th termination.
 * A record's STEP is an index on whichever scale was live when it fired, but
 * its `count=` is the real occurrence total — and that does not change when the
 * scale does.
 *
 * So a step-2 record with count=4 is a Final warning the cleaner has genuinely
 * earned under 3/4/5. Dismissing it because its step index is "dead" erases
 * real attendance history. The first preview had two of these (Hilda Gallegos
 * and Anissa Bello, both count=4, both already final_warning).
 *
 * A record is therefore dismissed only when the LIVE ladder would not issue
 * that same discipline at that occurrence count. Read from
 * company_attendance_policy per company rather than hardcoding 3/4/5, so this
 * stays correct if the office edits the scale.
 */
type LadderStep = { occurrence: number; discipline_type: string };

function earnedDiscipline(ladder: LadderStep[], count: number): string | null {
  // The rung standing at `count` occurrences: the highest threshold reached.
  let earned: string | null = null;
  for (const s of [...ladder].sort((a, b) => a.occurrence - b.occurrence)) {
    if (count >= s.occurrence) earned = s.discipline_type;
  }
  return earned;
}

async function main() {
  console.log(`=== unexcused ladder revert — ${APPLY ? "APPLY" : "DRY RUN"} ===\n`);

  const candidates = await db.execute(sql`
    SELECT d.id, d.employee_id, d.company_id, d.discipline_type, d.custom_label,
           d.reason, d.effective_date, d.created_at,
           NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS employee_name,
           (regexp_match(d.reason, 'unexcused-occ s=(\\d+)'))[1]::int AS step,
           (regexp_match(d.reason, 'count=(\\d+)'))[1]::int AS occ_count
      FROM employee_discipline_log d
      LEFT JOIN users u ON u.id = d.employee_id
     WHERE d.pending_review = true
       AND d.dismissed = false
       AND d.reason LIKE 'unexcused-occ %'
       AND (regexp_match(d.reason, 'unexcused-occ s=(\\d+)'))[1]::int = ANY(${sql.raw(`ARRAY[${DEAD_STEPS.join(",")}]`)})
     ORDER BY d.company_id, d.employee_id, d.effective_date
  `);

  const allRows = candidates.rows as any[];
  if (!allRows.length) {
    console.log("No pending unexcused records at step 1 or 2. Nothing to do.");
    return;
  }

  // [earned-rungs 2026-08-14] Live ladder per company — the office can edit it,
  // so it is read, never assumed.
  const ladderRows = (await db.execute(sql`
    SELECT company_id, unexcused_occurrence_steps
      FROM company_attendance_policy`)).rows as any[];
  const ladders = new Map<number, LadderStep[]>();
  for (const l of ladderRows) {
    const raw = l.unexcused_occurrence_steps;
    const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : (raw ?? []);
    if (Array.isArray(parsed) && parsed.length) ladders.set(Number(l.company_id), parsed);
  }

  const rows: any[] = [];
  const stillEarned: any[] = [];
  for (const r of allRows) {
    const ladder = ladders.get(Number(r.company_id));
    const count = r.occ_count == null ? null : Number(r.occ_count);
    // No ladder or no count parsed = cannot prove it is still earned. Fall back
    // to the original step-only behaviour rather than inventing a verdict.
    const earned = ladder && count != null ? earnedDiscipline(ladder, count) : null;
    if (earned && earned === String(r.discipline_type)) stillEarned.push({ ...r, earned });
    else rows.push(r);
  }

  if (stillEarned.length) {
    console.log(`── standing under the live ladder, NOT dismissed (${stillEarned.length}) ──`);
    console.table(stillEarned.map(r => ({
      id: r.id,
      employee: r.employee_name ?? `#${r.employee_id}`,
      occurrences: r.occ_count,
      type: r.discipline_type,
      effective: String(r.effective_date).slice(0, 10),
      why: `ladder issues ${r.earned} at ${r.occ_count} occurrence(s)`,
    })));
    console.log("These fired on the old step index but the cleaner has genuinely");
    console.log("reached this rung on the current scale. Left exactly as they are.\n");
  }

  if (!rows.length) {
    console.log("Every candidate is still earned under the live ladder. Nothing to dismiss.");
    return;
  }

  console.table(rows.map(r => ({
    id: r.id,
    employee: r.employee_name ?? `#${r.employee_id}`,
    step: r.step,
    occurrences: r.occ_count,
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
