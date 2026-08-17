/**
 * [longform-truncation 2026-08-15] The client-facing prose fields on an
 * estimate were silently truncated at 2000 characters.
 *
 * `str()` in routes/estimates.ts defaults to `max = 2000`, and every write of
 * intro_note / terms / internal_notes / scope_note called it with no explicit
 * max. These are long-form TEXT columns with no database limit — the cap was
 * purely an unpassed default argument.
 *
 * Real damage: a four-location medical estimate (EST-1005) had terms of ~2100
 * characters. It was stored cut MID-WORD, ending
 *   "...INSURANCE: Phes carries gener"
 * dropping the rest of the insurance clause and the validity line. The client
 * opened that document five times. Nothing in the UI or the API response
 * indicated anything had been dropped.
 *
 * Pins that every prose field is written with the LONG_TEXT cap, and that the
 * follow-up sequence steps are returned so the office can see queued touches.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(resolve(here, "../routes/estimates.ts"), "utf8");

describe("estimate long-form fields are not silently truncated", () => {
  it("defines a LONG_TEXT cap well above the 2000-char default", () => {
    const m = route.match(/const LONG_TEXT = (\d+)/);
    assert.ok(m, "LONG_TEXT constant must exist");
    assert.ok(Number(m![1]) >= 20000, `LONG_TEXT should be >= 20000, got ${m![1]}`);
  });

  // The bug was the ABSENCE of a second argument, so assert no bare call
  // survives for any client-facing prose field.
  for (const field of ["intro_note", "terms", "internal_notes", "scope_note"]) {
    it(`writes ${field} with an explicit long cap, never the 2000 default`, () => {
      const bare = new RegExp(`str\\((?:b|req\\.body\\?)\\.${field}\\)`, "g");
      const hits = route.match(bare) || [];
      assert.equal(hits.length, 0,
        `${field} is written with a bare str() call (${hits.length}x) — that silently truncates at 2000`);
    });
  }

  it("every str() call on a prose field passes LONG_TEXT", () => {
    for (const field of ["intro_note", "terms", "internal_notes", "scope_note"]) {
      const calls = route.match(new RegExp(`str\\((?:b|req\\.body\\?)\\.${field},\\s*([A-Za-z0-9_]+)\\)`, "g")) || [];
      assert.ok(calls.length > 0, `expected at least one write of ${field}`);
      for (const c of calls) {
        assert.ok(c.includes("LONG_TEXT"), `${c} should use LONG_TEXT`);
      }
    }
  });
});

describe("follow-up sequence visibility", () => {
  it("engagement endpoint returns the sequence steps", () => {
    // Without these the panel can only show "Step 3 of 8" and a bar — the
    // office cannot see what a live prospect is queued to receive.
    assert.match(route, /FROM follow_up_steps\s*\n\s*WHERE sequence_id = \$\{enrollment\.sequence_id\}/);
    assert.match(route, /cumulative_hours/);
    assert.match(route, /fires_at:/);
    assert.match(route, /steps,/);
  });
});
