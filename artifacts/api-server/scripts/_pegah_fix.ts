/**
 * One-shot fix for Pegah Abbasian (clients.id=125) and the
 * Westmont/Lombard/Elmhurst zone.
 *
 * Source of truth: MaidCentral record (Job ID 61563726) shows:
 *   address: 28262 Diehl Road
 *   city:    Warrenville
 *   state:   IL
 *   zip:     60555
 *   zone:    Westmont|Lombard|Elmhurst
 *
 * Our import wrote the street number "28262" into clients.zip, leaving city
 * and zip wrong. Plus our Westmont/Lombard/Elmhurst zone does not include
 * 60555 in its zip_codes[] array (MC does). Fix both, idempotent.
 *
 * Steps:
 *   1. Add 60555 to service_zones.zip_codes for Westmont/Lombard/Elmhurst
 *      (idempotent: array_append only if missing).
 *   2. Patch clients.id=125: city='Warrenville', zip='60555' (only when
 *      currently null/wrong), geocode lat/lng via the existing helper.
 *   3. Resolve clients.zone_id from the now-correct zip.
 *   4. Print before/after for verification.
 */
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { geocodeAddress } from "../src/lib/geocode.js";

const COMPANY_ID = 1;
const PEGAH_CLIENT_ID = 125;
const ZONE_NAME = "Westmont/Lombard/Elmhurst";
const NEW_ZIP = "60555";
const REAL_CITY = "Warrenville";
const REAL_STATE = "IL";
const REAL_ADDRESS = "28262 Diehl Road";

(async () => {
  console.log("─── BEFORE ───");
  const beforeClient = await db.execute(sql`
    SELECT id, first_name, last_name, address, city, state, zip, lat, lng, zone_id
    FROM clients WHERE id = ${PEGAH_CLIENT_ID} AND company_id = ${COMPANY_ID}
  `);
  console.table(beforeClient.rows);

  const beforeZone = await db.execute(sql`
    SELECT id, name, color, zip_codes FROM service_zones
    WHERE company_id = ${COMPANY_ID} AND name = ${ZONE_NAME}
  `);
  if (!beforeZone.rows.length) {
    console.error(`ABORT: zone "${ZONE_NAME}" not found for company ${COMPANY_ID}`);
    await pool.end();
    process.exit(1);
  }
  const zoneRow = beforeZone.rows[0] as any;
  console.log(`Zone "${ZONE_NAME}" (id=${zoneRow.id}, color=${zoneRow.color})`);
  console.log(`  zip_codes before: ${(zoneRow.zip_codes ?? []).join(", ")}`);

  // ── 1. Extend the zone to include 60555 (idempotent) ──────────────────────
  if ((zoneRow.zip_codes ?? []).includes(NEW_ZIP)) {
    console.log(`  zip_codes already contains ${NEW_ZIP} — skipping`);
  } else {
    await db.execute(sql`
      UPDATE service_zones
      SET zip_codes = array_append(zip_codes, ${NEW_ZIP})
      WHERE id = ${zoneRow.id} AND NOT (${NEW_ZIP} = ANY(zip_codes))
    `);
    console.log(`  → appended ${NEW_ZIP}`);
  }

  // ── 2. Geocode the real address ────────────────────────────────────────────
  const fullAddress = `${REAL_ADDRESS}, ${REAL_CITY}, ${REAL_STATE} ${NEW_ZIP}`;
  console.log(`\nGeocoding: ${fullAddress}`);
  const coords = await geocodeAddress(fullAddress);
  if (!coords) {
    console.warn("  geocode returned null — proceeding without lat/lng");
  } else {
    console.log(`  → lat=${coords.lat} lng=${coords.lng}`);
  }

  // ── 3. Patch Pegah's client record ─────────────────────────────────────────
  // Use CASE guards so re-running is idempotent and we never overwrite manual
  // corrections that may have already happened in the UI.
  const before = beforeClient.rows[0] as any;
  const cityNeedsFix = !before.city || before.city.trim() === "";
  const zipNeedsFix = !before.zip || before.zip === "28262" || before.zip !== NEW_ZIP;
  const stateNeedsFix = !before.state || before.state.trim() === "";

  if (cityNeedsFix || zipNeedsFix || stateNeedsFix || (coords && (!before.lat || !before.lng))) {
    await db.execute(sql`
      UPDATE clients SET
        city  = CASE WHEN city IS NULL OR city = '' THEN ${REAL_CITY} ELSE city END,
        state = CASE WHEN state IS NULL OR state = '' THEN ${REAL_STATE} ELSE state END,
        zip   = CASE WHEN zip IS NULL OR zip = '' OR zip = '28262' THEN ${NEW_ZIP} ELSE zip END,
        lat   = CASE WHEN lat IS NULL AND ${coords?.lat ?? null}::numeric IS NOT NULL THEN ${coords?.lat ?? null}::numeric ELSE lat END,
        lng   = CASE WHEN lng IS NULL AND ${coords?.lng ?? null}::numeric IS NOT NULL THEN ${coords?.lng ?? null}::numeric ELSE lng END
      WHERE id = ${PEGAH_CLIENT_ID} AND company_id = ${COMPANY_ID}
    `);
    console.log("  → clients row patched");
  } else {
    console.log("  clients row already correct — skipping");
  }

  // ── 4. Resolve and persist zone_id ─────────────────────────────────────────
  const zoneMatch = await db.execute(sql`
    SELECT id FROM service_zones
    WHERE company_id = ${COMPANY_ID}
      AND is_active = true
      AND ${NEW_ZIP} = ANY(zip_codes)
    LIMIT 1
  `);
  if (zoneMatch.rows.length) {
    const newZoneId = (zoneMatch.rows[0] as any).id;
    await db.execute(sql`
      UPDATE clients SET zone_id = ${newZoneId}
      WHERE id = ${PEGAH_CLIENT_ID} AND company_id = ${COMPANY_ID}
    `);
    console.log(`  → clients.zone_id = ${newZoneId}`);
  } else {
    console.warn(`  no zone found containing zip ${NEW_ZIP} — zone_id unchanged`);
  }

  console.log("\n─── AFTER ───");
  const after = await db.execute(sql`
    SELECT c.id, c.first_name, c.last_name, c.address, c.city, c.state, c.zip,
           c.lat, c.lng, c.zone_id, sz.name AS zone_name, sz.color AS zone_color
    FROM clients c
    LEFT JOIN service_zones sz ON sz.id = c.zone_id
    WHERE c.id = ${PEGAH_CLIENT_ID} AND c.company_id = ${COMPANY_ID}
  `);
  console.table(after.rows);

  const afterZone = await db.execute(sql`
    SELECT zip_codes FROM service_zones WHERE id = ${zoneRow.id}
  `);
  console.log(`Zone "${ZONE_NAME}" zip_codes after: ${(afterZone.rows[0] as any).zip_codes.join(", ")}`);

  await pool.end();
})();
