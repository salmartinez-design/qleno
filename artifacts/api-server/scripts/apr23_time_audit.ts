/**
 * Schema notes for Sal's time audit:
 *   - jobs.scheduled_time is TEXT (not TIME), so EXTRACT won't work directly.
 *     Using string inspection + conditional cast.
 *   - mc_dispatch_staging has no raw_data JSONB; parsed fields only.
 *     Using scheduled_raw (original MC string) + scheduled_time_start/end.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // 1. Raw scheduled_time values, all 14 Apr 23 jobs
  console.log("=== 1. Apr 23 jobs — raw scheduled_time values ===");
  const q1 = await db.execute(sql`
    SELECT
      j.id,
      j.mc_job_id,
      c.first_name || ' ' || c.last_name AS client_name,
      j.scheduled_time,
      pg_typeof(j.scheduled_time)::text AS time_type,
      LENGTH(j.scheduled_time) AS time_len,
      j.scheduled_date::text AS scheduled_date,
      j.allowed_hours::text AS allowed_hours
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
    ORDER BY
      CASE WHEN j.scheduled_time ~ '^\\d{1,2}:\\d{2}(:\\d{2})?$'
           THEN j.scheduled_time::time
           ELSE NULL
      END NULLS LAST,
      j.scheduled_time,
      j.id
  `);
  console.table(q1.rows);

  // 2. City Light Church (should be 1:30 PM per MC). mc_job_id=48581765
  console.log("\n=== 2. City Light Church (mc_job_id=48581765) ===");
  const q2 = await db.execute(sql`
    SELECT
      id, mc_job_id, scheduled_time,
      pg_typeof(scheduled_time)::text AS time_type,
      LENGTH(scheduled_time) AS time_len
    FROM jobs
    WHERE company_id = 1 AND scheduled_date = '2026-04-23'
      AND mc_job_id = 48581765
  `);
  console.table(q2.rows);

  // 3. Shannon Heidloff (MC shows 1:30 PM). mc_job_id=62088584
  console.log("\n=== 3. Shannon Heidloff (mc_job_id=62088584) ===");
  const q3 = await db.execute(sql`
    SELECT
      id, mc_job_id, scheduled_time,
      pg_typeof(scheduled_time)::text AS time_type,
      LENGTH(scheduled_time) AS time_len
    FROM jobs
    WHERE company_id = 1 AND scheduled_date = '2026-04-23'
      AND mc_job_id = 62088584
  `);
  console.table(q3.rows);

  // 4. Cross-reference against mc_dispatch_staging
  console.log("\n=== 4. mc_dispatch_staging — what MC actually sent ===");
  const q4 = await db.execute(sql`
    SELECT
      mc_job_id,
      customer_name,
      scheduled_raw,
      scheduled_date::text AS staging_date,
      scheduled_time_start,
      scheduled_time_end
    FROM mc_dispatch_staging
    WHERE mc_job_id IN (48581765, 62088584, 60606153, 62002679)
    ORDER BY mc_job_id
  `);
  console.table(q4.rows);

  // 5. Bonus: all 14 jobs cross-ref staging → jobs to see where the time got scrambled
  console.log("\n=== 5. Full Apr 23 side-by-side (staging vs jobs) ===");
  const q5 = await db.execute(sql`
    SELECT
      j.id AS job_id,
      j.mc_job_id,
      LEFT(mcs.customer_name, 30) AS mc_customer,
      mcs.scheduled_time_start AS staging_time,
      j.scheduled_time AS jobs_time,
      (mcs.scheduled_time_start = j.scheduled_time) AS exact_match,
      LEFT(mcs.scheduled_raw, 45) AS mc_scheduled_raw
    FROM jobs j
    LEFT JOIN mc_dispatch_staging mcs ON mcs.mc_job_id = j.mc_job_id
    WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
    ORDER BY mcs.scheduled_time_start NULLS LAST, j.id
  `);
  console.table(q5.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
