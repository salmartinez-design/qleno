/**
 * Revenue reconciliation diagnostic — sections 2, 3, 5, 6. READ-ONLY.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("\n==================== SECTION 2 — Jobs table raw counts Apr 22–30 ====================\n");
  const s2 = await db.execute(sql`
    SELECT scheduled_date::text AS scheduled_date,
           COUNT(*)::int AS job_rows,
           COUNT(DISTINCT id)::int AS distinct_jobs,
           SUM(base_fee::numeric)::numeric(14,2) AS total_base_fee,
           SUM(CASE WHEN base_fee IS NULL THEN 1 ELSE 0 END)::int AS null_fee
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date BETWEEN '2026-04-22' AND '2026-04-30'
     GROUP BY scheduled_date
     ORDER BY scheduled_date
  `);
  console.table(s2.rows);

  const s2total = await db.execute(sql`
    SELECT COUNT(*)::int AS job_rows,
           SUM(base_fee::numeric)::numeric(14,2) AS total_base_fee
      FROM jobs
     WHERE company_id = 1
       AND scheduled_date BETWEEN '2026-04-22' AND '2026-04-30'
  `);
  console.log("Apr 22–30 total:", s2total.rows);

  console.log("\n==================== SECTION 3 — Dispatch inflation via technician joins ====================\n");
  const s3 = await db.execute(sql`
    SELECT j.scheduled_date::text AS scheduled_date,
           COUNT(DISTINCT j.id)::int AS unique_jobs,
           COUNT(jt.job_id)::int AS join_rows,
           (COUNT(jt.job_id) - COUNT(DISTINCT j.id))::int AS extra_rows,
           SUM(j.base_fee::numeric)::numeric(14,2) AS naive_sum,
           SUM(DISTINCT j.base_fee::numeric)::numeric(14,2) AS distinct_sum
      FROM jobs j
      LEFT JOIN job_technicians jt ON jt.job_id = j.id
     WHERE j.company_id = 1
       AND j.scheduled_date BETWEEN '2026-04-22' AND '2026-04-30'
     GROUP BY j.scheduled_date
     ORDER BY j.scheduled_date
  `);
  console.table(s3.rows);

  const s3cols = await db.execute(sql`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_name = 'jobs' AND table_schema = 'public'
     ORDER BY ordinal_position
  `);
  console.log("\nJobs table columns:");
  console.log((s3cols.rows as any[]).map(r => r.column_name).join(", "));

  console.log("\n==================== SECTION 5 — Both tables, April 2026 reality ====================\n");
  const s5 = await db.execute(sql`
    SELECT 'job_history' AS source,
           COUNT(*)::int AS rows, SUM(revenue)::numeric(14,2) AS total
      FROM job_history
     WHERE company_id = 1 AND job_date BETWEEN '2026-04-01' AND '2026-04-30'
    UNION ALL
    SELECT 'jobs' AS source,
           COUNT(*)::int AS rows, SUM(base_fee::numeric)::numeric(14,2) AS total
      FROM jobs
     WHERE company_id = 1 AND scheduled_date BETWEEN '2026-04-01' AND '2026-04-30'
  `);
  console.table(s5.rows);

  const s5daily = await db.execute(sql`
    SELECT TO_CHAR(scheduled_date, 'YYYY-MM-DD') AS date,
           COUNT(*)::int AS jobs,
           SUM(base_fee::numeric)::numeric(14,2) AS total
      FROM jobs
     WHERE company_id = 1 AND scheduled_date BETWEEN '2026-04-01' AND '2026-04-30'
     GROUP BY 1 ORDER BY 1
  `);
  console.log("\nApril 2026 day-by-day from jobs:");
  console.table(s5daily.rows);

  const s5status = await db.execute(sql`
    SELECT status,
           COUNT(*)::int AS jobs,
           SUM(base_fee::numeric)::numeric(14,2) AS total
      FROM jobs
     WHERE company_id = 1 AND scheduled_date BETWEEN '2026-04-01' AND '2026-04-30'
     GROUP BY status ORDER BY status
  `);
  console.log("\nApril 2026 jobs by status:");
  console.table(s5status.rows);

  console.log("\n==================== SECTION 6 — Apr 23 row dump ====================\n");
  const s6 = await db.execute(sql`
    SELECT j.id, j.scheduled_date::text AS scheduled_date,
           j.scheduled_time::text AS scheduled_time,
           j.base_fee::text AS base_fee, j.status,
           c.first_name, c.last_name,
           j.recurring_schedule_id,
           j.assigned_user_id,
           (SELECT COUNT(*)::int FROM job_technicians jt WHERE jt.job_id = j.id) AS tech_count
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
     ORDER BY j.scheduled_time NULLS LAST, j.id
  `);
  console.table(s6.rows);
  console.log(`\nApr 23 row count: ${s6.rowCount}`);
  const sumApr23 = (s6.rows as any[]).reduce((s, r) => s + parseFloat(r.base_fee || '0'), 0);
  console.log(`Apr 23 sum base_fee: $${sumApr23.toFixed(2)}`);

  // Bonus: Apr 23 joined with job_technicians to see the inflation
  console.log("\n--- Apr 23 with job_technicians LEFT JOIN (same shape Dispatch frontend may compute) ---");
  const s6join = await db.execute(sql`
    SELECT j.id, j.base_fee::text AS base_fee,
           (SELECT COUNT(*)::int FROM job_technicians jt WHERE jt.job_id = j.id) AS tech_count,
           COALESCE((SELECT COUNT(*)::int FROM job_technicians jt WHERE jt.job_id = j.id), 0) AS tech_mult
      FROM jobs j
     WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
     ORDER BY j.id
  `);
  const joinRows = s6join.rows as any[];
  const multipliedSum = joinRows.reduce((s, r) => s + parseFloat(r.base_fee || '0') * Math.max(1, r.tech_count), 0);
  const multipliedCount = joinRows.reduce((s, r) => s + Math.max(1, r.tech_count), 0);
  console.log(`If each job counted once per assigned technician: ${multipliedCount} rows, $${multipliedSum.toFixed(2)}`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
