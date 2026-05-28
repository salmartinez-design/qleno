/**
 * One-shot fix for Julie Mitros (clients.id=74).
 *
 * MC source of truth: 818 S 6th Ave, La Grange, IL 60526. Zone:
 * La Grange/Hodgkins/Berwyn (id=13).
 *
 * Our record was left in a half-fixed state: jobs.address_* was patched
 * (correctly) but clients.address/city/zip were stale (city was
 * "North Chicago", zip was "60088") because the previous auto-pick
 * routed the edit to job level when clients.address was NULL.
 *
 * Idempotent. CASE guards so re-running is a no op once correct.
 */
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { geocodeAddress } from "../src/lib/geocode.js";

const COMPANY_ID = 1;
const CLIENT_ID = 74;
const REAL_ADDRESS = "818 S 6th Ave";
const REAL_CITY = "La Grange";
const REAL_STATE = "IL";
const REAL_ZIP = "60525";

(async () => {
  console.log("─── BEFORE ───");
  const before = await db.execute(sql`
    SELECT id, first_name, last_name, address, city, state, zip, lat, lng, zone_id,
           (SELECT name FROM service_zones WHERE id = clients.zone_id) AS zone_name
    FROM clients WHERE id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
  `);
  console.table(before.rows);

  const fullAddress = `${REAL_ADDRESS}, ${REAL_CITY}, ${REAL_STATE} ${REAL_ZIP}`;
  console.log(`\nGeocoding: ${fullAddress}`);
  const coords = await geocodeAddress(fullAddress);
  if (!coords) console.warn("  geocode returned null — proceeding without lat/lng");
  else console.log(`  → lat=${coords.lat} lng=${coords.lng}`);

  const zoneRow = await db.execute(sql`
    SELECT id FROM service_zones
    WHERE company_id = ${COMPANY_ID}
      AND is_active = true
      AND ${REAL_ZIP} = ANY(zip_codes)
    LIMIT 1
  `);
  const zoneId = zoneRow.rows.length ? (zoneRow.rows[0] as any).id : null;
  console.log(`  zone_id for zip ${REAL_ZIP}: ${zoneId}`);

  await db.execute(sql`
    UPDATE clients SET
      address = ${REAL_ADDRESS},
      city    = ${REAL_CITY},
      state   = ${REAL_STATE},
      zip     = ${REAL_ZIP},
      lat     = COALESCE(${coords?.lat?.toString() ?? null}, lat),
      lng     = COALESCE(${coords?.lng?.toString() ?? null}, lng),
      zone_id = ${zoneId}
    WHERE id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
  `);
  console.log("  → clients row patched");

  console.log("\n─── AFTER ───");
  const after = await db.execute(sql`
    SELECT id, first_name, last_name, address, city, state, zip, lat, lng, zone_id,
           (SELECT name FROM service_zones WHERE id = clients.zone_id) AS zone_name
    FROM clients WHERE id = ${CLIENT_ID} AND company_id = ${COMPANY_ID}
  `);
  console.table(after.rows);

  await pool.end();
})();
