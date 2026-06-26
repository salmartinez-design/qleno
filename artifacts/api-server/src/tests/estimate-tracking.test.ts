/**
 * On-estimate tracking panel + stop-follow-ups route. The engagement endpoint
 * already returns estimate/counts/timeline/enrollment; the builder surfaces it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("estimate tracking panel", () => {
  const route = read("../routes/estimates.ts");
  const ui = read("../../../qleno/src/pages/estimate-builder.tsx");

  it("has a stop-follow-ups route using stopEnrollmentsForEstimate", () => {
    assert.match(route, /router\.post\("\/:id\/stop-followups"/);
    assert.match(route, /await stopEnrollmentsForEstimate\(id, "manual"\)/);
  });
  it("engagement endpoint returns enrollment progress", () => {
    assert.match(route, /enrollment: \(enr as any\)\.rows\[0\] \?\? null/);
  });
  it("builder renders the tracking panel when sent + clearer send button", () => {
    assert.match(ui, /function EstimateTracking/);
    assert.match(ui, /id && status !== "draft" && <EstimateTracking estimateId=\{id\} version=\{trackVersion\}/);
    assert.match(ui, /\/api\/estimates\/\$\{estimateId\}\/engagement/);
    assert.match(ui, /\/api\/estimates\/\$\{estimateId\}\/stop-followups/);
    assert.match(ui, /publicToken \? "Resend to client" : "Send to client"/);
  });
});
