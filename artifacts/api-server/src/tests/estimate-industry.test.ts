/** Win-rate-by-industry: facility_type on estimates + the breakdown endpoint/UI. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("estimate industry breakdown", () => {
  const route = read("../routes/estimates.ts");
  const mig = read("../phes-data-migration.ts");
  const builder = read("../../../qleno/src/pages/estimate-builder.tsx");
  const eng = read("../../../qleno/src/pages/estimate-engagement.tsx");
  it("facility_type column + persisted on create/update", () => {
    assert.match(mig, /estimates\.facility_type/);
    assert.match(route, /scope_note, facility_type,/);           // INSERT
    assert.match(route, /facility_type = \$\{str\(b\.facility_type, 40\)\}/); // PATCH
  });
  it("by-industry endpoint groups + computes win rate", () => {
    assert.match(route, /router\.get\("\/engagement\/by-industry"/);
    assert.match(route, /GROUP BY 1/);
    assert.match(route, /win_rate: Number\(r\.sent\) > 0 \? Math\.round\(\(Number\(r\.won\) \/ Number\(r\.sent\)\) \* 100\) : 0/);
  });
  it("builder has facility type; engagement renders the breakdown", () => {
    assert.match(builder, /const FACILITY_TYPES/);
    assert.match(builder, /facility_type: facilityType \|\| null/);
    assert.match(eng, /Where we win — by industry/);
    assert.match(eng, /engagement\/by-industry/);
  });
});
