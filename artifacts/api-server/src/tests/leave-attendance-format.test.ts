/**
 * Attendance-summary pure helpers (Phase 2, Sal 2026-06-24).
 * Hours-parse + note-cleanup + disciplinary next-step selection.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseUnexcusedHours,
  cleanUnexNote,
  pickNextStep,
  maxLadderWindow,
} from "../lib/leave-attendance-format.js";

describe("parseUnexcusedHours", () => {
  it("reads the ladder marker", () => {
    assert.equal(parseUnexcusedHours("unexcused hours: 4.00 (left early)"), 4);
    assert.equal(parseUnexcusedHours("unexcused hours: 8"), 8);
  });
  it("0 when no marker / null", () => {
    assert.equal(parseUnexcusedHours("just a note"), 0);
    assert.equal(parseUnexcusedHours(null), 0);
  });
});

describe("cleanUnexNote", () => {
  it("strips the marker + parens for display", () => {
    assert.equal(cleanUnexNote("unexcused hours: 4.00 (no call)"), "no call");
  });
  it("falls back when only the marker is present", () => {
    assert.equal(cleanUnexNote("unexcused hours: 4.00"), "Unexcused absence");
    assert.equal(cleanUnexNote(null), "Unexcused absence");
  });
});

describe("pickNextStep — LMS-rule disciplinary ladder", () => {
  const steps = [
    { threshold_hours: 16, window_days: 90, discipline_type: "final_warning" },
    { threshold_hours: 8, window_days: 90, discipline_type: "absence_warning" },
    { threshold_hours: 24, window_days: 90, discipline_type: "termination" },
  ];
  it("picks the lowest threshold not yet reached", () => {
    assert.deepEqual(pickNextStep(steps, 0), { threshold: 8, label: "Written warning" });
    assert.deepEqual(pickNextStep(steps, 8), { threshold: 16, label: "Final warning" });
    assert.deepEqual(pickNextStep(steps, 20), { threshold: 24, label: "Termination review" });
  });
  it("null when all crossed or no steps configured", () => {
    assert.equal(pickNextStep(steps, 30), null);
    assert.equal(pickNextStep([], 0), null);
  });
  it("honors a custom label override", () => {
    assert.deepEqual(
      pickNextStep([{ threshold_hours: 8, discipline_type: "custom", label: "Coaching" }], 0),
      { threshold: 8, label: "Coaching" },
    );
  });
});

describe("maxLadderWindow", () => {
  it("max window across steps, floored at fallback", () => {
    assert.equal(maxLadderWindow([{ window_days: 90 }, { window_days: 30 }], 180), 180);
    assert.equal(maxLadderWindow([{ window_days: 365 }], 180), 365);
    assert.equal(maxLadderWindow([], 180), 180);
  });
});
