/** Dashboard metrics: real close rate / MRR / ARR / specialty pipeline + row billing tag. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("estimate dashboard metrics", () => {
  const route = read("../routes/estimates.ts");
  const page = read("../../../qleno/src/pages/estimates.tsx");
  it("stats endpoint computes the pipeline metrics + close rate", () => {
    assert.match(route, /AS mrr_pipeline/);
    assert.match(route, /AS arr_won/);
    assert.match(route, /AS specialty_pipeline/);
    assert.match(route, /COUNT\(\*\) FILTER \(WHERE status <> 'draft'\)::int AS sent/);
    assert.match(route, /r\.close_rate = sent > 0 \? Math\.round\(\(accepted \/ sent\) \* 100\) : 0/);
  });
  it("list returns billing fields for the row tag", () => {
    assert.match(route, /e\.billing_mode, e\.flat_price_unit,/);
  });
  it("dashboard shows the real metric cards + recurring tag", () => {
    assert.match(page, /label: "Pipeline MRR"/);
    assert.match(page, /label: "Close rate"/);
    assert.match(page, /label: "Closed ARR"/);
    assert.match(page, /label: "Specialty pipeline"/);
    assert.match(page, /e\.billing_mode === "flat" && e\.flat_price_unit === "month"/);
  });
});
