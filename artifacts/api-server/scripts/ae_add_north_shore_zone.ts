/**
 * AE — Add PHES "North Shore" service_zone. Data-only write.
 *
 * Spec divergences already reviewed with Sal:
 *   - column is `zip_codes` (not `zips`)
 *   - service_zones has no `branch_id`; uses `location text` ('oak_lawn' | 'schaumburg')
 *   - no UNIQUE (company_id, name) constraint → WHERE NOT EXISTS guard instead of ON CONFLICT
 *   - no `updated_at` column; `created_at` is NOT NULL
 *
 * Idempotent: re-running with the row already in place returns rowcount 0
 * (NOT EXISTS blocks) — transaction still commits (no-op). Rowcount gate
 * enforces "expect 1 on first run, 0 on re-run".
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const NAME = "North Shore";
const COLOR = "#00B8A9";
const ZIPS = ["60062","60025","60026","60091","60093","60015","60035"];
const LOCATION = "oak_lawn";
const SORT_ORDER = 19;

async function main() {
  console.log("=== AE — Add service_zone 'North Shore' ===\n");

  // Pre-check
  console.log("--- Pre-write: does 'North Shore' already exist? ---");
  const pre = await db.execute(sql`
    SELECT id, name, color, zip_codes, location, sort_order
      FROM service_zones WHERE company_id = 1 AND name = ${NAME}
  `);
  console.table(pre.rows);
  const alreadyExists = (pre.rows as any[]).length > 0;
  if (alreadyExists) {
    console.log("⚠ Row exists — INSERT will no-op (expected rowcount 0).");
  } else {
    console.log("✓ Clean insert path.");
  }

  // Transaction
  console.log("\n--- INSERT transaction ---");
  await db.execute(sql`BEGIN`);
  try {
    const zipLit = sql.raw(`ARRAY[${ZIPS.map(z => `'${z}'`).join(",")}]::text[]`);
    const res = await db.execute(sql`
      INSERT INTO service_zones
        (company_id, name, color, zip_codes, location, is_active, sort_order, created_at)
      SELECT 1,
             ${NAME},
             ${COLOR},
             ${zipLit},
             ${LOCATION},
             true,
             ${SORT_ORDER},
             NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM service_zones WHERE company_id = 1 AND name = ${NAME}
       )
      RETURNING id, name, color, zip_codes, location, is_active, sort_order, created_at
    `);
    const n = res.rowCount ?? 0;
    console.log(`INSERT rowcount: ${n} (expected ${alreadyExists ? 0 : 1})`);
    if (n !== (alreadyExists ? 0 : 1)) {
      throw new Error(`rowcount mismatch: got ${n}, expected ${alreadyExists ? 0 : 1}`);
    }
    if (n === 1) {
      console.log("Inserted row:");
      console.table(res.rows);
    }

    await db.execute(sql`COMMIT`);
    console.log("\n--- COMMIT OK ---");
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.error("\n--- ROLLBACK ---");
    console.error(err);
    process.exit(1);
  }

  // Post-commit verification — zone resolves + Shannon's job picks it up.
  console.log("\n=== Post-commit verification ===");

  console.log("\n1. North Shore zone present + contains 60062:");
  const zoneRow = await db.execute(sql`
    SELECT id, name, color, zip_codes, location, is_active
      FROM service_zones
     WHERE company_id = 1 AND '60062' = ANY(zip_codes)
  `);
  console.table(zoneRow.rows);

  console.log("\n2. Shannon's Apr 23 job resolves to North Shore via job-level zip:");
  const shannon = await db.execute(sql`
    SELECT j.id, j.scheduled_date, j.scheduled_time,
           j.address_street, j.address_zip,
           c.zip AS client_zip,
           COALESCE(NULLIF(j.address_zip, ''), c.zip) AS resolved_zip,
           (SELECT name  FROM service_zones sz
              WHERE sz.company_id = 1 AND sz.is_active = true
                AND COALESCE(NULLIF(j.address_zip, ''), c.zip) = ANY(sz.zip_codes) LIMIT 1) AS zone_name,
           (SELECT color FROM service_zones sz
              WHERE sz.company_id = 1 AND sz.is_active = true
                AND COALESCE(NULLIF(j.address_zip, ''), c.zip) = ANY(sz.zip_codes) LIMIT 1) AS zone_color
      FROM jobs j JOIN clients c ON c.id = j.client_id
     WHERE j.id = 4231
  `);
  console.table(shannon.rows);

  const s = (shannon.rows as any[])[0];
  const pass = s?.resolved_zip === "60062" && s?.zone_name === "North Shore" && s?.zone_color === "#00B8A9";
  console.log(`\nExpected: resolved_zip=60062, zone_name='North Shore', zone_color='#00B8A9'`);
  console.log(pass ? "✓ PASS" : "✗ FAIL — see row above.");

  console.log("\n3. Apr 23 dispatch snapshot (all 14 cards, with zone resolution):");
  const apr23 = await db.execute(sql`
    SELECT c.id AS client_id, c.first_name || ' ' || c.last_name AS name,
           COALESCE(NULLIF(j.address_zip, ''), c.zip) AS resolved_zip,
           (SELECT name FROM service_zones sz
              WHERE sz.company_id = 1 AND sz.is_active = true
                AND COALESCE(NULLIF(j.address_zip, ''), c.zip) = ANY(sz.zip_codes) LIMIT 1) AS zone_name,
           (SELECT color FROM service_zones sz
              WHERE sz.company_id = 1 AND sz.is_active = true
                AND COALESCE(NULLIF(j.address_zip, ''), c.zip) = ANY(sz.zip_codes) LIMIT 1) AS zone_color
      FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
     ORDER BY c.id
  `);
  console.table(apr23.rows);

  process.exit(pass ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
