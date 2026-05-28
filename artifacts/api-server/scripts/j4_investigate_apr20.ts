/**
 * J4 investigation — reconcile 79 vs 56 Apr-20 $0 phantom count.
 * READ-ONLY.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // All Apr-20 recurring rows grouped by schedule with base_fee
  const byScheduleAll = await db.execute(sql`
    SELECT recurring_schedule_id,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE base_fee IS NULL OR base_fee::numeric = 0)::int AS zero_n,
           MIN(created_at) AS first_created,
           MAX(created_at) AS last_created
      FROM jobs
     WHERE company_id = 1
       AND recurring_schedule_id IS NOT NULL
       AND scheduled_date = '2026-04-20'
     GROUP BY recurring_schedule_id
     ORDER BY recurring_schedule_id
  `);
  console.log("Apr-20 recurring rows by schedule:");
  console.table(byScheduleAll.rows);

  // Sum totals
  const totals = await db.execute(sql`
    SELECT COUNT(*) FILTER (WHERE base_fee IS NULL OR base_fee::numeric = 0)::int AS zero_n,
           COUNT(*)::int AS total_n
      FROM jobs
     WHERE company_id = 1
       AND recurring_schedule_id IS NOT NULL
       AND scheduled_date = '2026-04-20'
  `);
  console.log("\nApr-20 recurring totals:", totals.rows);

  // Count by created_at window
  const byWindow = await db.execute(sql`
    SELECT DATE_TRUNC('hour', created_at) AS hour_bucket,
           COUNT(*)::int AS n
      FROM jobs
     WHERE company_id = 1
       AND recurring_schedule_id IS NOT NULL
       AND scheduled_date = '2026-04-20'
       AND (base_fee IS NULL OR base_fee::numeric = 0)
     GROUP BY 1
     ORDER BY 1
  `);
  console.log("\nApr-20 $0 phantoms by created-hour:");
  console.table(byWindow.rows);

  // Spot-check a few raw rows
  const rawSample = await db.execute(sql`
    SELECT id, recurring_schedule_id, scheduled_date, base_fee::text AS base_fee,
           created_at, updated_at
      FROM jobs
     WHERE company_id = 1
       AND recurring_schedule_id IS NOT NULL
       AND scheduled_date = '2026-04-20'
       AND (base_fee IS NULL OR base_fee::numeric = 0)
     ORDER BY recurring_schedule_id, id
     LIMIT 30
  `);
  console.log("\nSample Apr-20 $0 phantom rows (first 30):");
  console.table(rawSample.rows);

  // Verify Jim Schultz 2026-06-18
  const jim = await db.execute(sql`
    SELECT id, recurring_schedule_id, scheduled_date, base_fee::text AS base_fee, created_at
      FROM jobs
     WHERE recurring_schedule_id = 52
       AND scheduled_date = '2026-06-18'
     ORDER BY id
  `);
  console.log("\nJim Schultz sched 52 / 2026-06-18 rows:");
  console.table(jim.rows);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
