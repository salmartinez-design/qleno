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
import { scheduledTimeToMins, clockInMinsLocal } from "../lib/auto-tardy.js";

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
