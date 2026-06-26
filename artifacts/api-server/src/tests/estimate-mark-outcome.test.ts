/** Office can mark an estimate won/lost (client said "proceed" off-app). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("office mark-outcome", () => {
  const route = read("../routes/estimates.ts");
  const ui = read("../../../qleno/src/pages/estimate-builder.tsx");
  it("route sets status + timestamp + stops the drip", () => {
    assert.match(route, /router\.post\("\/:id\/mark-outcome"/);
    assert.match(route, /UPDATE estimates SET status = 'accepted', accepted_at = now\(\)/);
    assert.match(route, /UPDATE estimates SET status = 'declined', declined_at = now\(\)/);
    assert.match(route, /stopEnrollmentsForEstimate\(id, outcome\)/);
    assert.match(route, /eventType: outcome, channel: "office"/);
  });
  it("builder has the Mark won / lost controls", () => {
    assert.match(ui, /const markOutcome = async \(outcome: "accepted" \| "declined"\)/);
    assert.match(ui, /\/api\/estimates\/\$\{estimateId\}\/mark-outcome/);
    assert.match(ui, /Mark as won/);
    assert.match(ui, /Mark as lost/);
  });
});
