/**
 * T — delete 2 pre-L4 orphan jobs (id 703 Jim Schultz, id 2081 Chaevien Clendinen).
 *
 * Both rows have:
 *   - mc_job_id IS NULL (not imported from MC)
 *   - recurring_schedule_id IS NULL (not from engine)
 *   - empty notes
 *   - zero FK refs in timeclock / additional_pay / job_technicians /
 *     job_photos / invoices (verified by orphan_job_refs.ts)
 *
 * Gates (inside transaction, rollback on any fail):
 *   1. DELETE FROM jobs returns exactly 2 rows
 *   2. Post-delete Apr 23 PHES totals = 14 jobs / $2,900.25 / 52.25h
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== T — delete 2 orphan Apr 23 jobs ===\n");

  await db.execute(sql`BEGIN`);
  try {
    // Clean-up FK: job_technicians (verified 0 refs in diagnosis, but belt-and-
    // suspenders in case Q2 auto-populated something)
    const jtDel = await db.execute(sql`
      DELETE FROM job_technicians WHERE job_id IN (703, 2081)
    `);
    console.log(`job_technicians cleanup: ${jtDel.rowCount} rows (expect 0)`);

    // Main DELETE — gated on mc_job_id IS NULL so we can't accidentally touch
    // an MC-imported row if some other script already relinked these ids.
    const del = await db.execute(sql`
      DELETE FROM jobs
       WHERE id IN (703, 2081)
         AND company_id = 1
         AND mc_job_id IS NULL
      RETURNING id
    `);
    const delCount = del.rowCount ?? 0;
    console.log(`jobs DELETE rowcount: ${delCount} (expect 2)`);
    if (delCount !== 2) {
      throw new Error(`Gate 1 FAIL — delete returned ${delCount}, expected 2`);
    }

    // Gate 2: Apr 23 final totals
    const after = await db.execute(sql`
      SELECT COUNT(*)::int AS job_count,
             SUM(base_fee::numeric)::numeric(14,2)::text AS revenue,
             SUM(allowed_hours::numeric)::numeric(14,2)::text AS hours
        FROM jobs
       WHERE company_id = 1 AND scheduled_date = '2026-04-23'
    `);
    const row = after.rows?.[0] as any;
    const gotJobs = Number(row?.job_count ?? 0);
    const gotRev = String(row?.revenue ?? "");
    const gotHrs = String(row?.hours ?? "");
    console.log(`Post: job_count=${gotJobs}  revenue=$${gotRev}  hours=${gotHrs}`);
    console.log(`Expected:            14          $2900.25       52.25`);

    const ok = gotJobs === 14 && gotRev === "2900.25" && gotHrs === "52.25";
    if (!ok) {
      throw new Error(`Gate 2 FAIL — Apr 23 totals don't match MC ground truth`);
    }

    await db.execute(sql`COMMIT`);
    console.log("\n--- COMMIT OK ---");
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.log("\n--- ROLLBACK ---");
    console.error(err);
    process.exit(1);
  }

  // Final verify outside the transaction
  const final = await db.execute(sql`
    SELECT
      CASE WHEN mc_job_id IS NULL THEN 'NO_MC_ID' ELSE 'MC_IMPORTED' END AS source,
      COUNT(*)::int AS job_count,
      SUM(base_fee::numeric)::numeric(14,2)::text AS revenue
    FROM jobs
    WHERE company_id = 1 AND scheduled_date = '2026-04-23'
    GROUP BY 1
  `);
  console.log("\n=== Apr 23 by source (post-commit) ===");
  console.table(final.rows);

  const deletedCheck = await db.execute(sql`
    SELECT id FROM jobs WHERE id IN (703, 2081)
  `);
  console.log(`\nIds 703 / 2081 still present: ${deletedCheck.rowCount} (expect 0)`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
