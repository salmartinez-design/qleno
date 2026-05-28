/**
 * Post-J verification snapshot for the log.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const flags = await db.execute(sql`
    SELECT id, name, recurring_engine_enabled
      FROM companies
     ORDER BY id
  `);
  console.log("--- engine flags ---");
  console.table(flags.rows);

  const phesJobs = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE recurring_schedule_id IS NOT NULL)::int AS recurring,
           COUNT(*) FILTER (WHERE recurring_schedule_id IS NULL)::int AS manual
      FROM jobs
     WHERE company_id = 1
  `);
  console.log("\n--- PHES jobs ---");
  console.table(phesJobs.rows);

  const futureRec = await db.execute(sql`
    SELECT COUNT(*)::int AS n,
           MIN(scheduled_date) AS min_date,
           MAX(scheduled_date) AS max_date
      FROM jobs
     WHERE company_id = 1
       AND recurring_schedule_id IS NOT NULL
       AND scheduled_date >= CURRENT_DATE
  `);
  console.log("\n--- future-dated recurring jobs ---");
  console.table(futureRec.rows);

  const dup = await db.execute(sql`
    SELECT COUNT(*)::int AS dup_tuples
      FROM (
        SELECT 1
          FROM jobs
         WHERE recurring_schedule_id IS NOT NULL
         GROUP BY company_id, recurring_schedule_id, scheduled_date
        HAVING COUNT(*) > 1
      ) t
  `);
  console.log("\n--- remaining dup tuples ---");
  console.table(dup.rows);

  const idx = await db.execute(sql`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'jobs'
       AND indexname = 'jobs_recurring_dedupe_idx'
  `);
  console.log("\n--- index ---");
  console.log(idx.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
