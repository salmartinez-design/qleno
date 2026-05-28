/**
 * AC — Manual zip backfill for the 6 PHES clients Nominatim failed on.
 * Uses Sal's confidence list. Executes UPDATE in a transaction and then
 * VERIFIES each row resolves to an active service_zone. If ANY of the 6
 * does NOT resolve to a zone (null zone_name), ROLLBACK and report — no
 * partial commits.
 *
 * Manual list (from _commit_AA.md next-steps):
 *   46, 61  Kristofer/Kriztofer Bz  → 60457  (Hickory Hills)
 *   49      Michael Baffoe          → 60455  (Bridgeview, near Oak Lawn)
 *   86      Jalinia Logan           → 60707  (Elmwood Park area)
 *   110     John Piscopo            → 60707  (Elmwood Park)
 *   1052    Danni Varenhorst        → 60608  (Chicago, S Halsted)
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

type Backfill = { id: number; zip: string; note: string };
const BACKFILLS: Backfill[] = [
  { id: 46,   zip: "60457", note: "Kristofer Bz / Hickory Hills" },
  { id: 61,   zip: "60457", note: "Kriztofer Bz / Hickory Hills" },
  { id: 49,   zip: "60455", note: "Michael Baffoe / Bridgeview" },
  { id: 86,   zip: "60707", note: "Jalinia Logan / Elmwood Park" },
  { id: 110,  zip: "60707", note: "John Piscopo / Elmwood Park" },
  { id: 1052, zip: "60608", note: "Danni Varenhorst / Chicago S Halsted" },
];

async function main() {
  console.log("=== AC — Manual zip backfill ===\n");

  // Pre-flight: confirm each target zip resolves to an active zone.
  // (Do this BEFORE touching rows so we fail fast if a zip is unmapped.)
  console.log("--- Pre-flight: zone resolution for proposed zips ---");
  const zipsToCheck = Array.from(new Set(BACKFILLS.map(b => b.zip)));
  const zipZoneRows = await db.execute(sql`
    SELECT z.zip AS zip, sz.name, sz.color
      FROM (VALUES ${sql.raw(zipsToCheck.map(z => `('${z}')`).join(","))}) AS z(zip)
      LEFT JOIN service_zones sz
        ON sz.company_id = 1 AND sz.is_active = true AND sz.zip_codes @> ARRAY[z.zip]
  `);
  console.table(zipZoneRows.rows);

  const unmappedZips = (zipZoneRows.rows as any[]).filter(r => !r.name).map(r => r.zip);
  if (unmappedZips.length > 0) {
    console.error(`\n✗ Zips with no matching service_zones row: ${unmappedZips.join(", ")}`);
    console.error("Aborting — fix zones before running backfill.");
    process.exit(1);
  }
  console.log("✓ All proposed zips resolve to active service_zones.\n");

  // Snapshot current state (for audit).
  console.log("--- Pre-update state ---");
  const ids = BACKFILLS.map(b => b.id);
  const pre = await db.execute(sql`
    SELECT id, first_name || ' ' || last_name AS name, zip, city, state
      FROM clients
     WHERE company_id = 1 AND id IN (${sql.raw(ids.join(","))})
     ORDER BY id
  `);
  console.table(pre.rows);

  // Run the UPDATE in a single transaction.
  console.log("--- UPDATE transaction ---");
  await db.execute(sql`BEGIN`);
  try {
    let rowsUpdated = 0;
    for (const b of BACKFILLS) {
      const res = await db.execute(sql`
        UPDATE clients
           SET zip = ${b.zip}
         WHERE id = ${b.id}
           AND company_id = 1
      `);
      const n = res.rowCount ?? 0;
      console.log(`  UPDATE id=${b.id} zip=${b.zip}  (${b.note})  → rowcount ${n}`);
      rowsUpdated += n;
    }
    console.log(`Total UPDATE rowcount: ${rowsUpdated} (expected ${BACKFILLS.length})`);
    if (rowsUpdated !== BACKFILLS.length) {
      throw new Error(`rowcount mismatch: got ${rowsUpdated}, expected ${BACKFILLS.length}`);
    }

    // Verify EACH row now resolves to a zone. If any fails → ROLLBACK.
    console.log("\n--- In-transaction zone verification ---");
    const verify = await db.execute(sql`
      SELECT c.id, c.first_name || ' ' || c.last_name AS name, c.zip,
             (SELECT name  FROM service_zones sz
               WHERE sz.company_id = 1 AND sz.is_active = true
                 AND sz.zip_codes @> ARRAY[c.zip] LIMIT 1) AS zone_name,
             (SELECT color FROM service_zones sz
               WHERE sz.company_id = 1 AND sz.is_active = true
                 AND sz.zip_codes @> ARRAY[c.zip] LIMIT 1) AS zone_color
        FROM clients c
       WHERE c.company_id = 1 AND c.id IN (${sql.raw(ids.join(","))})
       ORDER BY c.id
    `);
    console.table(verify.rows);

    const unresolved = (verify.rows as any[]).filter(r => !r.zone_name || !r.zone_color);
    if (unresolved.length > 0) {
      console.error(`\n✗ ${unresolved.length} row(s) did not resolve to a zone post-UPDATE:`);
      for (const r of unresolved) console.error(`   id=${r.id} ${r.name} zip=${r.zip}`);
      throw new Error("partial resolution — aborting before commit");
    }

    await db.execute(sql`COMMIT`);
    console.log("\n--- COMMIT OK — all 6 rows resolved to zones ---");
  } catch (err) {
    await db.execute(sql`ROLLBACK`);
    console.error("\n--- ROLLBACK ---");
    console.error(err);
    process.exit(1);
  }

  // Final post-commit snapshot for Apr 23 dispatch
  console.log("\n=== Apr 23 post-verify (all 14 dispatch clients) ===");
  const post = await db.execute(sql`
    SELECT DISTINCT c.id, c.first_name || ' ' || c.last_name AS name, c.zip,
           (SELECT name  FROM service_zones sz
             WHERE sz.company_id = 1 AND sz.is_active = true
               AND sz.zip_codes @> ARRAY[c.zip] LIMIT 1) AS zone_name,
           (SELECT color FROM service_zones sz
             WHERE sz.company_id = 1 AND sz.is_active = true
               AND sz.zip_codes @> ARRAY[c.zip] LIMIT 1) AS zone_color
      FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = 1 AND j.scheduled_date = '2026-04-23'
     ORDER BY c.id
  `);
  console.table(post.rows);
  const apr23Null = (post.rows as any[]).filter(r => !r.zone_name).length;
  console.log(`\nApr 23 cards without zone_color: ${apr23Null} / ${post.rows.length}`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
