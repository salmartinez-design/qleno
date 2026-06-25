/**
 * Phase 2 — Estimate templates.
 *
 * Stub-DB (no connection): validates the schema gained the `category` column,
 * the boot migration emits it additively, and the 4 seeded commercial templates
 * are well-formed (categories, item shape, computable amounts). The seed runs
 * against the live DB at boot/deploy; this guards the data the picker depends on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { estimateTemplatesTable } from "@workspace/db/schema";
import { ESTIMATE_TEMPLATE_SEED } from "../phes-data-migration.ts";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(resolve(here, "../phes-data-migration.ts"), "utf8");

describe("Phase 2 — estimate_templates.category", () => {
  it("category column exists on the Drizzle schema", () => {
    const col = (estimateTemplatesTable as any).category;
    assert.ok(col, "estimate_templates.category should exist");
    assert.equal(col.name, "category");
  });
  it("boot migration adds category idempotently", () => {
    assert.match(
      migration,
      /ALTER TABLE estimate_templates ADD COLUMN IF NOT EXISTS category TEXT/,
      "migration must ADD COLUMN IF NOT EXISTS estimate_templates.category",
    );
  });
});

describe("Phase 2 — seeded commercial templates", () => {
  it("seeds exactly the 4 verticals", () => {
    const cats = ESTIMATE_TEMPLATE_SEED.map((t) => t.category).sort();
    assert.deepEqual(cats, ["common_areas", "medical", "office", "retail"]);
  });

  it("every template is well-formed and every line item is sane", () => {
    const VALID_PRICING = new Set(["flat", "hourly", "one_time"]);
    for (const t of ESTIMATE_TEMPLATE_SEED) {
      assert.ok(t.name && t.title && t.intro_note && t.terms, `${t.category} has copy`);
      assert.ok(t.items.length >= 4, `${t.category} has >= 4 line items`);
      for (const it of t.items) {
        assert.ok(it.name, `${t.category} item has a name`);
        assert.ok(VALID_PRICING.has(it.pricing_type), `${t.category} item pricing_type valid`);
        assert.ok(it.quantity > 0, `${t.category} item quantity > 0`);
        assert.ok(it.unit_rate > 0, `${t.category} item unit_rate > 0`);
      }
    }
  });

  it("Common Areas uses the seeded $45/hr scope on hourly lines", () => {
    const ca = ESTIMATE_TEMPLATE_SEED.find((t) => t.category === "common_areas")!;
    const hourly = ca.items.filter((i) => i.pricing_type === "hourly");
    assert.ok(hourly.length > 0, "Common Areas has hourly lines");
    for (const i of hourly) assert.equal(i.unit_rate, 45, "common-area hourly rate is $45/hr");
  });

  it("migration source references each seeded category (seed wired in)", () => {
    for (const cat of ["common_areas", "office", "retail", "medical"]) {
      assert.match(migration, new RegExp(`category: "${cat}"`), `seed includes ${cat}`);
    }
    assert.match(migration, /runEstimateTemplateSeed\(\)/, "seed function is invoked");
  });
});
