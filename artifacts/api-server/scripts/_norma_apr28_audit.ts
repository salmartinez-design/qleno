import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

(async () => {
  console.log("=== Norma Puga's user record ===");
  const norma = await db.execute(sql`
    SELECT id, first_name, last_name, role, branch_id, is_active
    FROM users
    WHERE company_id = 1
      AND lower(first_name) = 'norma'
      AND lower(last_name) IN ('puga', 'guerrero puga', 'guerrero-puga')
  `);
  console.table(norma.rows);

  const normaIds = (norma.rows as any[]).map(r => r.id);
  console.log(`Norma user_ids: ${normaIds.join(', ')}`);

  console.log("\n=== Norma's jobs scheduled for 2026-04-28 ===");
  const jobs = await db.execute(sql`
    SELECT j.id, j.scheduled_date, j.scheduled_time, j.allowed_hours,
           j.service_type, j.status, j.frequency,
           j.client_id, j.assigned_user_id, j.zone_id, j.base_fee,
           j.address_street, j.address_zip, j.recurring_schedule_id,
           c.first_name, c.last_name, c.zip AS client_zip,
           sz.name AS zone_name, sz.color AS zone_color
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    LEFT JOIN service_zones sz ON sz.id = j.zone_id
    WHERE j.company_id = 1
      AND j.scheduled_date = '2026-04-28'
      AND j.assigned_user_id = 32
    ORDER BY j.scheduled_time
  `);
  console.table(jobs.rows);

  console.log("\n=== Julie Mitros client record (post-fix?) ===");
  const julie = await db.execute(sql`
    SELECT id, first_name, last_name, address, city, state, zip, lat, lng, zone_id,
           (SELECT name FROM service_zones WHERE id = clients.zone_id) AS zone_name
    FROM clients
    WHERE company_id = 1 AND lower(first_name) LIKE '%julie%' AND lower(last_name) LIKE '%mitros%'
  `);
  console.table(julie.rows);

  console.log("\n=== Robert Stortz client record ===");
  const robert = await db.execute(sql`
    SELECT id, first_name, last_name, address, city, state, zip, lat, lng, zone_id,
           (SELECT name FROM service_zones WHERE id = clients.zone_id) AS zone_name
    FROM clients
    WHERE company_id = 1 AND lower(first_name) LIKE '%robert%' AND lower(last_name) LIKE '%stortz%'
  `);
  console.table(robert.rows);

  console.log("\n=== Audit log entries from the last 24h ===");
  const audit = await db.execute(sql`
    SELECT id, performed_at, performed_by, action, target_type, target_id,
           old_value::text AS ov, new_value::text AS nv
    FROM app_audit_log
    WHERE company_id = 1
      AND performed_at > now() - interval '24 hours'
      AND (action LIKE '%ADDRESS%' OR action LIKE '%TECH%' OR action = 'UPDATE')
    ORDER BY performed_at DESC
    LIMIT 10
  `);
  for (const r of audit.rows as any[]) {
    console.log(`  ${r.performed_at} ${r.action} ${r.target_type}#${r.target_id} by user ${r.performed_by}`);
  }

  // Skipping job_audit_log query — schema drift on created_at column.

  await pool.end();
})();
