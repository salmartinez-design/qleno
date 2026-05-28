import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== Collisions on (client_id, matched_schedule_id, scheduled_date) in staging ===");
  const collide = await db.execute(sql`
    SELECT matched_customer_id, matched_schedule_id, scheduled_date::text AS scheduled_date,
           COUNT(*)::int AS n,
           ARRAY_AGG(mc_job_id ORDER BY mc_job_id) AS mc_ids
      FROM mc_dispatch_staging
     WHERE matched_schedule_id IS NOT NULL
     GROUP BY matched_customer_id, matched_schedule_id, scheduled_date
     HAVING COUNT(*) > 1
     ORDER BY n DESC, matched_customer_id, scheduled_date
     LIMIT 40
  `);
  console.log(`Collision groups: ${collide.rowCount}`);
  console.table(collide.rows);

  console.log("\n=== Summary: rows involved in collisions ===");
  const summary = await db.execute(sql`
    WITH collide AS (
      SELECT matched_customer_id, matched_schedule_id, scheduled_date, COUNT(*)::int AS n
        FROM mc_dispatch_staging
       WHERE matched_schedule_id IS NOT NULL
       GROUP BY 1,2,3 HAVING COUNT(*) > 1
    )
    SELECT SUM(n)::int AS colliding_rows,
           COUNT(*)::int AS collision_groups
      FROM collide
  `);
  console.table(summary.rows);

  console.log("\n=== By customer: how many collision groups per customer ===");
  const byClient = await db.execute(sql`
    WITH collide AS (
      SELECT matched_customer_id, matched_schedule_id, scheduled_date, COUNT(*)::int AS n
        FROM mc_dispatch_staging
       WHERE matched_schedule_id IS NOT NULL
       GROUP BY 1,2,3 HAVING COUNT(*) > 1
    )
    SELECT c.matched_customer_id,
           cl.first_name || ' ' || cl.last_name AS name,
           COUNT(*)::int AS collision_groups,
           SUM(c.n)::int AS total_rows_involved
      FROM collide c
      LEFT JOIN clients cl ON cl.id = c.matched_customer_id
     GROUP BY c.matched_customer_id, cl.first_name, cl.last_name
     ORDER BY collision_groups DESC
  `);
  console.table(byClient.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
