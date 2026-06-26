/**
 * Estimate frequency UX: a real dropdown (all options always visible) + Custom,
 * an estimate-level "set every line" control, and per-line override.
 * Frontend-only; source-assertion guard.
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

describe("estimate frequency dropdown", () => {
  it("is a real <select> listing every option + Custom… (not a filtered datalist)", () => {
    assert.match(ui, /function FrequencyPicker/);
    assert.match(ui, /FREQUENCY_OPTIONS\.map\(f => <option key=\{f\} value=\{f\}>\{f\}<\/option>\)/);
    assert.match(ui, /value="__custom__">Custom…/);
    assert.doesNotMatch(ui, /list="freq-options"/); // old filtered-datalist approach gone
  });
  it("Custom… reveals a free-text field for any cadence", () => {
    assert.match(ui, /e\.g\. 2x\/month, every 3 weeks/);
  });
  it("estimate-level control sets every line at once", () => {
    assert.match(ui, /Service frequency — sets every line/);
    assert.match(ui, /<FrequencyPicker value=\{commonFreq\} onChange=\{applyFreqToAll\} \/>/);
    assert.match(ui, /its\.map\(it => \(\{ \.\.\.it, frequency: f \}\)\)/);
  });
  it("each line still uses the picker (per-line override)", () => {
    assert.match(ui, /<FrequencyPicker value=\{it\.frequency\} onChange=\{v => updateItem\(i, \{ frequency: v \}\)\} \/>/);
  });
});
