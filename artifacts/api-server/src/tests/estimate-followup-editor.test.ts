/**
 * Native estimate follow-up drip editor: GET/PUT the company's estimate_followup
 * sequence + steps; the GoHighLevel tab is replaced by an in-app editor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("native follow-up drip editor", () => {
  const route = read("../routes/estimates.ts");
  const editor = read("../../../qleno/src/pages/estimates-followup-editor.tsx");
  const page = read("../../../qleno/src/pages/estimates.tsx");

  it("GET + PUT operate on the estimate_followup sequence, before /:id", () => {
    assert.match(route, /router\.get\("\/follow-up"/);
    assert.match(route, /router\.put\("\/follow-up"/);
    assert.match(route, /sequence_type = 'estimate_followup'/);
    // /follow-up must be declared before the catch-all GET /:id
    assert.ok(route.indexOf('router.get("/follow-up"') < route.indexOf('router.get("/:id"'));
    assert.match(route, /INSERT INTO follow_up_steps \(sequence_id, step_number, delay_hours, channel, subject, message_template\)/);
  });
  it("editor is master-detail with cadence presets + a default sequence", () => {
    assert.match(editor, /export function FollowUpEditor/);
    assert.match(editor, /const PRESETS: Record<string, number> = \{ standard: 1, aggressive: 0\.5, gentle: 2 \}/);
    assert.match(editor, /const DEFAULT_STEPS: Step\[\]/);
    assert.match(editor, /\/api\/estimates\/follow-up/);
    assert.match(editor, /after the previous touch/);
  });
  it("estimates page swaps GoHighLevel for the Follow-up tab", () => {
    assert.match(page, /\["followup", "Follow-up"\]/);
    assert.match(page, /<FollowUpEditor \/>/);
    assert.doesNotMatch(page, /GoHighLevel follow-up bridge/);
  });
});
