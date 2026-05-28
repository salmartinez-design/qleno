/**
 * J5 Step 3 — verify the 272 rows landed cleanly.
 * READ-ONLY.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  const snap = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_now,
      COUNT(*) FILTER (WHERE recurring_schedule_id IS NOT NULL AND created_at >= NOW() - INTERVAL '10 minutes')::int AS just_inserted,
      COUNT(*) FILTER (WHERE recurring_schedule_id IS NOT NULL AND created_at >= NOW() - INTERVAL '10 minutes' AND (base_fee IS NULL OR base_fee::numeric = 0))::int AS new_zero_fee,
      (SELECT COUNT(DISTINCT recurring_schedule_id)::int FROM jobs WHERE company_id = 1 AND created_at >= NOW() - INTERVAL '10 minutes') AS distinct_schedules_processed,
      (SELECT COUNT(*)::int FROM jobs WHERE company_id = 1 AND created_at >= NOW() - INTERVAL '10 minutes' AND recurring_schedule_id IS NOT NULL AND assigned_user_id IS NULL) AS unassigned_new,
      (SELECT MIN(scheduled_date)::text FROM jobs WHERE company_id = 1 AND created_at >= NOW() - INTERVAL '10 minutes') AS min_date_new,
      (SELECT MAX(scheduled_date)::text FROM jobs WHERE company_id = 1 AND created_at >= NOW() - INTERVAL '10 minutes') AS max_date_new
    FROM jobs WHERE company_id = 1
  `);
  console.log("--- snapshot ---");
  console.table(snap.rows);

  const dupe = await db.execute(sql`
    SELECT company_id, recurring_schedule_id, scheduled_date, COUNT(*)::int AS n
      FROM jobs
     WHERE company_id = 1
       AND recurring_schedule_id IS NOT NULL
       AND created_at >= NOW() - INTERVAL '10 minutes'
     GROUP BY 1,2,3 HAVING COUNT(*) > 1
  `);
  console.log(`\n--- duplicate tuples in just-inserted set (expect 0) ---`);
  console.log(`rowcount=${dupe.rowCount ?? 0}`);
  console.log(dupe.rows);

  const allDupe = await db.execute(sql`
    SELECT company_id, recurring_schedule_id, scheduled_date, COUNT(*)::int AS n
      FROM jobs
     WHERE company_id = 1 AND recurring_schedule_id IS NOT NULL
     GROUP BY 1,2,3 HAVING COUNT(*) > 1
  `);
  console.log(`\n--- duplicate tuples in entire PHES jobs (expect 0) ---`);
  console.log(`rowcount=${allDupe.rowCount ?? 0}`);

  // Tech distribution on the new 272 (schema: jobs.assigned_user_id -> users.id)
  const techDist = await db.execute(sql`
    SELECT
      COALESCE(u.first_name || ' ' || u.last_name, 'Unassigned') AS tech,
      COUNT(*)::int AS job_count
      FROM jobs j
      LEFT JOIN users u ON u.id = j.assigned_user_id
     WHERE j.company_id = 1
       AND j.recurring_schedule_id IS NOT NULL
       AND j.created_at >= NOW() - INTERVAL '10 minutes'
     GROUP BY u.id, u.first_name, u.last_name
     ORDER BY job_count DESC
  `);
  console.log("\n--- tech distribution on new 272 ---");
  console.table(techDist.rows);

  // Verify the 5 NULL-fee schedules got zero new rows
  const nullFeeCheck = await db.execute(sql`
    SELECT rs.id AS sched_id,
           c.first_name || ' ' || c.last_name AS client,
           rs.base_fee,
           (SELECT COUNT(*)::int FROM jobs j
             WHERE j.recurring_schedule_id = rs.id
               AND j.created_at >= NOW() - INTERVAL '10 minutes') AS new_rows
      FROM recurring_schedules rs
      LEFT JOIN clients c ON c.id = rs.customer_id
     WHERE rs.id IN (13, 19, 27, 78, 86)
     ORDER BY rs.id
  `);
  console.log("\n--- NULL-fee guard enforcement (expect new_rows=0 for all 5) ---");
  console.table(nullFeeCheck.rows);

  // Engine flag state
  const flags = await db.execute(sql`
    SELECT id, name, recurring_engine_enabled FROM companies ORDER BY id
  `);
  console.log("\n--- engine flags ---");
  console.table(flags.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
