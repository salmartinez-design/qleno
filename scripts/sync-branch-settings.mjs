// [branch-settings-sync 2026-08-19] Make Phes Schaumburg (co4) a replica of
// Phes Oak Lawn (co1) for tenant SETTINGS.
//
// Sal: "Both locations have to have the exact same setup ... They should be a
// replica of each other when it comes to settings." Oak Lawn is the master.
//
// Deliberately NOT a boot migration. A sweep that re-creates rows on every cold
// start is exactly what resurrected 55 deleted visits in the June-fill incident
// — if the office later retires a scope on Schaumburg, a boot-path copy would
// silently bring it back. This runs once, by hand, and reports what it did.
//
// Two things it will NOT touch, because they are prices rather than settings:
//   1. hourly_rate / minimum_bill on a scope co4 ALREADY has. Schaumburg's
//      pricing is deliberately its own and must not inherit Oak Lawn's.
//   2. pricing_method on a scope co4 already has. Flipping sqft -> hourly
//      orphans that scope's pricing tiers and changes what customers are
//      charged. Mismatches are REPORTED for a human decision instead.
// Scopes co4 does not have yet carry Oak Lawn's rate as their starting value,
// since there is no Schaumburg price to preserve.
//
// Usage:  railway run node scripts/sync-branch-settings.mjs           (dry run)
//         railway run node scripts/sync-branch-settings.mjs --apply
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const MASTER = 1; // Phes (Oak Lawn)
const REPLICA = 4; // Phes Schaumburg

// The company-level settings that must match. Money-per-branch columns
// (commercial_hourly_rate, res_tech_pay_pct, ...) already agree and are not
// listed — this is the set that actually diverged.
const SETTINGS = [
  "recurring_engine_enabled",
  "sms_arrived_enabled",
  "geofence_soft_mode",
  "overhead_rate_pct",
];

// What "the same service menu" means: is it offered, is it on the website, is
// it in the office dropdown, and where does it sit in the list.
const FLAGS = ["is_active", "show_online", "displayed_for_office", "sort_order"];

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const key = (s) => s.trim().toLowerCase();
const log = (...a) => console.log(...a);
const changes = [];

await c.query("BEGIN");
try {
  // ── 1. Company settings ────────────────────────────────────────────────────
  const cols = SETTINGS.map((s) => `"${s}"`).join(",");
  const { rows: co } = await c.query(
    `SELECT id,${cols} FROM companies WHERE id IN ($1,$2)`,
    [MASTER, REPLICA],
  );
  const m = co.find((r) => r.id === MASTER);
  const r = co.find((r) => r.id === REPLICA);

  log("\n=== 1. COMPANY SETTINGS ===");
  const settingUpdates = SETTINGS.filter(
    (s) => JSON.stringify(m[s]) !== JSON.stringify(r[s]),
  );
  if (!settingUpdates.length) log("  already identical");
  for (const s of settingUpdates) {
    log(`  ${s}: Schaumburg ${JSON.stringify(r[s])} -> ${JSON.stringify(m[s])}`);
    changes.push(`setting ${s}`);
  }
  if (settingUpdates.length) {
    await c.query(
      `UPDATE companies SET ${settingUpdates.map((s, i) => `"${s}"=$${i + 1}`).join(",")}
        WHERE id=$${settingUpdates.length + 1}`,
      [...settingUpdates.map((s) => m[s]), REPLICA],
    );
  }

  // ── 2. Service menu ────────────────────────────────────────────────────────
  const { rows: scopes } = await c.query(
    `SELECT id,company_id,name,scope_group,pricing_method,hourly_rate,minimum_bill,
            is_active,show_online,displayed_for_office,sort_order
       FROM pricing_scopes WHERE company_id IN ($1,$2) ORDER BY is_active DESC, id`,
    [MASTER, REPLICA],
  );

  // co1 carries one duplicate name ('Deep Clean': an active row with 56 quotes
  // and a dead twin). ORDER BY is_active DESC, id means the live row wins.
  const pick = (companyId) => {
    const byName = new Map();
    for (const s of scopes) {
      if (s.company_id !== companyId) continue;
      if (!byName.has(key(s.name))) byName.set(key(s.name), s);
    }
    return byName;
  };
  const master = pick(MASTER);
  const replica = pick(REPLICA);

  log("\n=== 2. SERVICE MENU: scopes to CREATE on Schaumburg ===");
  const created = [];
  for (const [k, s] of master) {
    if (replica.has(k)) continue;
    const { rows } = await c.query(
      `INSERT INTO pricing_scopes
         (company_id,name,scope_group,pricing_method,hourly_rate,minimum_bill,
          is_active,show_online,displayed_for_office,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [REPLICA, s.name, s.scope_group, s.pricing_method, s.hourly_rate,
       s.minimum_bill, s.is_active, s.show_online, s.displayed_for_office, s.sort_order],
    );
    const newId = rows[0].id;
    // Carry the frequency ladder across, or an hourly recurring scope lands
    // with no cadence options at all.
    const { rowCount: freqs } = await c.query(
      `INSERT INTO pricing_frequencies
         (scope_id,company_id,frequency,rate_override,multiplier,label,sort_order,show_office)
       SELECT $1,$2,frequency,rate_override,multiplier,label,sort_order,show_office
         FROM pricing_frequencies WHERE scope_id=$3 AND company_id=$4`,
      [newId, REPLICA, s.id, MASTER],
    );
    // Tiers matter for sqft-priced scopes; the co1-only ones are all hourly and
    // have none, but copy anything that is there rather than assume.
    const { rowCount: tiers } = await c.query(
      `INSERT INTO pricing_tiers (scope_id,company_id,min_sqft,max_sqft,hours)
       SELECT $1,$2,min_sqft,max_sqft,hours
         FROM pricing_tiers WHERE scope_id=$3 AND company_id=$4`,
      [newId, REPLICA, s.id, MASTER],
    );
    created.push(s.name);
    log(
      `  + ${s.name} (${s.scope_group}, ${s.pricing_method})` +
        ` active=${s.is_active} online=${s.show_online}` +
        ` [${freqs} frequencies, ${tiers} tiers]`,
    );
    changes.push(`create ${s.name}`);
  }
  if (!created.length) log("  none");

  log("\n=== 2b. SERVICE MENU: visibility flags to ALIGN on Schaumburg ===");
  let aligned = 0;
  for (const [k, s] of master) {
    const t = replica.get(k);
    if (!t) continue;
    const diff = FLAGS.filter((f) => s[f] !== t[f]);
    if (!diff.length) continue;
    await c.query(
      `UPDATE pricing_scopes SET ${FLAGS.map((f, i) => `${f}=$${i + 1}`).join(",")}
        WHERE id=$${FLAGS.length + 1}`,
      [...FLAGS.map((f) => s[f]), t.id],
    );
    log(`  ~ ${s.name}: ${diff.map((f) => `${f} ${t[f]} -> ${s[f]}`).join(", ")}`);
    aligned++;
    changes.push(`flags ${s.name}`);
  }
  if (!aligned) log("  none");

  // ── 3. Reported, never auto-applied ────────────────────────────────────────
  log("\n=== 3. NEEDS A HUMAN DECISION (not changed) ===");
  let flagged = 0;
  for (const [k, s] of master) {
    const t = replica.get(k);
    if (!t) continue;
    if (s.pricing_method !== t.pricing_method) {
      const { rows: tc } = await c.query(
        `SELECT count(*)::int n FROM pricing_tiers WHERE scope_id=$1`, [t.id],
      );
      log(
        `  ! ${s.name}: priced ${t.pricing_method} on Schaumburg vs ` +
          `${s.pricing_method} on Oak Lawn. Switching would strand its ` +
          `${tc[0].n} pricing tiers and change what customers are charged.`,
      );
      flagged++;
    }
  }
  if (!flagged) log("  none");

  // ── 4. Resulting online menu ───────────────────────────────────────────────
  const { rows: menu } = await c.query(
    `SELECT company_id, name FROM pricing_scopes
      WHERE company_id IN ($1,$2) AND is_active AND show_online
      ORDER BY company_id, lower(name)`,
    [MASTER, REPLICA],
  );
  const oak = menu.filter((x) => x.company_id === MASTER).map((x) => x.name);
  const sch = menu.filter((x) => x.company_id === REPLICA).map((x) => x.name);
  log("\n=== 4. RESULTING ONLINE BOOKING MENU ===");
  log(`  Oak Lawn   (${oak.length}): ${oak.join(", ")}`);
  log(`  Schaumburg (${sch.length}): ${sch.join(", ")}`);
  const onlyOak = oak.filter((n) => !sch.some((s) => key(s) === key(n)));
  const onlySch = sch.filter((n) => !oak.some((s) => key(s) === key(n)));
  log(
    onlyOak.length || onlySch.length
      ? `  STILL DIFFERENT -> Oak Lawn only: [${onlyOak}] Schaumburg only: [${onlySch}]`
      : "  IDENTICAL",
  );

  // ── 5. Recurring engine blast radius ───────────────────────────────────────
  // Flipping recurring_engine_enabled on is the one setting here that can
  // generate real jobs, so say how many schedules are waiting behind it.
  const { rows: sched } = await c.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE is_active)::int active
       FROM recurring_schedules WHERE company_id=$1`,
    [REPLICA],
  );
  log("\n=== 5. RECURRING ENGINE BLAST RADIUS (Schaumburg) ===");
  log(`  ${sched[0].active} active schedules of ${sched[0].total} total`);
  log(
    sched[0].active === 0
      ? "  -> turning the engine on generates nothing today; it is inert until schedules exist"
      : "  -> these WILL start generating jobs on the next engine run",
  );

  if (APPLY) {
    await c.query("COMMIT");
    log(`\nAPPLIED. ${changes.length} changes committed.`);
  } else {
    await c.query("ROLLBACK");
    log(`\nDRY RUN - rolled back. ${changes.length} changes would be made.`);
    log("Re-run with --apply to commit.");
  }
} catch (err) {
  await c.query("ROLLBACK");
  console.error("\nFAILED, rolled back:", err.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
