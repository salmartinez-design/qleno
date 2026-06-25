/**
 * Estimate-level "Service frequency — applies to every line" control.
 * Frontend-only feature; source-assertion guard that the builder ships the
 * apply-to-all helper + control and still allows per-line override.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ui = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../qleno/src/pages/estimate-builder.tsx"),
  "utf8",
);

describe("estimate bulk frequency", () => {
  it("has an apply-to-all helper that rewrites every line's frequency", () => {
    assert.match(ui, /const applyFreqToAll = /);
    assert.match(ui, /its\.map\(it => \(\{ \.\.\.it, frequency: f \}\)\)/);
  });
  it("renders the estimate-level control + Apply to all", () => {
    assert.match(ui, /Service frequency — sets every line/);
    assert.match(ui, /Apply to all/);
  });
  it("supports any cadence incl. custom (free-text + datalist)", () => {
    assert.match(ui, /Weekly, Monthly, 2x\/month, custom/);
    assert.match(ui, /list="freq-options"/);
  });
  it("still allows per-line override (per-line frequency input intact)", () => {
    assert.match(ui, /updateItem\(i, \{ frequency: e\.target\.value \}\)/);
  });
});
