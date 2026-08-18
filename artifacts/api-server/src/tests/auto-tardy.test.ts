/**
 * Auto-tardy sweep — pure time helpers.
 *
 * The sweep compares jobs.scheduled_time (local text, "HH:MM" or
 * "H:MM AM/PM") against timeclock.clock_in_at (UTC timestamp) in
 * America/Chicago. These tests pin the two conversions; the DB-driven
 * sweep itself is exercised in prod by the nightly cron.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scheduledTimeToMins, clockInMinsLocal, punchMinsLocal } from "../lib/auto-tardy.js";

describe("scheduledTimeToMins", () => {
  it("parses 24h times", () => {
    assert.equal(scheduledTimeToMins("09:00"), 540);
    assert.equal(scheduledTimeToMins("13:30"), 810);
    assert.equal(scheduledTimeToMins("00:05"), 5);
  });
  it("parses 12h AM/PM times", () => {
    assert.equal(scheduledTimeToMins("9:00 AM"), 540);
    assert.equal(scheduledTimeToMins("1:30 PM"), 810);
    assert.equal(scheduledTimeToMins("12:15 AM"), 15);
    assert.equal(scheduledTimeToMins("12:00 PM"), 720);
  });
  it("parses times with seconds", () => {
    assert.equal(scheduledTimeToMins("09:00:00"), 540);
  });
  it("rejects garbage", () => {
    assert.equal(scheduledTimeToMins(""), null);
    assert.equal(scheduledTimeToMins(null), null);
    assert.equal(scheduledTimeToMins("soon"), null);
    assert.equal(scheduledTimeToMins("25:00"), null);
  });
});

describe("clockInMinsLocal (America/Chicago)", () => {
  it("converts a summer (CDT, UTC-5) timestamp", () => {
    // 2026-07-07 14:30 UTC = 09:30 Chicago
    assert.equal(clockInMinsLocal(new Date("2026-07-07T14:30:00Z")), 570);
  });
  it("converts a winter (CST, UTC-6) timestamp", () => {
    // 2026-01-15 15:00 UTC = 09:00 Chicago
    assert.equal(clockInMinsLocal(new Date("2026-01-15T15:00:00Z")), 540);
  });
  it("handles midnight in Chicago", () => {
    // 2026-07-08 05:00 UTC = 00:00 Chicago (Jul 8)
    assert.equal(clockInMinsLocal(new Date("2026-07-08T05:00:00Z")), 0);
  });
});

describe("lateness rule", () => {
  it("20 minutes is within grace; 21 is a tardy", () => {
    const sched = scheduledTimeToMins("9:00 AM")!;
    const graceEdge = clockInMinsLocal(new Date("2026-07-07T14:20:00Z")); // 9:20 CT
    const late = clockInMinsLocal(new Date("2026-07-07T14:21:00Z")); // 9:21 CT
    assert.equal(graceEdge - sched, 20); // not > 20 → no tardy
    assert.equal(late - sched, 21); // > 20 → tardy
  });
});

describe("punchMinsLocal — the two frames timeclock.clock_in_at is stored in", () => {
  // [late-clockin-frame 2026-08-18] Maribel: "0 lates this year" on a profile
  // whose owner had been clocking in 30–55 minutes late all month.
  //
  // `clock_in_at` is `timestamp` (no zone) and holds two different things.
  // Since [clock-tz 2026-06-17] a field punch stores the tenant's WALL CLOCK —
  // 9:55 AM Central is literally 09:55:00, flagged by tz_normalized. Older rows
  // are raw UTC instants: the same punch as 14:55:00.
  //
  // The sweep ran every row through clockInMinsLocal, which converts UTC→local.
  // On a wall-clock row that subtracts the offset a SECOND time.

  it("reads a wall-clock row at face value", () => {
    // 09:55 in the column IS 9:55 AM Central.
    const wall = new Date("2026-08-18T09:55:00Z");
    assert.equal(punchMinsLocal(wall, true), 9 * 60 + 55);
  });

  it("still converts a legacy UTC row", () => {
    // 2026-08-18 14:55 UTC = 9:55 AM Chicago (CDT).
    const utc = new Date("2026-08-18T14:55:00Z");
    assert.equal(punchMinsLocal(utc, false), 9 * 60 + 55);
  });

  it("the two frames agree on the same real-world moment", () => {
    assert.equal(
      punchMinsLocal(new Date("2026-08-18T09:55:00Z"), true),
      punchMinsLocal(new Date("2026-08-18T14:55:00Z"), false),
    );
  });

  it("Vanessa Hernandez, Aug 18: 55 min late, not 245 min early", () => {
    // The exact notification the office received — "clocked in 55 min late for
    // a client's job" — against a 9:00 AM start, from a wall-clock row.
    const sched = scheduledTimeToMins("9:00 AM")!;
    const punch = new Date("2026-08-18T09:55:00Z"); // wall clock, tz_normalized
    assert.equal(punchMinsLocal(punch, true) - sched, 55);

    // What the old code computed: 09:55 read as UTC → 04:55 Central → 245
    // minutes EARLY, so the row never became a tardy candidate and the sweep
    // recorded nothing while the notifications kept firing.
    assert.equal(clockInMinsLocal(punch) - sched, -245);
  });
});
