/**
 * L4 pre-fix — resolve Daveco 11-row dedupe-index collisions.
 * For each (matched_schedule_id, scheduled_date) collision group, keep
 * matched_schedule_id on the row with the lowest mc_job_id and NULL
 * it on the rest. That way 1 row per date-schedule remains linked to
 * recurring_schedule_id=35; others land as client_id=25 with NULL schedule.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("=== L4 pre-fix: Daveco collision NULL-out ===\n");

  await db.execute(sql`BEGIN`);
  try {
    const res = await db.execute(sql`
      WITH ranked AS (
        SELECT mc_job_id,
               ROW_NUMBER() OVER (
                 PARTITION BY matched_schedule_id, scheduled_date
                 ORDER BY mc_job_id
               ) AS rn
          FROM mc_dispatch_staging
         WHERE matched_schedule_id IS NOT NULL
      )
      UPDATE mc_dispatch_staging s
         SET matched_schedule_id = NULL
        FROM ranked r
       WHERE s.mc_job_id = r.mc_job_id
         AND r.rn > 1
    `);
    console.log(`NULL-out rowcount: ${res.rowCount} (expect 7)`);
    if (res.rowCount !== 7) throw new Error(`Expected 7, got ${res.rowCount}`);
    await db.execute(sql`COMMIT`);
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    throw err;
  }

  // Verify no remaining collisions
  const remaining = await db.execute(sql`
    SELECT matched_customer_id, matched_schedule_id, scheduled_date, COUNT(*)::int AS n
      FROM mc_dispatch_staging
     WHERE matched_schedule_id IS NOT NULL
     GROUP BY 1,2,3 HAVING COUNT(*) > 1
  `);
  console.log(`Remaining collision groups: ${remaining.rowCount} (expect 0)`);
  if ((remaining.rowCount ?? 0) > 0) console.table(remaining.rows);

  // Show before/after rates
  const linked = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
           COUNT(matched_schedule_id)::int AS with_schedule,
           COUNT(*) FILTER (WHERE matched_schedule_id IS NULL)::int AS no_schedule
      FROM mc_dispatch_staging
  `);
  console.log("Post-fix staging match rates:");
  console.table(linked.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
