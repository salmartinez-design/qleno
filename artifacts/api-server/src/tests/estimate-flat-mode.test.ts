/**
 * Estimate flat-price mode: one price for the whole job + a scope checklist
 * (no per-line pricing), persisted via billing_mode/flat_price, rendered on the
 * editor and the client-facing hosted page. Source-assertion guard.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("estimate flat-price mode", () => {
  const route = read("../routes/estimates.ts");
  const migration = read("../phes-data-migration.ts");
  const schema = read("../../../../lib/db/src/schema/estimates.ts");
  const builder = read("../../../qleno/src/pages/estimate-builder.tsx");
  const pub = read("../../../qleno/src/pages/estimate-public.tsx");

  it("schema + migration add billing_mode and flat_price (additive, idempotent)", () => {
    assert.match(schema, /billing_mode: text\("billing_mode"\)/);
    assert.match(schema, /flat_price: numeric\("flat_price"/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'itemized'/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS flat_price NUMERIC\(12,2\) NOT NULL DEFAULT 0/);
  });

  it("totals use the flat price in flat mode, sum of lines otherwise", () => {
    assert.match(route, /billingMode === "flat"\s*\?\s*Math\.round\(\(Math\.max\(0, Number\(flatPriceRaw/);
    assert.match(route, /function billingModeOf/);
  });

  it("create + update persist billing_mode and flat_price", () => {
    assert.match(route, /const billingMode = billingModeOf\(b\.billing_mode\)/);
    assert.match(route, /const flatPrice = billingMode === "flat" \? subtotal : 0/);
    assert.match(route, /billing_mode = \$\{billingMode\}/);   // PATCH
    assert.match(route, /status, billing_mode, flat_price,/);  // INSERT column list
  });

  it("editor has the mode toggle, a single price field, and a scope list", () => {
    assert.match(builder, /const \[billingMode, setBillingMode\]/);
    assert.match(builder, /\["flat", "itemized"\] as const/);
    assert.match(builder, /billing_mode: billingMode/);
    assert.match(builder, /flat_price: billingMode === "flat" \? \(Number\(flatPrice\) \|\| 0\) : 0/);
    assert.match(builder, /What's included/);
  });

  it("client page renders the flat scope list + single total when flat", () => {
    assert.match(pub, /est\.billing_mode === "flat"/);
    assert.match(pub, /What's included/);
  });
});
