/**
 * AA — Backfill clients.zip via Google Maps Geocoding API for PHES clients
 * with NULL zip who have a street address on file (either clients.address
 * or the most recent jobs.address_street for that client).
 *
 * Strategy:
 *   1. Pull PHES clients with zip IS NULL AND has some street address.
 *   2. Geocode via Maps API with "Chicago, IL" region bias.
 *   3. Extract postal_code from address_components.
 *   4. If found, UPDATE clients.zip (and city/state if missing).
 *   5. Single transaction at the end with rowcount gate.
 *
 * Designed to be safe for re-runs — WHERE zip IS NULL prevents overwriting
 * any existing values.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!API_KEY) {
  console.error("GOOGLE_MAPS_API_KEY not set in env");
  process.exit(1);
}

type GeocodeResult = {
  postal_code?: string;
  city?: string;
  state?: string;
};

async function geocode(streetAddr: string): Promise<GeocodeResult | null> {
  // Bias toward Chicagoland since PHES service area is there.
  const q = encodeURIComponent(streetAddr.trim() + ", Chicago, IL");
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&region=us&key=${API_KEY}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const json = await r.json() as any;
    if (json.status !== "OK" || !Array.isArray(json.results) || json.results.length === 0) return null;
    const comps = json.results[0].address_components as Array<{ long_name: string; short_name: string; types: string[] }>;
    const result: GeocodeResult = {};
    for (const c of comps) {
      if (c.types.includes("postal_code")) result.postal_code = c.short_name;
      if (c.types.includes("locality")) result.city = c.long_name;
      if (c.types.includes("administrative_area_level_1")) result.state = c.short_name;
    }
    return result.postal_code ? result : null;
  } catch (e) {
    console.error(`geocode error for "${streetAddr}":`, e);
    return null;
  }
}

async function main() {
  console.log("=== AA — Geocode zip backfill (Google Maps) ===\n");

  // Pull candidates: PHES clients with NULL zip who appear in upcoming jobs
  // AND have some street address available (prefer clients.address, fall
  // back to most recent jobs.address_street).
  const candidates = await db.execute(sql`
    SELECT
      c.id,
      c.first_name || ' ' || c.last_name AS name,
      COALESCE(
        NULLIF(TRIM(c.address), ''),
        (SELECT j.address_street FROM jobs j
          WHERE j.client_id = c.id AND j.company_id = 1
            AND TRIM(COALESCE(j.address_street,'')) != ''
          ORDER BY j.created_at DESC LIMIT 1)
      ) AS resolved_address,
      c.city AS current_city,
      c.state AS current_state
    FROM clients c
    WHERE c.company_id = 1
      AND (c.zip IS NULL OR TRIM(c.zip) = '')
      AND EXISTS (
        SELECT 1 FROM jobs j
         WHERE j.client_id = c.id AND j.company_id = 1
           AND j.scheduled_date >= '2026-04-01'
      )
    ORDER BY c.id
  `);

  const list = (candidates.rows as any[]).filter(c => c.resolved_address);
  console.log(`Candidates: ${list.length} PHES clients with NULL zip + upcoming jobs + an address`);

  const backfills: Array<{
    id: number;
    name: string;
    address: string;
    zip: string;
    city: string | null;
    state: string | null;
  }> = [];

  for (const c of list) {
    process.stdout.write(`  [${c.id}] ${c.name.slice(0, 40).padEnd(40)} "${c.resolved_address.slice(0, 40)}" → `);
    const g = await geocode(c.resolved_address);
    if (!g?.postal_code) {
      console.log("NO ZIP FOUND");
      continue;
    }
    console.log(`${g.postal_code}  (${g.city ?? "?"}, ${g.state ?? "?"})`);
    backfills.push({
      id: c.id,
      name: c.name,
      address: c.resolved_address,
      zip: g.postal_code,
      city: c.current_city ? null : (g.city ?? null),   // only set if currently null
      state: c.current_state ? null : (g.state ?? null),
    });
    // Small delay to stay friendly with Google's rate limits
    await new Promise(r => setTimeout(r, 60));
  }

  console.log(`\nFound zips for ${backfills.length} / ${list.length} clients.`);

  if (backfills.length === 0) {
    console.log("Nothing to UPDATE. Exiting.");
    process.exit(0);
  }

  // --- Transaction ---
  console.log("\n=== UPDATE transaction ===");
  await db.execute(sql`BEGIN`);
  try {
    let updated = 0;
    for (const b of backfills) {
      const res = await db.execute(sql`
        UPDATE clients
           SET zip = ${b.zip},
               city = COALESCE(city, ${b.city}),
               state = COALESCE(state, ${b.state})
         WHERE id = ${b.id}
           AND company_id = 1
           AND (zip IS NULL OR TRIM(zip) = '')
      `);
      updated += res.rowCount ?? 0;
    }
    console.log(`UPDATE rowcount: ${updated} / ${backfills.length} expected`);
    if (updated !== backfills.length) {
      throw new Error(`rowcount mismatch: got ${updated}, expected ${backfills.length}`);
    }
    await db.execute(sql`COMMIT`);
    console.log("--- COMMIT OK ---");
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.error("--- ROLLBACK ---");
    console.error(err);
    process.exit(1);
  }

  // Post-verify: which Apr 23 clients now have resolvable zones?
  console.log("\n=== Apr 23 post-verify ===");
  const post = await db.execute(sql`
    SELECT DISTINCT
      c.id,
      c.first_name || ' ' || c.last_name AS name,
      c.zip,
      (SELECT z.name FROM service_zones z
         WHERE z.company_id = 1 AND z.is_active = true
           AND c.zip = ANY(z.zip_codes) LIMIT 1) AS derived_zone,
      (SELECT z.color FROM service_zones z
         WHERE z.company_id = 1 AND z.is_active = true
           AND c.zip = ANY(z.zip_codes) LIMIT 1) AS derived_color
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
    ORDER BY c.id
  `);
  console.table(post.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
