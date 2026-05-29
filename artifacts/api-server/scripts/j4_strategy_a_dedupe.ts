/**
 * J4 Strategy A' (aggressive, user-confirmed) — full Apr-20 $0 phantom sweep.
 *
 * - 79 Apr-20 $0 phantom rows from recurring schedules (Apr 19 + Apr 20
 *   regrowth, missed by Commit E's past-date filter; 40 created 2026-04-19
 *   07:00 UTC, 39 created 2026-04-20 07:00 UTC)
 * - 1 Jim Schultz sched 52 2026-06-18 duplicate (keep lower id 2003, delete 2004)
 *
 * Runs in a single transaction with rowcount gates. Rolls back on mismatch.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== J4 Strategy A — pre-existing dupe cleanup ===\n");

  // ---------- PRE-FLIGHT ----------
  const preApr20 = await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM jobs
     WHERE company_id = 1
       AND recurring_schedule_id IS NOT NULL
       AND scheduled_date = '2026-04-20'
       AND (base_fee IS NULL OR base_fee::numeric = 0)
  `);
  const preApr20Count = Number((preApr20.rows?.[0] as any)?.n ?? 0);
  console.log(`Pre-flight: Apr-20 $0 phantom rows = ${preApr20Count} (expect 79)`);

  const preJim = await db.execute(sql`
    SELECT id, base_fee::text AS base_fee
      FROM jobs
     WHERE id IN (2003, 2004)
     ORDER BY id
  `);
  console.log(`Pre-flight: Jim Schultz dedup rows =`, preJim.rows);

  const preDupes = await db.execute(sql`
    SELECT company_id, recurring_schedule_id, scheduled_date, COUNT(*)::int AS n
      FROM jobs
     WHERE company_id = 1
       AND recurring_schedule_id IS NOT NULL
     GROUP BY company_id, recurring_schedule_id, scheduled_date
    HAVING COUNT(*) > 1
     ORDER BY recurring_schedule_id, scheduled_date
  `);
  console.log(`\nPre-flight: duplicate tuples in jobs = ${preDupes.rowCount ?? preDupes.rows.length}`);
  console.log(preDupes.rows);

  if (preApr20Count !== 79) {
    console.log(`\n!! Apr-20 count mismatch (got ${preApr20Count}, expected 79). Aborting.`);
    process.exit(1);
  }
  if (preJim.rowCount !== 2) {
    console.log(`\n!! Jim Schultz rows mismatch (got ${preJim.rowCount}, expected 2). Aborting.`);
    process.exit(1);
  }

  // ---------- TRANSACTION ----------
  console.log("\n--- BEGIN TRANSACTION ---");
  await db.execute(sql`BEGIN`);
  try {
    const d1 = await db.execute(sql`
      DELETE FROM jobs
       WHERE company_id = 1
         AND recurring_schedule_id IS NOT NULL
         AND scheduled_date = '2026-04-20'
         AND (base_fee IS NULL OR base_fee::numeric = 0)
    `);
    const d1Count = d1.rowCount ?? 0;
    console.log(`DELETE Apr-20 $0 phantoms: ${d1Count} rows (expect 79)`);
    if (d1Count !== 79) {
      throw new Error(`Apr-20 delete mismatch: got ${d1Count}, expected 79`);
    }

    const d2 = await db.execute(sql`DELETE FROM jobs WHERE id = 2004`);
    const d2Count = d2.rowCount ?? 0;
    console.log(`DELETE Jim Schultz dupe id=2004: ${d2Count} rows (expect 1)`);
    if (d2Count !== 1) {
      throw new Error(`Jim Schultz delete mismatch: got ${d2Count}, expected 1`);
    }

    // Verify zero dup tuples before commit
    const postDupes = await db.execute(sql`
      SELECT company_id, recurring_schedule_id, scheduled_date, COUNT(*)::int AS n
        FROM jobs
       WHERE company_id = 1
         AND recurring_schedule_id IS NOT NULL
       GROUP BY company_id, recurring_schedule_id, scheduled_date
      HAVING COUNT(*) > 1
    `);
    const remainingDupes = postDupes.rowCount ?? postDupes.rows.length;
    console.log(`\nIn-txn verify: remaining dup tuples = ${remainingDupes} (expect 0)`);
    if (remainingDupes !== 0) {
      console.log(postDupes.rows);
      throw new Error(`Dup tuples remain after cleanup: ${remainingDupes}`);
    }

    await db.execute(sql`COMMIT`);
    console.log("--- COMMIT OK ---");
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.log("--- ROLLBACK ---");
    console.error(err);
    process.exit(1);
  }

  // ---------- POST-VERIFY ----------
  const postApr20 = await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM jobs
     WHERE company_id = 1
       AND recurring_schedule_id IS NOT NULL
       AND scheduled_date = '2026-04-20'
  `);
  console.log(`\nPost: Apr-20 recurring rows = ${(postApr20.rows?.[0] as any)?.n}`);

  const postJim = await db.execute(sql`SELECT id FROM jobs WHERE id IN (2003, 2004)`);
  console.log(`Post: Jim Schultz ids remaining =`, postJim.rows);

  const totalJobs = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM jobs WHERE company_id = 1
  `);
  console.log(`Post: total PHES jobs = ${(totalJobs.rows?.[0] as any)?.n}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
