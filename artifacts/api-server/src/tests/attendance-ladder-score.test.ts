/**
 * [attendance-ladder 2026-08-21] A tardy has to reach the Performance Score.
 *
 * THE BUG, as Sal saw it on one tech's profile (employee 40):
 *
 *   Attendance tab      ->  "TARDY 1"          (trailing 180 days)
 *   Performance Score   ->  "ATTENDANCE 100%    0 issues · 57 days"
 *
 * Both were telling the truth about different windows. The tab looks back 180
 * days; the composite looked back 90 (COMPOSITE_WINDOW_DAYS). A tardy 91+ days
 * old had aged out of the score months earlier while still sitting on the tab.
 * Sal: "All i need you to do is ensure that the tardiness again is being
 * counted against their performance score and tardiness counter."
 *
 * Two things were wrong and both are fixed here:
 *   1. WINDOW. Attendance is now measured over the employee's Benefit Year
 *      (work anniversary), the same window the disciplinary ladder uses, so the
 *      score and the write-up can never disagree again.
 *   2. WEIGHT. The old ratio — (scheduled days − weighted violations) /
 *      scheduled days, tardy = 0.5 — moved the total score about 0.2 points per
 *      tardy against a ~60-day denominator. Counted, but invisible. Attendance
 *      is now position on the handbook's ladder: each occurrence costs one rung.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ladderAttendancePct } from "../lib/scorecard-composite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const composite = readFileSync(path.join(__dirname, "../lib/scorecard-composite.ts"), "utf8");

/** Phes's configured ladder: 3 written, 4 final, 5 termination. */
const PHES_TERMINATION = 5;

/** The blend, with the tenant's 60/25/15 weights. */
const total = (sat: number, att: number, cf: number) =>
  Math.round(((sat * 60 + att * 25 + cf * 15) / 100) * 100) / 100;

describe("the ladder scale", () => {
  it("a clean record is 100%", () => {
    assert.equal(ladderAttendancePct(0, PHES_TERMINATION), 100);
  });

  it("each occurrence costs one rung", () => {
    assert.equal(ladderAttendancePct(1, PHES_TERMINATION), 80);
    assert.equal(ladderAttendancePct(2, PHES_TERMINATION), 60);
    assert.equal(ladderAttendancePct(3, PHES_TERMINATION), 40); // written warning
    assert.equal(ladderAttendancePct(4, PHES_TERMINATION), 20); // final warning
    assert.equal(ladderAttendancePct(5, PHES_TERMINATION), 0);  // termination
  });

  it("past the termination rung it floors at 0, never negative", () => {
    assert.equal(ladderAttendancePct(9, PHES_TERMINATION), 0);
  });

  it("follows the TENANT's ladder, not a hardcoded 5", () => {
    // A tenant whose ladder terminates at 3 must see each occurrence cost a
    // third, not a fifth. Hardcoding 5 would recreate the score-vs-ladder
    // disagreement this whole change exists to remove.
    assert.equal(ladderAttendancePct(1, 3), 66.67);
    assert.equal(ladderAttendancePct(3, 3), 0);
  });

  it("returns null — not 100 — when no ladder is configured", () => {
    // A tenant with no steps has no scale to be a percentage of. Reporting 100%
    // would be inventing a perfect record out of missing configuration.
    assert.equal(ladderAttendancePct(0, 0), null);
    assert.equal(ladderAttendancePct(2, 0), null);
  });
});

describe("Sal's screenshot: one tardy must be visible", () => {
  // Employee 40, as shown: satisfaction 94, complaint-free 99, one tardy.
  const SAT = 94;
  const CF = 99;

  it("BEFORE: the tardy was invisible — attendance read 100%", () => {
    // The old formula over the 90-day window found zero rows, because the tardy
    // was older than 90 days. This is the state on Sal's screen.
    const oldAttendance = 100;
    assert.equal(total(SAT, oldAttendance, CF), 96.25); // rounds to the 96% he saw
  });

  it("AFTER: the same tardy costs a rung and shows in the score", () => {
    const att = ladderAttendancePct(1, PHES_TERMINATION);
    assert.equal(att, 80);
    assert.equal(total(SAT, att!, CF), 91.25); // 96% -> 91%
  });

  it("the tardy is worth ~5 points now, not ~0.2", () => {
    const clean = total(SAT, ladderAttendancePct(0, PHES_TERMINATION)!, CF);
    const oneTardy = total(SAT, ladderAttendancePct(1, PHES_TERMINATION)!, CF);
    const cost = clean - oneTardy;
    assert.ok(cost > 4.9 && cost < 5.1, `expected ~5 points, got ${cost}`);
  });
});

describe("tardy and unexcused are separate ladders", () => {
  it("the score follows the WORSE track, it does not average them", () => {
    // 4 tardies (final warning) + 0 absences. Averaging would read 60%; the
    // worse-of rule reads 20%, which is what "one step from termination"
    // should look like.
    const worst = Math.max(4, 0);
    assert.equal(ladderAttendancePct(worst, PHES_TERMINATION), 20);
  });

  it("a clean absence record cannot rescue a bad tardy record", () => {
    const tardyOnly = ladderAttendancePct(Math.max(3, 0), PHES_TERMINATION);
    const bothTracks = ladderAttendancePct(Math.max(3, 1), PHES_TERMINATION);
    assert.equal(tardyOnly, 40);
    assert.equal(bothTracks, 40, "the better track must not lift the score");
  });
});

describe("the engine wiring", () => {
  it("attendance is measured over the Benefit Year, not the 90-day window", () => {
    const block = composite.slice(
      composite.indexOf("// 2. Attendance"),
      composite.indexOf("// 3. Complaint-free"),
    );
    assert.ok(
      block.includes("benefitYearStartDate("),
      "attendance must use the ladder's own window, or the score and the write-up disagree again",
    );
    assert.ok(
      !block.includes("log_date >= ${fromDate}"),
      "the 90-day window is what made a 91-day-old tardy invisible",
    );
  });

  it("the termination rung is read from the tenant's policy row", () => {
    const block = composite.slice(
      composite.indexOf("// 2. Attendance"),
      composite.indexOf("// 3. Complaint-free"),
    );
    assert.ok(block.includes("company_attendance_policy"));
    assert.ok(
      !/terminationOccurrences = 5/.test(composite),
      "never hardcode the ladder's last rung",
    );
  });

  it("occurrences go through countUnexcusedOccurrences, so protected days count zero", () => {
    // The old ratio ignored the `protected` flag entirely, so a PLAWA-covered
    // absence still dragged the score down — a retaliation-flavored bug.
    const block = composite.slice(
      composite.indexOf("// 2. Attendance"),
      composite.indexOf("// 3. Complaint-free"),
    );
    assert.ok(block.includes("countUnexcusedOccurrences"));
    assert.ok(block.includes("!r.protected"), "protected tardies must not count");
  });

  it("a missing hire date shows a dash, never a fake 100%", () => {
    // benefitYearStartDate with no hire date collapses to a single day and
    // would report a permanent 0 occurrences — a hole to sit in.
    const block = composite.slice(
      composite.indexOf("// 2. Attendance"),
      composite.indexOf("// 3. Complaint-free"),
    );
    assert.ok(block.includes("hireDateRaw != null"));
    assert.ok(composite.includes('"missing_hire_date"'), "and the office is told why");
  });

  it("the payload explains the number instead of just asserting it", () => {
    assert.ok(composite.includes("attendance_ladder"));
    assert.ok(composite.includes("worst_occurrences"));
    assert.ok(composite.includes("termination_occurrences"));
  });
});
