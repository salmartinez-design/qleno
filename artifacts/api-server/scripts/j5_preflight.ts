/**
 * J5 pre-flight — flag state + baseline jobs count.
 * READ-ONLY.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const flags = await db.execute(sql`
    SELECT id, name, recurring_engine_enabled FROM companies ORDER BY id
  `);
  console.log("--- engine flags (all four tenants) ---");
  console.table(flags.rows);

  const baseline = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE recurring_schedule_id IS NOT NULL)::int AS recurring_sourced,
      COUNT(*) FILTER (WHERE scheduled_date >= CURRENT_DATE)::int AS future,
      COUNT(*) FILTER (WHERE base_fee IS NULL OR base_fee::numeric = 0)::int AS zero_fee
    FROM jobs WHERE company_id = 1
  `);
  console.log("\n--- PHES jobs baseline ---");
  console.table(baseline.rows);

  const dupes = await db.execute(sql`
    SELECT company_id, recurring_schedule_id, scheduled_date, COUNT(*)::int AS n
      FROM jobs
     WHERE company_id = 1 AND recurring_schedule_id IS NOT NULL
     GROUP BY 1,2,3 HAVING COUNT(*) > 1
  `);
  console.log("\n--- existing duplicate tuples (should be 0) ---");
  console.log(dupes.rows);

  const idx = await db.execute(sql`
    SELECT indexname FROM pg_indexes
     WHERE schemaname='public' AND tablename='jobs' AND indexname='jobs_recurring_dedupe_idx'
  `);
  console.log("\n--- unique dedup index present? ---");
  console.log(idx.rows);

  const schedules = await db.execute(sql`
    SELECT COUNT(*)::int AS active_schedules,
           COUNT(*) FILTER (WHERE base_fee IS NULL OR base_fee::numeric = 0)::int AS null_or_zero_fee
      FROM recurring_schedules
     WHERE company_id = 1 AND is_active = true
  `);
  console.log("\n--- PHES active schedules ---");
  console.table(schedules.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
