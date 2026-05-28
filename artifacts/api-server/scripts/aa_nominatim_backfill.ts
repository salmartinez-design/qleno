/**
 * AA — Backfill clients.zip via OpenStreetMap Nominatim for PHES clients
 * with NULL zip who have a street address. (The configured
 * GOOGLE_MAPS_API_KEY is a browser key with HTTP-referer restrictions
 * and can't be used for server-side Geocoding API calls.)
 *
 * Rate limit: Nominatim is 1 req/sec max per their usage policy. We pace
 * at ~1.2s between calls. Sets User-Agent per their requirement.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const UA = "qleno-dispatch-backfill/1.0 (sal@phes.io)";

type GeocodeResult = {
  postal_code?: string;
  city?: string;
  state?: string;
};

async function geocode(streetAddr: string): Promise<GeocodeResult | null> {
  const q = encodeURIComponent(streetAddr.trim() + ", Chicago, IL");
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&addressdetails=1&limit=1&countrycodes=us`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const arr = await r.json() as any[];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const a = arr[0].address || {};
    if (!a.postcode) return null;
    return {
      postal_code: String(a.postcode).slice(0, 5), // only US 5-digit
      city: a.city || a.town || a.village || a.suburb || null,
      state: a.state ? (a["ISO3166-2-lvl4"] ? String(a["ISO3166-2-lvl4"]).replace("US-", "") : null) : null,
    };
  } catch (e) {
    console.error(`geocode error for "${streetAddr}":`, e);
    return null;
  }
}

async function main() {
  console.log("=== AA — Nominatim zip backfill ===\n");

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
  console.log(`Candidates: ${list.length} PHES clients\n`);

  const backfills: Array<{
    id: number;
    name: string;
    address: string;
    zip: string;
    city: string | null;
    state: string | null;
  }> = [];

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    process.stdout.write(`  [${i + 1}/${list.length}] [${c.id}] ${String(c.name).slice(0, 35).padEnd(35)} "${String(c.resolved_address).slice(0, 35)}" → `);
    const g = await geocode(c.resolved_address);
    if (!g?.postal_code) {
      console.log("NO ZIP");
      await new Promise(r => setTimeout(r, 1200));
      continue;
    }
    console.log(`${g.postal_code}  ${g.city ?? ""} ${g.state ?? ""}`);
    backfills.push({
      id: c.id,
      name: c.name,
      address: c.resolved_address,
      zip: g.postal_code,
      city: c.current_city ? null : (g.city ?? null),
      state: c.current_state ? null : (g.state ?? null),
    });
    await new Promise(r => setTimeout(r, 1200)); // Nominatim rate limit
  }

  console.log(`\nGeocode found zips for ${backfills.length} / ${list.length} clients.\n`);
  if (backfills.length === 0) {
    console.log("Nothing to UPDATE. Exiting.");
    process.exit(0);
  }

  // Transaction
  console.log("=== UPDATE transaction ===");
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
    console.log(`UPDATE rowcount: ${updated} (expected ${backfills.length})`);
    if (updated !== backfills.length) {
      throw new Error(`rowcount mismatch: got ${updated}, expected ${backfills.length}`);
    }
    await db.execute(sql`COMMIT`);
    console.log("--- COMMIT OK ---");
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.error("--- ROLLBACK ---");
    throw err;
  }

  // Verify Apr 23 coverage
  console.log("\n=== Apr 23 post-verify ===");
  const post = await db.execute(sql`
    SELECT DISTINCT
      c.id,
      c.first_name || ' ' || c.last_name AS name,
      c.zip,
      (SELECT z.name FROM service_zones z
         WHERE z.company_id = 1 AND z.is_active = true
           AND c.zip = ANY(z.zip_codes) LIMIT 1) AS zone_name,
      (SELECT z.color FROM service_zones z
         WHERE z.company_id = 1 AND z.is_active = true
           AND c.zip = ANY(z.zip_codes) LIMIT 1) AS zone_color
    FROM jobs j
    LEFT JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
    ORDER BY c.id
  `);
  console.table(post.rows);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
