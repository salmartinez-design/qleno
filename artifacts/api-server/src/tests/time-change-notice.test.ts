import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSameDayTimeChange } from "../lib/time-change-notice.js";

// The note that Maribel asked for fires ONLY on a same-day time move. These pin
// that boundary: same-day time bump → true; cross-day reschedule → false;
// no real change → false.
describe("time-change notice — isSameDayTimeChange", () => {
  it("same day, time moved → true", () => {
    assert.equal(isSameDayTimeChange("2026-06-30", "09:00:00", "2026-06-30", "11:30:00"), true);
  });

  it("same day, time moved (HH:MM forms) → true", () => {
    assert.equal(isSameDayTimeChange("2026-06-30", "09:00", "2026-06-30", "10:00"), true);
  });

  it("same day, time unchanged → false (e.g. only the tech changed)", () => {
    assert.equal(isSameDayTimeChange("2026-06-30", "09:00:00", "2026-06-30", "09:00:00"), false);
  });

  it("cross-day reschedule (date moved) → false — that's the separate email flow", () => {
    assert.equal(isSameDayTimeChange("2026-06-30", "09:00:00", "2026-07-02", "09:00:00"), false);
  });

  it("cross-day AND time moved → still false (date move dominates)", () => {
    assert.equal(isSameDayTimeChange("2026-06-30", "09:00:00", "2026-07-02", "14:00:00"), false);
  });

  it("seconds-only difference within the same minute → false", () => {
    assert.equal(isSameDayTimeChange("2026-06-30", "09:00:10", "2026-06-30", "09:00:45"), false);
  });

  it("a time added where there was none, same day → true", () => {
    assert.equal(isSameDayTimeChange("2026-06-30", null, "2026-06-30", "09:00:00"), true);
  });

  it("time cleared (no new time) → false (nothing to notify about)", () => {
    assert.equal(isSameDayTimeChange("2026-06-30", "09:00:00", "2026-06-30", null), false);
  });

  it("handles pg Date objects for the date side", () => {
    assert.equal(isSameDayTimeChange(new Date("2026-06-30T00:00:00Z"), "09:00:00", new Date("2026-06-30T00:00:00Z"), "10:00:00"), true);
    assert.equal(isSameDayTimeChange(new Date("2026-06-30T00:00:00Z"), "09:00:00", new Date("2026-07-01T00:00:00Z"), "10:00:00"), false);
  });
});
