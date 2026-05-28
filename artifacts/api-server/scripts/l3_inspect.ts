/**
 * L3 — Phase 3 inspection. READ-ONLY.
 *  3.1  recurring_schedules frequency enum + counts
 *  3.3a employees/users table for tech name → id mapping
 *  3.4  jobs.status enum values
 *  bonus: recurring_schedules column names (customer_id vs client_id)
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("\n=== 3.1a — recurring_schedules distinct frequencies (company_id=1) ===");
  const rsFreq = await db.execute(sql`
    SELECT DISTINCT frequency
      FROM recurring_schedules
     WHERE company_id = 1
     ORDER BY frequency
  `);
  console.table(rsFreq.rows);

  console.log("\n=== 3.1b — frequency column enum (if any) ===");
  const enumVals = await db.execute(sql`
    SELECT t.typname, e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
     WHERE t.typname ILIKE '%frequency%'
       OR e.enumlabel IN ('weekly','biweekly','triweekly','monthly','custom','one_time','single')
     ORDER BY t.typname, e.enumsortorder
  `);
  console.table(enumVals.rows);

  console.log("\n=== 3.1c — Schedule counts per frequency ===");
  const rsCnt = await db.execute(sql`
    SELECT frequency,
           COUNT(*)::int AS schedules,
           COUNT(DISTINCT customer_id)::int AS unique_clients
      FROM recurring_schedules
     WHERE company_id = 1 AND is_active = true
     GROUP BY frequency
     ORDER BY 2 DESC
  `);
  console.table(rsCnt.rows);

  console.log("\n=== 3.1d — Clients with >1 active schedule (multi-schedule tiebreaker) ===");
  const multi = await db.execute(sql`
    SELECT customer_id,
           COUNT(*)::int AS schedule_count,
           ARRAY_AGG(id ORDER BY created_at, id) AS schedule_ids,
           ARRAY_AGG(frequency ORDER BY created_at, id) AS frequencies
      FROM recurring_schedules
     WHERE company_id = 1 AND is_active = true
     GROUP BY customer_id
     HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC, customer_id
     LIMIT 20
  `);
  console.table(multi.rows);

  console.log("\n=== 3.3a — employees OR users with technician role (company_id=1) ===");
  // Try employees first, fall back to users
  let techRows: any[] = [];
  try {
    const emp = await db.execute(sql`
      SELECT id, first_name, last_name,
             (first_name || ' ' || last_name) AS full_name
        FROM employees
       WHERE company_id = 1
       ORDER BY first_name, last_name
    `);
    console.log("(using employees table)");
    techRows = emp.rows as any[];
    console.table(techRows);
  } catch (err: any) {
    console.log("employees table not queryable, trying users...", err?.code ?? "");
    const users = await db.execute(sql`
      SELECT id, first_name, last_name, role, is_active, tags,
             (first_name || ' ' || last_name) AS full_name
        FROM users
       WHERE company_id = 1
         AND is_active = true
         AND (
           role IN ('technician','team_lead')
           OR (COALESCE(tags, '{}') && ARRAY['field','technician']::text[])
         )
       ORDER BY first_name, last_name
    `);
    console.log("(using users table with technician/team_lead/tagged roles)");
    techRows = users.rows as any[];
    console.table(techRows);
  }

  console.log("\n=== 3.4a — jobs.status enum values ===");
  const jobStatus = await db.execute(sql`
    SELECT t.typname, e.enumlabel, e.enumsortorder
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
     WHERE t.typname = 'job_status'
        OR e.enumlabel IN ('scheduled','complete','completed','in_progress','cancelled','pending')
     ORDER BY t.typname, e.enumsortorder
  `);
  console.table(jobStatus.rows);

  console.log("\n=== 3.4b — Distinct jobs.status currently present in table ===");
  const jobDistinct = await db.execute(sql`
    SELECT status::text, COUNT(*)::int AS n
      FROM jobs
     GROUP BY status
     ORDER BY n DESC
  `);
  console.table(jobDistinct.rows);

  // Bonus: confirm the FK column name on recurring_schedules is customer_id
  console.log("\n=== bonus — recurring_schedules customer/client column ===");
  const rsCols = await db.execute(sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'recurring_schedules' AND table_schema = 'public'
       AND column_name IN ('customer_id','client_id','frequency','is_active','assigned_employee_id')
     ORDER BY ordinal_position
  `);
  console.table(rsCols.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
