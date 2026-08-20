// [branch-settings-sync 2026-08-19] Third and last pass of the Oak Lawn -> Schaumburg
// settings replica: the remaining catalog tables.
//
// The one that actually bites: `add_ons`. It is not the same table as
// `pricing_addons` (already identical on both). job_add_ons.add_on_id carries a
// real FK to add_ons and 662 Oak Lawn jobs use it, while Schaumburg had exactly
// one row — "Oven Cleaning". So a Schaumburg job could not be given a Parking
// Fee, Windows, Refrigerator, Cabinets or Basement add-on at all.
//
// Everything here is keyed by name and INSERT-only: a row Schaumburg already has
// is left exactly as it is, prices included. Copying Oak Lawn's price onto a row
// Schaumburg does not have yet is safe because there is no Schaumburg price to
// overwrite; the office can edit any of them afterwards.
//
// DELIBERATELY EXCLUDED — pricing_discounts (58 vs 24). Its `scope_ids` column is
// an array of Oak Lawn's pricing_scopes ids. Copying those rows would point
// Schaumburg's discount codes at another tenant's scopes, so they would either
// match nothing or discount the wrong service. Needs to be rebuilt against
// Schaumburg's own scope ids, which is a decision, not a copy.
//
// Usage:  railway run node scripts/sync-branch-catalog.mjs           (dry run)
//         railway run node scripts/sync-branch-catalog.mjs --apply
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const M = 1, R = 4;

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

let total = 0;
const step = async (label, sql, params = [M, R]) => {
  const { rowCount } = await c.query(sql, params);
  console.log(`  ${String(rowCount).padStart(3)}  ${label}`);
  total += rowCount;
};

await c.query("BEGIN");
try {
  console.log("=== ROWS COPIED TO SCHAUMBURG ===");

  await step("add_ons (job add-on catalog)", `
    INSERT INTO add_ons (company_id, name, price, category, is_active)
    SELECT $2, a.name, a.price, a.category, a.is_active FROM add_ons a
     WHERE a.company_id = $1
       AND NOT EXISTS (SELECT 1 FROM add_ons b
                        WHERE b.company_id = $2 AND lower(b.name) = lower(a.name))`);

  await step("addon_bundles", `
    INSERT INTO addon_bundles (company_id, name, description, discount_type,
                               discount_value, active, valid_from, valid_until)
    SELECT $2, a.name, a.description, a.discount_type, a.discount_value,
           a.active, a.valid_from, a.valid_until FROM addon_bundles a
     WHERE a.company_id = $1
       AND NOT EXISTS (SELECT 1 FROM addon_bundles b
                        WHERE b.company_id = $2 AND lower(b.name) = lower(a.name))`);

  await step("service_types", `
    INSERT INTO service_types (company_id, parent_slug, slug, name, description,
                               is_active, display_order, default_allowed_hours, commission_pct)
    SELECT $2, a.parent_slug, a.slug, a.name, a.description, a.is_active,
           a.display_order, a.default_allowed_hours, a.commission_pct FROM service_types a
     WHERE a.company_id = $1
       AND NOT EXISTS (SELECT 1 FROM service_types b
                        WHERE b.company_id = $2 AND b.slug = a.slug)`);

  await step("form_templates (agreements)", `
    INSERT INTO form_templates (company_id, name, type, category, schema, terms_body,
                                requires_sign, is_active, is_default)
    SELECT $2, a.name, a.type, a.category, a.schema, a.terms_body,
           a.requires_sign, a.is_active, a.is_default FROM form_templates a
     WHERE a.company_id = $1
       AND NOT EXISTS (SELECT 1 FROM form_templates b
                        WHERE b.company_id = $2 AND lower(b.name) = lower(a.name))`);

  await step("lead_report_settings", `
    INSERT INTO lead_report_settings (company_id, headline_cards)
    SELECT $2, a.headline_cards FROM lead_report_settings a
     WHERE a.company_id = $1
       AND NOT EXISTS (SELECT 1 FROM lead_report_settings b WHERE b.company_id = $2)`);

  // Parent then children, remapping template_id by name so the items land on the
  // Schaumburg copy rather than pointing back at Oak Lawn's template.
  await step("estimate_templates", `
    INSERT INTO estimate_templates (company_id, name, title, intro_note, terms,
                                    category, billing_mode, flat_price)
    SELECT $2, a.name, a.title, a.intro_note, a.terms, a.category,
           a.billing_mode, a.flat_price FROM estimate_templates a
     WHERE a.company_id = $1
       AND NOT EXISTS (SELECT 1 FROM estimate_templates b
                        WHERE b.company_id = $2 AND lower(b.name) = lower(a.name))`);

  await step("estimate_template_items", `
    INSERT INTO estimate_template_items (template_id, company_id, sort_order, name,
           description, pricing_type, frequency, quantity, unit_rate, amount)
    SELECT nt.id, $2, i.sort_order, i.name, i.description, i.pricing_type,
           i.frequency, i.quantity, i.unit_rate, i.amount
      FROM estimate_template_items i
      JOIN estimate_templates ot ON ot.id = i.template_id AND ot.company_id = $1
      JOIN estimate_templates nt ON nt.company_id = $2 AND lower(nt.name) = lower(ot.name)
     WHERE i.company_id = $1
       AND NOT EXISTS (SELECT 1 FROM estimate_template_items x
                        WHERE x.template_id = nt.id AND lower(x.name) = lower(i.name))`);

  console.log("\n=== FINAL COUNTS, co1 vs co4 ===");
  for (const t of ["add_ons", "addon_bundles", "service_types", "form_templates",
                   "lead_report_settings", "estimate_templates", "estimate_template_items",
                   "pricing_addons", "notification_templates"]) {
    const { rows } = await c.query(
      `SELECT count(*) FILTER (WHERE company_id=$1)::int a,
              count(*) FILTER (WHERE company_id=$2)::int b FROM "${t}"`, [M, R]);
    const { a, b } = rows[0];
    console.log(`  ${a === b ? "OK  " : "DIFF"} ${t.padEnd(26)} Oak Lawn=${a}  Schaumburg=${b}`);
  }

  console.log("\n=== LEFT ALONE ON PURPOSE ===");
  const { rows: d } = await c.query(
    `SELECT count(*) FILTER (WHERE company_id=$1)::int a,
            count(*) FILTER (WHERE company_id=$2)::int b FROM pricing_discounts`, [M, R]);
  console.log(`  pricing_discounts  Oak Lawn=${d[0].a}  Schaumburg=${d[0].b}` +
              `  (scope_ids point at Oak Lawn's scopes - needs rebuilding, not copying)`);
  console.log(`  service_zones      different territory by design`);
  console.log(`  pricing tiers/rates  Schaumburg prices its own work`);

  if (APPLY) {
    await c.query("COMMIT");
    console.log(`\nAPPLIED. ${total} rows copied.`);
  } else {
    await c.query("ROLLBACK");
    console.log(`\nDRY RUN - rolled back. ${total} rows would be copied.`);
  }
} catch (err) {
  await c.query("ROLLBACK");
  console.error("\nFAILED, rolled back:", err.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
