/**
 * Apr 23 post-cleanup verification.
 * Note: jobs table has no `scope` column — using `service_type` as the
 * closest equivalent. (Column confirmed absent via A.1 schema probe.)
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  // 1. Confirm 2081 is gone
  console.log("=== 1. Job 2081 presence check ===");
  const q1 = await db.execute(sql`
    SELECT id, mc_job_id, client_id, scheduled_date::text AS scheduled_date,
           scheduled_time, base_fee::text AS base_fee, status::text AS status
      FROM jobs WHERE id = 2081
  `);
  console.log(`rowcount: ${q1.rowCount} (expect 0)`);
  console.table(q1.rows);

  // 2. Full Apr 23 roster, dispatch order. No `scope` column — using service_type.
  console.log("\n=== 2. Full Apr 23 roster (by scheduled_time) ===");
  const q2 = await db.execute(sql`
    SELECT
      j.id,
      j.mc_job_id,
      j.scheduled_time,
      j.base_fee::text AS base_fee,
      j.allowed_hours::text AS allowed_hours,
      j.status::text AS status,
      COALESCE(c.first_name || ' ' || c.last_name, '(no client)') AS client_name,
      j.service_type::text AS service_type,
      ARRAY(
        SELECT u.first_name || ' ' || u.last_name
          FROM job_technicians jt
          JOIN users u ON u.id = jt.user_id
         WHERE jt.job_id = j.id
         ORDER BY jt.is_primary DESC, jt.id
      ) AS techs
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
    ORDER BY j.scheduled_time NULLS LAST, j.id
  `);
  console.log(`rowcount: ${q2.rowCount} (expect 14)`);
  console.table(q2.rows);

  // 3. Any Apr 23 job with 11h duration or $845 fee that isn't 2081?
  console.log("\n=== 3. Any Apr 23 job with 11h duration OR $840-$850 fee? ===");
  const q3 = await db.execute(sql`
    SELECT j.id, j.mc_job_id, j.client_id,
           COALESCE(c.first_name || ' ' || c.last_name, '(no client)') AS client_name,
           j.scheduled_time, j.base_fee::text AS base_fee,
           j.allowed_hours::text AS allowed_hours,
           j.status::text AS status
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
       AND (j.allowed_hours::numeric = 11 OR j.base_fee::numeric BETWEEN 840 AND 850)
  `);
  console.log(`rowcount: ${q3.rowCount} (expect 0 — 2081 was the only $845 / 10.5h candidate)`);
  console.table(q3.rows);

  // 4. Any Apr 23 job assigned to Alejandra Cuervo (via assigned_user_id OR job_technicians)?
  console.log("\n=== 4. Any Apr 23 job assigned to Alejandra Cuervo? ===");
  const q4 = await db.execute(sql`
    SELECT j.id, j.mc_job_id, j.scheduled_time,
           j.base_fee::text AS base_fee,
           j.allowed_hours::text AS allowed_hours,
           c.first_name || ' ' || c.last_name AS client_name,
           'via_tech_table' AS via
      FROM jobs j
      JOIN job_technicians jt ON jt.job_id = j.id
      JOIN users u ON u.id = jt.user_id
      LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
       AND (u.first_name ILIKE 'alejandra%' OR u.last_name ILIKE 'cuervo%')
    UNION ALL
    SELECT j.id, j.mc_job_id, j.scheduled_time,
           j.base_fee::text AS base_fee,
           j.allowed_hours::text AS allowed_hours,
           c.first_name || ' ' || c.last_name AS client_name,
           'via_assigned_user_id' AS via
      FROM jobs j
      JOIN users u ON u.id = j.assigned_user_id
      LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
       AND (u.first_name ILIKE 'alejandra%' OR u.last_name ILIKE 'cuervo%')
    ORDER BY id, via
  `);
  console.log(`rowcount: ${q4.rowCount}`);
  console.table(q4.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
