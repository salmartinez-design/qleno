/**
 * LMS deadline helpers — unit tests.
 *
 * Specifically guards the `Math.floor on negative daysUntil` rule called out
 * in the spec — Math.ceil hides the first day of overdue, which is exactly
 * the case admins look at every morning.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addDays, daysUntil } from "../lib/lms-helpers.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe("addDays", () => {
  it("adds a positive day count and returns a NEW Date (does not mutate)", () => {
    const base = new Date("2026-05-07T12:00:00Z");
    const out = addDays(base, 7);
    assert.equal(base.toISOString(), "2026-05-07T12:00:00.000Z"); // unchanged
    assert.equal(out.toISOString(), "2026-05-14T12:00:00.000Z");
  });

  it("supports negative day counts (subtraction)", () => {
    const base = new Date("2026-05-07T12:00:00Z");
    const out = addDays(base, -3);
    assert.equal(out.toISOString(), "2026-05-04T12:00:00.000Z");
  });

  it("crosses month boundaries cleanly", () => {
    const base = new Date("2026-01-30T00:00:00Z");
    const out = addDays(base, 5);
    assert.equal(out.toISOString(), "2026-02-04T00:00:00.000Z");
  });

  it("crosses year boundaries cleanly", () => {
    const base = new Date("2026-12-30T00:00:00Z");
    const out = addDays(base, 5);
    assert.equal(out.toISOString(), "2027-01-04T00:00:00.000Z");
  });
});

describe("daysUntil", () => {
  it("returns 7 when deadline is exactly 7 full days out (typical enroll)", () => {
    const now = new Date("2026-05-07T12:00:00Z");
    const deadline = new Date(now.getTime() + 7 * ONE_DAY_MS);
    assert.equal(daysUntil(deadline, now), 7);
  });

  it("returns 0 on the day of the deadline (same instant)", () => {
    const now = new Date("2026-05-07T12:00:00Z");
    assert.equal(daysUntil(now, now), 0);
  });

  it("returns -1 the moment the deadline passes (Math.floor — NOT Math.ceil)", () => {
    // The spec calls this out explicitly: Math.ceil would return 0 here,
    // hiding the first day of overdue. Math.floor returns -1 — the admin
    // sees the learner is overdue immediately.
    const now = new Date("2026-05-07T12:00:01Z");
    const deadline = new Date("2026-05-07T12:00:00Z");
    assert.equal(daysUntil(deadline, now), -1);
  });

  it("returns -3 when 3 days past deadline", () => {
    const deadline = new Date("2026-05-01T00:00:00Z");
    const now = new Date("2026-05-04T00:00:00Z");
    // diff = -3 * 86400000 ms exactly → floor(-3) = -3
    assert.equal(daysUntil(deadline, now), -3);
  });

  it("uses Math.floor on positive branch too (a deadline 6.7 days out is 6)", () => {
    const now = new Date("2026-05-07T00:00:00Z");
    const deadline = new Date(now.getTime() + 6.7 * ONE_DAY_MS);
    assert.equal(daysUntil(deadline, now), 6);
  });

  it("accepts ISO string deadlines (DB column is a timestamp serialized as string)", () => {
    const now = new Date("2026-05-07T12:00:00Z");
    assert.equal(daysUntil("2026-05-14T12:00:00Z", now), 7);
  });
});
