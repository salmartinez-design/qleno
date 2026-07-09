/**
 * Estimate packages = flat-price templates. Templates gain billing_mode +
 * flat_price; create / update / save-as-template persist them; applying a flat
 * package drops the builder into flat-price view with the price prefilled.
 * Source-assertion guard.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("estimate packages (flat-price templates)", () => {
  const route = read("../routes/estimates.ts");
  const migration = read("../phes-data-migration.ts");
  const schema = read("../../../../lib/db/src/schema/estimates.ts");
  const builder = read("../../../qleno/src/pages/estimate-builder.tsx");

  it("templates table gains billing_mode + flat_price (schema + migration)", () => {
    assert.match(schema, /estimateTemplatesTable[\s\S]*billing_mode: text\("billing_mode"\)/);
    assert.match(migration, /ALTER TABLE estimate_templates ADD COLUMN IF NOT EXISTS billing_mode TEXT/);
    assert.match(migration, /ALTER TABLE estimate_templates ADD COLUMN IF NOT EXISTS flat_price NUMERIC\(12,2\)/);
  });

  it("create template persists billing_mode + flat_price", () => {
    assert.match(route, /INSERT INTO estimate_templates \(company_id, name, category, title, intro_note, terms, billing_mode, flat_price, created_by\)/);
  });

  it("a PATCH route edits a template/package in place", () => {
    assert.match(route, /router\.patch\("\/templates\/:id"/);
    assert.match(route, /UPDATE estimate_templates SET/);
  });

  it("save-as-template carries the estimate's pricing mode (flat → package)", () => {
    assert.match(route, /SELECT title, intro_note, terms, billing_mode, flat_price FROM estimates/);
    assert.match(route, /INSERT INTO estimate_templates \(company_id, name, title, intro_note, terms, billing_mode, flat_price, created_by\)/);
  });

  it("applying a flat package switches the builder to flat-price view", () => {
    assert.match(builder, /full\.billing_mode === "flat"/);
    assert.match(builder, /setBillingMode\("flat"\)/);
    assert.match(builder, /t\.billing_mode === "flat"/); // picker card shows the price
  });

  it("a Settings → Packages authoring page exists and is routed", () => {
    const page = read("../../../qleno/src/pages/company/packages.tsx");
    const app = read("../../../qleno/src/App.tsx");
    assert.match(page, /export default function PackagesPage/);
    assert.match(page, /billing_mode: "flat"/);            // always creates flat packages
    assert.match(page, /method: "PATCH"/);                 // edit
    assert.match(page, /method: "POST"/);                  // create
    assert.match(page, /filter\(\(t: any\) => t\.billing_mode === "flat"\)/); // lists packages only
    assert.match(page, /from "@\/components\/frequency-picker"/); // reuses the shared picker
    assert.match(app, /component=\{PackagesPage\}/);
  });
});
