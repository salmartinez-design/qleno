// [attendance-ladder 2026-08-21] The ladder-based attendance sub-score.
// Run:
//   DATABASE_URL=postgres://stub@stub/stub tsx --test src/tests/attendance-ladder-score.test.ts
//
// What these pin, in order: the exact scale Sal signed off on, that the two
// tracks show the WORSE and never an average, that protected leave costs nothing,
// that the termination rung is read from tenant config rather than hardcoded,
// that a missing ladder yields a dash instead of a flattering 100, and that the
// window never reaches back past the cutover.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attendanceWindowStart,
  tardyWindowStart,
  scoreAttendanceLadder,
  terminationOccurrences,
  CUTOVER_FLOOR_DATE,
} from "../lib/attendance-score.js";

// Phes's real configuration, confirmed in production on both companies and both
// tracks. Written out rather than imported so a config change can't quietly
// rewrite what these tests claim.
const PHES = [
  { occurrence: 3, discipline_type: "absence_warning" },
  { occurrence: 4, discipline_type: "final_warning" },
  { occurrence: 5, discipline_type: "termination" },
];
const PHES_TARDY = [
  { occurrence: 3, discipline_type: "tardy_warning" },
  { occurrence: 4, discipline_type: "final_warning" },
  { occurrence: 5, discipline_type: "termination" },
];

const tardies = (n: number) =>
  Array.from({ length: n }, () => ({ type: "tardy", protected: false }));
const absences = (n: number) =>
  Array.from({ length: n }, () => ({ type: "absent", protected: false }));

const score = (rows: any[]) =>
  scoreAttendanceLadder({ rows, tardySteps: PHES_TARDY, unexcusedSteps: PHES }).score;

describe("the scale Sal approved", () => {
  // The whole reason for this work: one occurrence has to be worth feeling.
  it("walks 100 / 80 / 60 / 40 / 20 / 0 across the 5-rung ladder", () => {
    assert.equal(score([]), 100);
    assert.equal(score(tardies(1)), 80);
    assert.equal(score(tardies(2)), 60);
    assert.equal(score(tardies(3)), 40); // written warning
    assert.equal(score(tardies(4)), 20); // final warning
    assert.equal(score(tardies(5)), 0); // termination
  });

  it("floors at 0 rather than going negative past the termination rung", () => {
    assert.equal(score(tardies(6)), 0);
    assert.equal(score(tardies(50)), 0);
  });

  it("moves the headline score 5 points per occurrence at the 25% weight", () => {
    // Satisfaction 95, complaint-free 100, weights 60/25/15 — Sal's worked
    // example. The old days-ratio moved this by about 0.21 of a point.
    const blend = (att: number) => (95 * 60 + att * 25 + 100 * 15) / 100;
    assert.equal(blend(score([])!), 97.0);
    assert.equal(blend(score(tardies(1))!), 92.0);
    assert.equal(blend(score(tardies(2))!), 87.0);
    assert.equal(blend(score(tardies(3))!), 82.0);
    assert.equal(blend(score(tardies(4))!), 77.0);
    assert.equal(blend(score(tardies(5))!), 72.0);
  });
});

describe("two tracks — the worse one shows, never the average", () => {
  it("4 tardies and a clean absence record scores 20, not 60", () => {
    // Averaging the tracks would report someone one rung from termination as
    // comfortably fine. This is the assertion that forbids it.
    const r = scoreAttendanceLadder({
      rows: tardies(4),
      tardySteps: PHES_TARDY,
      unexcusedSteps: PHES,
    });
    assert.equal(r.score, 20);
    assert.equal(r.driver, "tardy");
  });

  it("4 absences and a clean tardy record scores 20 as well", () => {
    const r = scoreAttendanceLadder({
      rows: absences(4),
      tardySteps: PHES_TARDY,
      unexcusedSteps: PHES,
    });
    assert.equal(r.score, 20);
    assert.equal(r.driver, "unexcused");
  });

  it("counts the tracks separately — 2 tardies + 2 absences is 60, not 20", () => {
    // They do NOT add up. Each track walks its own ladder, exactly as discipline
    // does; a combined count of 4 would wrongly imply a final warning.
    const r = scoreAttendanceLadder({
      rows: [...tardies(2), ...absences(2)],
      tardySteps: PHES_TARDY,
      unexcusedSteps: PHES,
    });
    assert.equal(r.tardy_occurrences, 2);
    assert.equal(r.unexcused_occurrences, 2);
    assert.equal(r.score, 60);
  });

  it("names no driver on a clean record", () => {
    assert.equal(scoreAttendanceLadder({ rows: [], tardySteps: PHES_TARDY, unexcusedSteps: PHES }).driver, null);
  });
});

describe("protected leave costs nothing", () => {
  it("a PLAWA-covered absence does not move the score", () => {
    // The bug this closes: the old sub-score filtered on row type only, so
    // legally protected leave dragged a tech's number down.
    assert.equal(score([{ type: "absent", protected: true }]), 100);
    assert.equal(score([...absences(1), { type: "absent", protected: true }]), 80);
  });

  it("a protected tardy does not move the score either", () => {
    assert.equal(score([{ type: "tardy", protected: true }]), 100);
  });

  it("a no-show still counts even when flagged protected", () => {
    // Sal, asked directly whether a protected reason should cancel a no-show:
    // "keep it that way". Not calling is procedural and independent of leave.
    assert.equal(score([{ type: "ncns", protected: true }]), 80);
  });

  it("a no-show weighs the same as one unexcused absence, not two", () => {
    assert.equal(score([{ type: "ncns", protected: false }]), 80);
    assert.equal(score([{ type: "ncns", protected: false }]), score(absences(1)));
  });
});

describe("the termination rung comes from tenant config", () => {
  it("reads 5 off the Phes ladder", () => {
    assert.equal(terminationOccurrences(PHES), 5);
  });

  it("gives a 10-rung tenant a 10-rung curve, not a 5-rung one", () => {
    // The assertion that forbids hardcoding 5.
    const long = [
      { occurrence: 5, discipline_type: "absence_warning" },
      { occurrence: 10, discipline_type: "termination" },
    ];
    assert.equal(terminationOccurrences(long), 10);
    const r = scoreAttendanceLadder({ rows: tardies(1), tardySteps: long, unexcusedSteps: long });
    assert.equal(r.score, 90); // 1 of 10, not 1 of 5
  });

  it("falls back to the highest rung when none is typed 'termination'", () => {
    assert.equal(
      terminationOccurrences([
        { occurrence: 3, discipline_type: "absence_warning" },
        { occurrence: 7, discipline_type: "custom" },
      ]),
      7,
    );
  });

  it("prefers the termination rung over a higher rung of another type", () => {
    assert.equal(
      terminationOccurrences([
        { occurrence: 5, discipline_type: "termination" },
        { occurrence: 9, discipline_type: "custom" },
      ]),
      5,
    );
  });

  it("tolerates string occurrences from JSONB", () => {
    assert.equal(terminationOccurrences([{ occurrence: "5" as any, discipline_type: "termination" }]), 5);
  });
});

describe("no ladder means a dash, never a flattering 100", () => {
  it("returns null when the tenant has configured nothing", () => {
    const r = scoreAttendanceLadder({ rows: [], tardySteps: [], unexcusedSteps: [] });
    assert.equal(r.score, null);
    assert.equal(r.driver, null);
  });

  it("returns null for null / undefined / malformed config", () => {
    assert.equal(terminationOccurrences(null), null);
    assert.equal(terminationOccurrences(undefined), null);
    assert.equal(terminationOccurrences([] as any), null);
    assert.equal(terminationOccurrences([{ occurrence: 0 }] as any), null);
    assert.equal(terminationOccurrences([{ occurrence: "abc" } as any]), null);
  });

  it("still scores off one track when only the other is configured", () => {
    const r = scoreAttendanceLadder({ rows: tardies(1), tardySteps: PHES_TARDY, unexcusedSteps: [] });
    assert.equal(r.score, 80);
    assert.equal(r.unexcused_termination_at, null);
  });

  it("still reports the occurrence counts even with no ladder to divide by", () => {
    // The office can act on "3 tardies" even when the score can't render.
    const r = scoreAttendanceLadder({ rows: tardies(3), tardySteps: [], unexcusedSteps: [] });
    assert.equal(r.score, null);
    assert.equal(r.tardy_occurrences, 3);
  });
});

describe("the window never reaches back past the cutover", () => {
  it("floors a long-tenured employee's benefit year at July 1", () => {
    // Rosa Gallegos, hired 2020-04-01: her benefit year opens 2026-04-01, three
    // months before Qleno was the system of record.
    assert.equal(attendanceWindowStart("2020-04-01", "2026-08-21"), CUTOVER_FLOOR_DATE);
    assert.equal(CUTOVER_FLOOR_DATE, "2026-07-01");
  });

  it("leaves an anniversary that already falls after the cutover alone", () => {
    assert.equal(attendanceWindowStart("2023-08-01", "2026-08-21"), "2026-08-01");
  });

  it("uses the anniversary, not the hire date, for a multi-year employee", () => {
    assert.equal(attendanceWindowStart("2023-07-15", "2026-08-21"), "2026-07-15");
  });

  it("stops binding once every anniversary has passed the cutover", () => {
    // A year on, the floor is inert and this is a plain benefit year again.
    assert.equal(attendanceWindowStart("2020-04-01", "2027-08-21"), "2027-04-01");
  });

  it("resets the window — and so the score — on the work anniversary", () => {
    // The day before the anniversary the window still holds the old year;
    // the day after, it has moved on and the score returns to 100.
    assert.equal(attendanceWindowStart("2023-09-10", "2027-09-09"), "2026-09-10");
    assert.equal(attendanceWindowStart("2023-09-10", "2027-09-11"), "2027-09-10");
  });
});

// [tardy-clean-slate 2026-08-21] The tardy track follows the employee handbook
// exactly: occurrences count over the employee's own benefit year, opening on
// their work anniversary, with no cutover floor. The slate was wiped, so there is
// no stale pre-cutover tardy left for a floor to protect against. The unexcused
// track is unchanged and still floored.
describe("tardy window follows the plain benefit year", () => {
  it("opens on the work anniversary even when that predates the cutover", () => {
    // Rosa Gallegos: hired April 2020, so her 2026 benefit year opens 2026-04-01,
    // three months before Qleno was the book of record.
    assert.equal(tardyWindowStart("2020-04-01", "2026-08-21"), "2026-04-01");
  });

  it("gives every employee a different window, keyed to their own hire date", () => {
    const asOf = "2026-08-21";
    assert.equal(tardyWindowStart("2025-08-01", asOf), "2026-08-01");
    assert.equal(tardyWindowStart("2026-01-26", asOf), "2026-01-26");
    assert.equal(tardyWindowStart("2025-06-03", asOf), "2026-06-03");
  });

  it("never applies the cutover floor to tardies", () => {
    const early = tardyWindowStart("2020-04-01", "2026-08-21");
    assert.ok(early < CUTOVER_FLOOR_DATE, "tardy window must be free to precede the floor");
  });

  it("leaves the unexcused window floored, so the two tracks really do differ", () => {
    const hire = "2020-04-01", asOf = "2026-08-21";
    assert.equal(attendanceWindowStart(hire, asOf), CUTOVER_FLOOR_DATE);
    assert.notEqual(tardyWindowStart(hire, asOf), attendanceWindowStart(hire, asOf));
  });

  it("agrees with the unexcused window once the anniversary has passed the cutover", () => {
    // The floor is transitional. An August anniversary is already past it.
    const hire = "2025-08-01", asOf = "2026-08-21";
    assert.equal(tardyWindowStart(hire, asOf), attendanceWindowStart(hire, asOf));
  });
});
