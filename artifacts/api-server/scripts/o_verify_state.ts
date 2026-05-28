import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const jobs = await db.execute(sql`
    SELECT COUNT(*)::int AS mc_total,
           COUNT(*) FILTER (WHERE allowed_hours IS NOT NULL)::int AS with_allowed,
           COUNT(*) FILTER (WHERE allowed_hours IS NULL)::int AS null_allowed
      FROM jobs
     WHERE company_id = 1 AND mc_job_id IS NOT NULL
  `);
  console.log("MC-imported jobs, allowed_hours coverage:");
  console.table(jobs.rows);

  const flags = await db.execute(sql`
    SELECT id, name, recurring_engine_enabled FROM companies ORDER BY id
  `);
  console.log("\nEngine flags:");
  console.table(flags.rows);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
