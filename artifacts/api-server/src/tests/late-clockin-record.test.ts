/**
 * [late-clockin-record 2026-08-18] A late arrival has to survive the tech
 * clocking in.
 *
 * Maribel, 8/18: "Even when we receive a notification that a cleaner has a late
 * check-in, the late check-in is not being recorded in the cleaner's profile or
 * service history. We need the system to: record the late check-in in the
 * cleaner's profile/time-clock history. Keep a record of the service where the
 * late check-in occurred. Add a clearly visible indicator/mark on the service
 * or Job Card when a check-in is recorded as late."
 *
 * The board's LATE chip is a LIVE state — getJobVisualStatus returns "active"
 * from the punch onward — so the moment the tech showed up, every trace of the
 * lateness left the screen. The notification went into a feed and nothing was
 * written down.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const timeclock = read("../routes/timeclock.ts");
const dispatch = read("../routes/dispatch.ts");
const leave = read("../routes/leave.ts");
const index = read("../index.ts");
const schema = read("../../../../lib/db/src/schema/timeclock.ts");

/** The field clock-in route from the lateness measurement through the insert. */
const fieldClockIn = () => {
  const from = timeclock.indexOf("let lateByMin: number | null = null;");
  const to = timeclock.indexOf("// ── Late clock-in notification");
  assert.ok(from > 0 && to > from, "field clock-in block not found — anchors moved");
  return timeclock.slice(from, to);
};

describe("the punch carries the lateness", () => {
  it("timeclock declares late_by_min", () => {
    assert.match(schema, /late_by_min: integer\("late_by_min"\)/);
  });

  it("boot creates the column", () => {
    assert.match(index, /ALTER TABLE timeclock ADD COLUMN IF NOT EXISTS late_by_min integer/);
  });

  it("the field clock-in stamps it on the row", () => {
    const insert = fieldClockIn();
    assert.ok(insert.includes("late_by_min: lateByMin"), "the punch must record how late it was");
  });

  it("the office-keyed clock-in stamps it too", () => {
    const officeInsert = timeclock.slice(timeclock.indexOf('router.post("/office/clock-in"'));
    assert.ok(officeInsert.includes("late_by_min: officeLateByMin"));
  });

  it("measures against the job's real scheduled start, not a generic window", () => {
    // [late-fix 2026-07-15] The 8-minute false positives came from comparing to
    // a hardcoded 8:00 AM "morning" window.
    const block = fieldClockIn();
    assert.ok(block.includes("scheduledStartWallClock"), "must use the job's own scheduled_time");
    assert.ok(block.includes("LATE_THRESHOLD_MINUTES"), "must use the shared 20-minute rule");
  });

  it("the notification reports the value that was stored, not its own copy", () => {
    // One computation, two consumers — the record and the alert can no longer
    // disagree about who was late and by how much.
    const notify = timeclock.slice(
      timeclock.indexOf("// ── Late clock-in notification"),
      timeclock.indexOf("// [geofence-ticket 2026-07-03] Punch recorded outside the fence"),
    );
    assert.ok(notify.includes("if (lateByMin != null)"), "the alert is gated on the stored value");
    assert.ok(!/const lateByMin\b/.test(notify), "the alert must not recompute lateness");
  });
});

describe("the mark reaches the job card", () => {
  it("dispatch selects late_by_min", () => {
    assert.match(dispatch, /late_by_min: timeclockTable\.late_by_min/);
  });

  it("dispatch puts it on clock_entry, where the card reads it", () => {
    const entry = dispatch.slice(dispatch.indexOf("clock_entry: clock ? {"), dispatch.indexOf("technicians,"));
    assert.ok(entry.includes("late_by_min: clock.late_by_min ?? null"));
  });
});

describe("the profile keeps the record, per service", () => {
  it("the attendance summary exposes late_clockins separately from tardy occurrences", () => {
    // These must stay two numbers. `late` is the disciplinary ladder: one
    // occurrence per day at most, first job only, deletable by the office.
    // `late_clockins` is every arrival 20+ min past its job's start.
    assert.ok(leave.includes("late_clockins: tile(lateClockInRows)"));
    assert.ok(leave.includes("late: tile(lateRows)"), "the occurrence tile stays");
  });

  it("each row names the service the late check-in happened on", () => {
    const q = leave.slice(leave.indexOf("let lateClockInRows"), leave.indexOf("const tile = (rows:"));
    assert.ok(q.includes("a.account_name"), "commercial jobs name the account");
    assert.ok(q.includes("c.first_name"), "residential jobs name the client");
    assert.ok(q.includes("clocked in ${Number(r.late_by_min)} min late"), "and by how many minutes");
  });

  it("degrades to an empty list rather than breaking the Attendance tab", () => {
    // The column arrives at boot; a tenant read before that migration lands
    // must not 500 the whole tab.
    const q = leave.slice(leave.indexOf("let lateClockInRows"), leave.indexOf("const tile = (rows:"));
    assert.ok(q.includes("} catch {"), "a missing column is a blank row, not an error");
  });
});
