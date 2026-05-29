/**
 * Commit K — Step 1 dry-run: identify rows slated for delete + verify remainders.
 * READ-ONLY.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== Commit K Step 1 — DRY RUN ===\n");

  // Full list of flagged rows
  console.log("--- Rows flagged for delete (engine-sourced future scheduled, Apr 23+) ---");
  const flagged = await db.execute(sql`
    SELECT id, scheduled_date::text AS scheduled_date,
           client_id AS customer_id,
           base_fee::text AS base_fee,
           status, recurring_schedule_id,
           created_at
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date >= '2026-04-23'
       AND recurring_schedule_id IS NOT NULL
       AND status = 'scheduled'
     ORDER BY scheduled_date, id
  `);
  console.table(flagged.rows);
  console.log(`Total flagged: ${flagged.rowCount}`);

  // Count summary by date
  console.log("\n--- Count summary by scheduled_date ---");
  const summary = await db.execute(sql`
    SELECT scheduled_date::text AS scheduled_date,
           COUNT(*)::int AS row_count,
           SUM(base_fee::numeric)::numeric(14,2) AS sum_fee
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date >= '2026-04-23'
       AND recurring_schedule_id IS NOT NULL
       AND status = 'scheduled'
     GROUP BY scheduled_date
     ORDER BY scheduled_date
  `);
  console.table(summary.rows);

  const totalFlagged = await db.execute(sql`
    SELECT COUNT(*)::int AS n,
           SUM(base_fee::numeric)::numeric(14,2) AS total
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date >= '2026-04-23'
       AND recurring_schedule_id IS NOT NULL
       AND status = 'scheduled'
  `);
  console.log("\nGrand total flagged:", totalFlagged.rows);

  // What REMAINS in Apr 2026 after hypothetical delete
  console.log("\n--- What REMAINS in April 2026 after delete (manual, completed, cancelled, pre-Apr-23) ---");
  const remain = await db.execute(sql`
    SELECT scheduled_date::text AS scheduled_date,
           status,
           (recurring_schedule_id IS NULL) AS is_manual,
           COUNT(*)::int AS n,
           SUM(base_fee::numeric)::numeric(14,2) AS sum_fee
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date BETWEEN '2026-04-01' AND '2026-04-30'
       AND NOT (recurring_schedule_id IS NOT NULL AND status = 'scheduled'
                AND scheduled_date >= '2026-04-23')
     GROUP BY scheduled_date, status, is_manual
     ORDER BY scheduled_date, status, is_manual
  `);
  console.table(remain.rows);

  const remainTotal = await db.execute(sql`
    SELECT COUNT(*)::int AS n,
           SUM(base_fee::numeric)::numeric(14,2) AS total
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date BETWEEN '2026-04-01' AND '2026-04-30'
       AND NOT (recurring_schedule_id IS NOT NULL AND status = 'scheduled'
                AND scheduled_date >= '2026-04-23')
  `);
  console.log("\nApril 2026 remaining total:", remainTotal.rows);

  // Sanity — make sure nothing in the pre-Apr-23 window or non-scheduled gets swept
  console.log("\n--- Pre-Apr-23 engine rows (must NOT be deleted) ---");
  const preApr23 = await db.execute(sql`
    SELECT scheduled_date::text AS scheduled_date,
           status,
           COUNT(*)::int AS n,
           SUM(base_fee::numeric)::numeric(14,2) AS sum_fee
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date >= '2026-04-01'
       AND scheduled_date < '2026-04-23'
       AND recurring_schedule_id IS NOT NULL
     GROUP BY scheduled_date, status
     ORDER BY scheduled_date, status
  `);
  console.table(preApr23.rows);

  // Future horizon sweep — anything flagged post April
  console.log("\n--- Flagged rows beyond April (May–Jun engine-generated) ---");
  const futureEngine = await db.execute(sql`
    SELECT scheduled_date::text AS scheduled_date,
           COUNT(*)::int AS n,
           SUM(base_fee::numeric)::numeric(14,2) AS sum_fee
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date > '2026-04-30'
       AND recurring_schedule_id IS NOT NULL
       AND status = 'scheduled'
     GROUP BY scheduled_date
     ORDER BY scheduled_date
  `);
  console.table(futureEngine.rows);
  const futureTotal = await db.execute(sql`
    SELECT COUNT(*)::int AS n,
           SUM(base_fee::numeric)::numeric(14,2) AS total
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date > '2026-04-30'
       AND recurring_schedule_id IS NOT NULL
       AND status = 'scheduled'
  `);
  console.log("Beyond April total:", futureTotal.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
