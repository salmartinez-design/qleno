import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== Re-verify Apr 23 + quote 28 state ===\n");

  // Apr 23 by source
  const apr23 = await db.execute(sql`
    SELECT
      CASE WHEN mc_job_id IS NULL THEN 'NO_MC_ID' ELSE 'MC_IMPORTED' END AS source,
      COUNT(*)::int AS job_count,
      SUM(base_fee::numeric)::numeric(14,2)::text AS revenue,
      SUM(allowed_hours::numeric)::numeric(14,2)::text AS hours
    FROM jobs
    WHERE company_id = 1 AND scheduled_date = '2026-04-23'
    GROUP BY 1
  `);
  console.log("Apr 23 jobs by source:");
  console.table(apr23.rows);

  // Aggregate
  const agg = await db.execute(sql`
    SELECT COUNT(*)::int AS job_count,
           SUM(base_fee::numeric)::numeric(14,2)::text AS revenue,
           SUM(allowed_hours::numeric)::numeric(14,2)::text AS hours,
           COUNT(*) FILTER (WHERE assigned_user_id IS NULL
                            AND NOT EXISTS (SELECT 1 FROM job_technicians jt WHERE jt.job_id = jobs.id))::int AS unassigned
      FROM jobs
     WHERE company_id = 1 AND scheduled_date = '2026-04-23'
  `);
  console.log("\nApr 23 aggregate:");
  console.table(agg.rows);

  // Jobs 703 + 2081 confirmed gone
  const gone = await db.execute(sql`
    SELECT id FROM jobs WHERE id IN (703, 2081)
  `);
  console.log(`\nIds 703 / 2081 still present: ${gone.rowCount} (expect 0)`);

  // Quote 28 state
  const q28 = await db.execute(sql`
    SELECT id, client_id, lead_name, status, booked_job_id, total_price::text AS total_price
      FROM quotes WHERE id = 28
  `);
  console.log("\nQuote 28 (Chaevien Clendinen):");
  console.table(q28.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
