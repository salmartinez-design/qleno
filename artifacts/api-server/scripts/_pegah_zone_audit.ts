import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

(async () => {
  console.log("=== Pegah Abbasian client record ===");
  const client = await db.execute(sql`
    SELECT id, first_name, last_name, address, city, state, zip, zone_id, lat, lng
    FROM clients
    WHERE company_id = 1 AND lower(first_name) LIKE '%pegah%'
  `);
  console.table(client.rows);

  console.log("\n=== Pegah's most recent job(s) ===");
  const jobs = await db.execute(sql`
    SELECT j.id, j.scheduled_date, j.scheduled_time, j.service_type, j.status,
           j.address_street, j.address_city, j.address_state, j.address_zip, j.zone_id,
           c.first_name, c.last_name, c.zip AS client_zip
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = 1
      AND lower(c.first_name) LIKE '%pegah%'
    ORDER BY j.scheduled_date DESC
    LIMIT 5
  `);
  console.table(jobs.rows);

  console.log("\n=== Service zones (zip arrays) ===");
  const zones = await db.execute(sql`
    SELECT id, name, color, is_active, zip_codes
    FROM service_zones
    WHERE company_id = 1
    ORDER BY name
  `);
  for (const z of zones.rows as any[]) {
    console.log(`  ${z.name} (${z.color}) [active=${z.is_active}]: ${(z.zip_codes ?? []).slice(0, 20).join(', ')}${(z.zip_codes ?? []).length > 20 ? '...' : ''}`);
  }

  console.log("\n=== Zip lookup: which zone (if any) covers Pegah's zip? ===");
  const c = client.rows[0] as any;
  if (c?.zip) {
    const match = await db.execute(sql`
      SELECT id, name, color, zip_codes
      FROM service_zones
      WHERE company_id = 1
        AND is_active = true
        AND ${c.zip} = ANY(zip_codes)
    `);
    console.log(`  Pegah's zip: ${c.zip}`);
    if (match.rows.length === 0) {
      console.log(`  → NO ZONE COVERS THIS ZIP`);
    } else {
      console.log(`  → matched zone: ${(match.rows[0] as any).name} (${(match.rows[0] as any).color})`);
    }
  } else {
    console.log("  → Pegah's clients.zip is NULL");
  }

  await pool.end();
})();
