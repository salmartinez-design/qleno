/**
 * Estimate autosave: a debounced (2s) save shared with the manual Save button,
 * with a status indicator and a baseline snapshot so it only fires on real edits.
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

describe("estimate autosave", () => {
  it("has a shared quiet persist() used by manual save", () => {
    assert.match(ui, /async function persist\(\): Promise<number \| null>/);
    assert.match(ui, /async function save\(\): Promise<number \| null>[\s\S]*?const sid = await persist\(\)/);
  });
  it("debounces 2s after the last edit, skipping load + no-op + empty drafts", () => {
    assert.match(ui, /setTimeout\(\(\) => \{ persist\(\); \}, 2000\)/);
    assert.match(ui, /if \(snapshot === lastSavedRef\.current\) return/);
    assert.match(ui, /if \(!id && !hasContent\) return/);
    assert.match(ui, /if \(lastSavedRef\.current === null\) \{ lastSavedRef\.current = snapshot; return; \}/);
  });
  it("surfaces a save status in the action bar", () => {
    assert.match(ui, /const \[autoStatus, setAutoStatus\]/);
    assert.match(ui, /All changes saved/);
    assert.match(ui, /Save failed — retry/);
  });
});
