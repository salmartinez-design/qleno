/**
 * Estimate frequency UX: a shared FrequencyPicker component (real dropdown of all
 * options + a structured Custom builder), wired into the estimate builder's
 * "set every line" control and per-line override.
 * Frontend-only; source-assertion guard.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("estimate frequency dropdown", () => {
  const picker = read("../../../qleno/src/components/frequency-picker.tsx");
  const ui = read("../../../qleno/src/pages/estimate-builder.tsx");

  it("is a shared real <select> listing every option + Custom… (not a filtered datalist)", () => {
    assert.match(picker, /export function FrequencyPicker/);
    assert.match(picker, /FREQUENCY_OPTIONS\.map\(f => <option key=\{f\} value=\{f\}>\{f\}<\/option>\)/);
    assert.match(picker, /value="__custom__">Custom…/);
    assert.doesNotMatch(picker, /list="freq-options"/); // old filtered-datalist approach gone
  });
  it("includes a Semi-monthly option", () => {
    assert.match(picker, /"Semi-monthly"/);
  });
  it("Custom… is a structured builder: a count + a cadence selector", () => {
    assert.match(picker, /const CADENCE_UNITS = \[/);
    assert.match(picker, /label: "per month"/);
    assert.match(picker, /export const composeFreq = \(n: string, unit: string\) => `\$\{Math\.max\(1, Number\(n\) \|\| 1\)\}x\/\$\{unit\}`/);
    assert.match(picker, /CADENCE_UNITS\.map\(u => <option key=\{u\.v\} value=\{u\.v\}>\{u\.label\}<\/option>\)/);
    assert.doesNotMatch(picker, /e\.g\. 2x\/month, every 3 weeks/); // old free-text custom gone
  });
  it("builder imports the shared picker (single source of truth)", () => {
    assert.match(ui, /import \{ FrequencyPicker \} from "@\/components\/frequency-picker"/);
    assert.doesNotMatch(ui, /function FrequencyPicker/); // no local copy
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
