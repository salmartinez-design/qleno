/**
 * Phase 3 — tenant-dynamic bucket display resolver (Sal 2026-06-24).
 *
 * THE BOARD INVARIANT: resolveBucketDisplay must reproduce the four legacy
 * hardcoded maps BYTE-IDENTICALLY for PHES, so the dispatch board / employees
 * review / profile cards / history chips render with zero color/label drift.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveBucketDisplay,
  PHES_BUCKET_DISPLAY,
  ABSENT_DISPLAY,
} from "../lib/leave-bucket-display.js";

// The exact legacy values, transcribed from the 4 maps being deleted:
//   dispatch TIME_OFF_BG (tint) + TIME_OFF_LABEL (board_label)
//   employees BUCKET_COLORS ({bg=tint, fg=on_tint})
//   profile leaveBucketAccent (accent) + leaveBucketLabel (chip_label)
const LEGACY = {
  pto_phes:     { display_name: "PTO",          tint: "#E9FBF5", accent: "#1D9E75", on_tint: "#00876B", board_label: "PTO",       chip_label: "PTO" },
  plawa:        { display_name: "PLAWA",         tint: "#FEF3C7", accent: "#378ADD", on_tint: "#92400E", board_label: "PLAWA",     chip_label: "Sick" },
  unpaid_leave: { display_name: "Unpaid Leave",  tint: "#EEF2F7", accent: "#BA7517", on_tint: "#334155", board_label: "Unpaid",    chip_label: "Unpaid" },
  unexcused:    { display_name: "Unexcused",     tint: "#FCE7E7", accent: "#E24B4A", on_tint: "#991B1B", board_label: "Unexcused", chip_label: "Unexcused" },
} as const;

describe("resolveBucketDisplay — PHES byte-identical (board invariant)", () => {
  for (const [slug, exp] of Object.entries(LEGACY)) {
    it(`${slug} resolves to the exact legacy colors + labels`, () => {
      const d = resolveBucketDisplay({
        slug,
        display_name: exp.display_name,
        display_config: PHES_BUCKET_DISPLAY[slug], // what the migration seeds
      });
      assert.equal(d.tint, exp.tint, "tint (board row + review bg)");
      assert.equal(d.accent, exp.accent, "accent (profile/chip)");
      assert.equal(d.on_tint, exp.on_tint, "on_tint (review fg)");
      assert.equal(d.board_label, exp.board_label, "board label");
      assert.equal(d.chip_label, exp.chip_label, "chip label");
      assert.equal(d.label, exp.display_name, "canonical label = display_name");
    });
  }

  it("PHES_BUCKET_DISPLAY seed matches the legacy hex exactly", () => {
    for (const [slug, exp] of Object.entries(LEGACY)) {
      const seed = PHES_BUCKET_DISPLAY[slug];
      assert.equal(seed.tint, exp.tint);
      assert.equal(seed.accent, exp.accent);
      assert.equal(seed.on_tint, exp.on_tint);
      assert.equal(seed.board_label, exp.board_label);
      assert.equal(seed.chip_label, exp.chip_label);
    }
  });

  it("absent pseudo-bucket keeps its legacy board tint + label", () => {
    assert.equal(ABSENT_DISPLAY.tint, "#FFEBEE");
    assert.equal(ABSENT_DISPLAY.board_label, "Absent");
  });
});

describe("resolveBucketDisplay — tenant-dynamic defaults (no config)", () => {
  it("a brand-new tenant bucket with NO display_config still resolves a full, stable display", () => {
    const d = resolveBucketDisplay({ slug: "bereavement", display_name: "Bereavement" });
    assert.ok(/^#[0-9A-Fa-f]{6}$/.test(d.tint), "derived tint is a hex");
    assert.ok(/^#[0-9A-Fa-f]{6}$/.test(d.accent), "derived accent is a hex");
    assert.equal(d.label, "Bereavement");
    assert.equal(d.board_label, "Bereavement"); // falls back to display_name
    assert.equal(d.chip_label, "Bereavement");
    // deterministic — same slug → same colors every call
    const d2 = resolveBucketDisplay({ slug: "bereavement", display_name: "Bereavement" });
    assert.deepEqual(d, d2);
  });
  it("partial config wins field-by-field; missing fields fall back", () => {
    const d = resolveBucketDisplay({ slug: "jury", display_name: "Jury Duty", display_config: { accent: "#123456" } });
    assert.equal(d.accent, "#123456");           // from config
    assert.ok(/^#[0-9A-Fa-f]{6}$/.test(d.tint));  // derived
    assert.equal(d.board_label, "Jury Duty");     // display_name fallback
  });
  it("a tenant configuring a DIFFERENT label/color renders exactly that (no code change)", () => {
    const d = resolveBucketDisplay({
      slug: "pto_acme",
      display_name: "Vacation",
      display_config: { tint: "#FFF0F0", accent: "#CC0000", on_tint: "#880000", board_label: "VAC", chip_label: "Vac" },
    });
    assert.equal(d.tint, "#FFF0F0");
    assert.equal(d.board_label, "VAC");
    assert.equal(d.chip_label, "Vac");
  });
});
