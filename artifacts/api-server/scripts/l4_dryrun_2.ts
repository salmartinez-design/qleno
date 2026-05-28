/**
 * L4 dry-run supplement — fix ANY() syntax + probe enums the prompt missed.
 */
import { db } from "@workspace/db";
import { sql, inArray } from "drizzle-orm";

async function main() {
  // Fix: use inArray from drizzle
  const ids = [32, 33, 34, 36, 38, 39, 40, 41, 42, 43, 283];
  console.log("=== Tech user existence check ===");
  const users = await db.execute(sql`
    SELECT id, first_name, last_name, is_active, role
      FROM users
     WHERE id IN (32, 33, 34, 36, 38, 39, 40, 41, 42, 43, 283)
     ORDER BY id
  `);
  console.table(users.rows);
  const present = new Set((users.rows as any[]).map(u => u.id));
  const missing = ids.filter(i => !present.has(i));
  if (missing.length === 0) console.log("All 11 tech ids exist in users. ✓");
  else console.log("!!! MISSING:", missing);

  // service_type enum — required on jobs insert
  console.log("\n=== service_type enum values ===");
  const stEnum = await db.execute(sql`
    SELECT t.typname, e.enumlabel, e.enumsortorder
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
     WHERE t.typname IN ('service_type', 'job_service_type')
     ORDER BY t.typname, e.enumsortorder
  `);
  console.table(stEnum.rows);

  // What service_type values are in use in the existing jobs table?
  console.log("\n=== service_type distribution in jobs (existing 83 rows) ===");
  const stExisting = await db.execute(sql`
    SELECT service_type::text, COUNT(*)::int AS n
      FROM jobs
     WHERE company_id = 1
     GROUP BY service_type
     ORDER BY n DESC
  `);
  console.table(stExisting.rows);

  // frequency enum (on jobs, not recurring_schedules — they use different enums)
  console.log("\n=== jobs.frequency enum values ===");
  const freqEnum = await db.execute(sql`
    SELECT t.typname, e.enumlabel, e.enumsortorder
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
     WHERE t.typname = 'frequency'
     ORDER BY e.enumsortorder
  `);
  console.table(freqEnum.rows);

  // Existing jobs frequency distribution
  console.log("\n=== jobs.frequency distribution (existing 83) ===");
  const fExisting = await db.execute(sql`
    SELECT frequency::text, COUNT(*)::int AS n
      FROM jobs WHERE company_id = 1
     GROUP BY frequency ORDER BY n DESC
  `);
  console.table(fExisting.rows);

  // Count bill_rate = 0 rows in staging (will become base_fee=0 in jobs — not NULL, so NOT NULL constraint is fine)
  console.log("\n=== Staging rows with bill_rate = 0 or NULL ===");
  const zeroFee = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE bill_rate IS NULL)::int AS null_fee,
      COUNT(*) FILTER (WHERE bill_rate = 0)::int AS zero_fee,
      COUNT(*) FILTER (WHERE bill_rate > 0)::int AS positive_fee,
      COUNT(*)::int AS total
    FROM mc_dispatch_staging
  `);
  console.table(zeroFee.rows);

  // If any NULL, they'd break the NOT NULL base_fee constraint. Confirm none.
  console.log("\n=== Sample bill_rate=0 rows ===");
  const zeroSample = await db.execute(sql`
    SELECT mc_job_id, customer_name, status_raw, billing_terms, LEFT(COALESCE(address,''), 40) AS addr
      FROM mc_dispatch_staging
     WHERE bill_rate = 0
     ORDER BY scheduled_date
     LIMIT 10
  `);
  console.table(zeroSample.rows);
  const zeroCount = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM mc_dispatch_staging WHERE bill_rate = 0
  `);
  console.log("Total $0 rows:", zeroCount.rows);

  // MC frequency field distribution with proposed Qleno freq mapping
  console.log("\n=== Proposed MC freq → Qleno jobs.frequency mapping ===");
  const freqMap = await db.execute(sql`
    SELECT frequency AS mc_freq,
           CASE frequency
             WHEN 'Every Week'        THEN 'weekly'
             WHEN 'Every Two Weeks'   THEN 'biweekly'
             WHEN 'Every Four Weeks'  THEN 'monthly'
             WHEN 'Every Three Weeks' THEN 'every_3_weeks'
             WHEN 'Other Recurring'   THEN 'on_demand'
             WHEN 'Single'            THEN 'on_demand'
             WHEN 'On Demand'         THEN 'on_demand'
             ELSE 'on_demand'
           END AS qleno_freq,
           COUNT(*)::int AS n
      FROM mc_dispatch_staging
     GROUP BY mc_freq
     ORDER BY n DESC
  `);
  console.table(freqMap.rows);

  // Sample row with full staging columns to check what address would be
  console.log("\n=== Sample staging row (complete) ===");
  const fullSample = await db.execute(sql`
    SELECT * FROM mc_dispatch_staging WHERE mc_job_id = 59514438
  `);
  console.log(fullSample.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
