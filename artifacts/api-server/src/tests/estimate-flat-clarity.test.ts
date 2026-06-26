/**
 * Flat-price clarity: a price unit ("$150 / visit") and an optional free-text
 * scope paragraph, end to end (schema, route, editor, client page).
 * Source-assertion guard.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("estimate flat-price clarity", () => {
  const route = read("../routes/estimates.ts");
  const migration = read("../phes-data-migration.ts");
  const schema = read("../../../../lib/db/src/schema/estimates.ts");
  const builder = read("../../../qleno/src/pages/estimate-builder.tsx");
  const pub = read("../../../qleno/src/pages/estimate-public.tsx");

  it("schema + migration add flat_price_unit + scope_note", () => {
    assert.match(schema, /flat_price_unit: text\("flat_price_unit"\)\.notNull\(\)\.default\("visit"\)/);
    assert.match(schema, /scope_note: text\("scope_note"\)/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS flat_price_unit TEXT NOT NULL DEFAULT 'visit'/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS scope_note TEXT/);
  });

  it("route validates the unit and persists both on create + update", () => {
    assert.match(route, /const PRICE_UNITS = new Set\(\["visit", "week", "month", "quarter", "year", "service", "total"\]\)/);
    assert.match(route, /function priceUnitOf/);
    assert.match(route, /flat_price, flat_price_unit, scope_note,/);    // INSERT columns
    assert.match(route, /flat_price_unit = \$\{priceUnitOf\(b\.flat_price_unit\)\}/); // PATCH
  });

  it("editor has the unit selector + the scope paragraph, and sends both", () => {
    assert.match(builder, /const PRICE_UNITS = \[/);
    assert.match(builder, /const unitSuffix = \(u: string\) => \(u && u !== "total" \? ` \/ \$\{u\}` : ""\)/);
    assert.match(builder, /const \[scopeNote, setScopeNote\]/);
    assert.match(builder, /Scope description/);
    assert.match(builder, /flat_price_unit: flatPriceUnit/);
    assert.match(builder, /scope_note: billingMode === "flat" \? \(scopeNote\.trim\(\) \|\| null\) : null/);
  });

  it("client page shows the scope paragraph + the unit on the total", () => {
    assert.match(pub, /est\.scope_note &&/);
    assert.match(pub, /est\.flat_price_unit && est\.flat_price_unit !== "total" \? ` \/ \$\{est\.flat_price_unit\}` : ""/);
  });
});
