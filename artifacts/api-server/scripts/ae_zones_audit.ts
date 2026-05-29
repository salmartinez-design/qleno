/**
 * AE — Read-only audit of service_zones before adding "North Shore".
 * No writes. Reports: column names, PHES zones, color collisions vs
 * #00B8A9, Oak Lawn branch id, zip-coverage conflicts (60062 etc.
 * shouldn't already belong to another zone).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const PROPOSED_NAME = "North Shore";
const PROPOSED_COLOR = "#00B8A9";
const PROPOSED_ZIPS = ["60062","60025","60026","60091","60093","60015","60035"];

async function main() {
  console.log("=== AE — service_zones audit (pre-write, read-only) ===\n");

  // 1. service_zones column schema — SPEC says `zips` but prior code uses `zip_codes`
  console.log("--- 1. service_zones columns ---");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'service_zones'
     ORDER BY ordinal_position
  `);
  console.table(cols.rows);

  // 2. Unique constraint on (company_id, name)? Needed for ON CONFLICT
  console.log("\n--- 2. service_zones unique constraints ---");
  const cons = await db.execute(sql`
    SELECT tc.constraint_name, tc.constraint_type,
           string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
     WHERE tc.table_schema = 'public' AND tc.table_name = 'service_zones'
       AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
     GROUP BY tc.constraint_name, tc.constraint_type
     ORDER BY tc.constraint_type
  `);
  console.table(cons.rows);

  // 3. All PHES zones (no branch_id column — location text field instead)
  console.log("\n--- 3. PHES service_zones (company_id=1) ---");
  const zones = await db.execute(sql`
    SELECT id, name, color, zip_codes, location, is_active, sort_order, created_at
      FROM service_zones
     WHERE company_id = 1
     ORDER BY sort_order, name
  `);
  console.table(zones.rows);

  // 4. Color collision check
  console.log(`\n--- 4. Color collision vs proposed ${PROPOSED_COLOR} ---`);
  const collide = await db.execute(sql`
    SELECT id, name, color
      FROM service_zones
     WHERE company_id = 1 AND UPPER(color) = UPPER(${PROPOSED_COLOR})
  `);
  if ((collide.rows as any[]).length === 0) {
    console.log(`✓ No existing PHES zone uses ${PROPOSED_COLOR}.`);
  } else {
    console.error(`✗ Color collision:`);
    console.table(collide.rows);
  }

  // 5. Zip-coverage conflict — proposed zips already in another zone?
  console.log(`\n--- 5. Proposed zip coverage — any already owned by another zone? ---`);
  const zipLit = sql.raw(`ARRAY[${PROPOSED_ZIPS.map(z => `'${z}'`).join(",")}]::text[]`);
  const zipConflict = await db.execute(sql`
    SELECT z.id, z.name, z.color, z.zip_codes,
           ARRAY(SELECT unnest(${zipLit}) INTERSECT SELECT unnest(z.zip_codes)) AS overlap
      FROM service_zones z
     WHERE z.company_id = 1
       AND z.zip_codes && ${zipLit}
  `);
  if ((zipConflict.rows as any[]).length === 0) {
    console.log(`✓ None of ${PROPOSED_ZIPS.join(", ")} overlap with existing zones.`);
  } else {
    console.log(`⚠ Zip overlap(s):`);
    console.table(zipConflict.rows);
  }

  // 6. Branches (for reference — service_zones doesn't actually have a branch FK)
  console.log("\n--- 6. PHES branches (not linked to service_zones but reporting for completeness) ---");
  const branches = await db.execute(sql`
    SELECT id, name, is_active FROM branches WHERE company_id = 1 ORDER BY id
  `);
  console.table(branches.rows);

  // 6b. Distinct location values used across existing zones
  console.log("\n--- 6b. Distinct `location` values currently used on service_zones ---");
  const locs = await db.execute(sql`
    SELECT location, COUNT(*)::int AS n
      FROM service_zones WHERE company_id = 1
     GROUP BY location ORDER BY n DESC
  `);
  console.table(locs.rows);

  // 7. Existing zone with name "North Shore" (would be target of ON CONFLICT — BUT
  //    no unique on (company_id, name) exists per constraint scan, so ON CONFLICT
  //    (company_id, name) WILL FAIL. Plain INSERT + pre-check path needed.)
  console.log("\n--- 7. Existing 'North Shore' row? ---");
  const existing = await db.execute(sql`
    SELECT id, name, color, zip_codes, location, is_active
      FROM service_zones
     WHERE company_id = 1 AND name = ${PROPOSED_NAME}
  `);
  if ((existing.rows as any[]).length === 0) {
    console.log("✓ No existing 'North Shore' row — INSERT path will fire.");
  } else {
    console.table(existing.rows);
  }

  // 8. Which clients are currently at the proposed zips? (impact scan)
  console.log("\n--- 8. PHES clients at proposed zips (zone will start coloring their cards) ---");
  const affected = await db.execute(sql`
    SELECT c.id, c.first_name || ' ' || c.last_name AS name, c.zip, c.is_active
      FROM clients c
     WHERE c.company_id = 1 AND c.zip = ANY(${zipLit})
     ORDER BY c.zip, c.id
  `);
  console.log(`  ${affected.rows.length} client(s) at proposed zips:`);
  console.table(affected.rows);

  // 9. Same scan at the job level — any upcoming jobs whose address_zip is in the proposed list?
  console.log("\n--- 9. Upcoming jobs with jobs.address_zip in proposed set ---");
  const affectedJobs = await db.execute(sql`
    SELECT j.id, j.scheduled_date, j.scheduled_time, j.address_street, j.address_zip,
           c.first_name || ' ' || c.last_name AS client
      FROM jobs j JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = 1 AND j.address_zip = ANY(${zipLit})
       AND j.scheduled_date >= CURRENT_DATE
     ORDER BY j.scheduled_date, j.scheduled_time
  `);
  console.table(affectedJobs.rows);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
