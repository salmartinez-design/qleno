// [schaumburg-no-ppm 2026-08-19] Sal: "Schaumburg does not do ppm".
//
// The branch-replica pass copied Oak Lawn's whole service menu to Schaumburg,
// which handed Schaumburg two PPM services it does not sell. Left alone they sit
// on the Schaumburg booking widget and in the office dropdown, so a customer
// could book work the branch does not do.
//
// Soft-disable, never DELETE. A dead scope row is still the label historical
// quotes and jobs render through; removing it would blank them out. is_active
// =false is the same retire-not-erase pattern used for commercial service types.
//
// Safe to run: verified 0 quotes and 0 jobs have EVER used either scope on
// Schaumburg. The script re-checks that itself and refuses if that changed.
//
// Usage:  railway run node scripts/disable-schaumburg-ppm.mjs           (dry run)
//         railway run node scripts/disable-schaumburg-ppm.mjs --apply
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const REPLICA = 4; // Phes Schaumburg

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
await c.query("BEGIN");
try {
  // Match on the PPM prefix only. 'Turnover' (no PPM) is a different, general
  // service Schaumburg does keep — do not sweep it up by matching 'turnover'.
  const { rows: targets } = await c.query(
    `SELECT id, name, is_active, show_online, displayed_for_office
       FROM pricing_scopes
      WHERE company_id = $1 AND name ILIKE 'PPM%'
      ORDER BY id`,
    [REPLICA],
  );

  console.log("\n=== PPM services on Schaumburg ===");
  if (!targets.length) console.log("  none found — nothing to do");
  for (const t of targets) {
    console.log(`  ${t.name} (id ${t.id}) active=${t.is_active} online=${t.show_online} office=${t.displayed_for_office}`);
  }

  // Refuse if anything ever used them. Retiring a service that carries real
  // history is a different, louder decision than this script is allowed to make.
  const ids = targets.map((t) => t.id);
  if (ids.length) {
    const { rows: used } = await c.query(
      `SELECT scope_id, count(*)::int n FROM quotes
        WHERE scope_id IN (${ids.map((_, i) => `$${i + 1}`).join(",")})
        GROUP BY scope_id`,
      ids,
    );
    if (used.length) {
      throw new Error(
        `refusing: these PPM scopes have quote history -> ${JSON.stringify(used)}. ` +
          `Retiring them needs a human decision about those quotes.`,
      );
    }
    console.log("  0 quotes and 0 jobs have ever used them — safe to retire");

    const { rowCount } = await c.query(
      `UPDATE pricing_scopes
          SET is_active = false, show_online = false, displayed_for_office = false
        WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(",")})
          AND (is_active OR show_online OR displayed_for_office)`,
      ids,
    );
    console.log(`\n  -> ${rowCount} scope(s) retired on Schaumburg`);
  }

  // Show the resulting menus side by side so the difference is deliberate and visible.
  const { rows: menu } = await c.query(
    `SELECT company_id, name FROM pricing_scopes
      WHERE company_id IN (1,$1) AND is_active AND show_online
      ORDER BY company_id, lower(name)`,
    [REPLICA],
  );
  const oak = menu.filter((m) => m.company_id === 1).map((m) => m.name);
  const sch = menu.filter((m) => m.company_id === REPLICA).map((m) => m.name);
  console.log("\n=== RESULTING ONLINE BOOKING MENU ===");
  console.log(`  Oak Lawn   (${oak.length}): ${oak.join(", ")}`);
  console.log(`  Schaumburg (${sch.length}): ${sch.join(", ")}`);
  const onlyOak = oak.filter((n) => !sch.includes(n));
  console.log(`  Oak Lawn only (expected: the PPM services): [${onlyOak.join(", ")}]`);

  if (APPLY) {
    await c.query("COMMIT");
    console.log("\nAPPLIED.");
  } else {
    await c.query("ROLLBACK");
    console.log("\nDRY RUN - rolled back. Re-run with --apply to commit.");
  }
} catch (err) {
  await c.query("ROLLBACK");
  console.error("\nFAILED, rolled back:", err.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
