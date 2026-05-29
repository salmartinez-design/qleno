import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const r = await db.execute(sql`
    SELECT
      CASE WHEN mc_job_id IS NULL THEN 'NO_MC_ID (engine/manual)' ELSE 'MC_IMPORTED' END AS source,
      COUNT(*)::int AS job_count,
      SUM(base_fee::numeric)::numeric(14,2) AS revenue,
      SUM(allowed_hours::numeric)::numeric(14,2) AS hours
    FROM jobs
    WHERE company_id = 1
      AND scheduled_date = '2026-04-23'
    GROUP BY 1
  `);
  console.table(r.rows);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
