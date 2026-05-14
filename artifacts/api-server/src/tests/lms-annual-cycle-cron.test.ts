/**
 * Annual re-acknowledgment cycle auto-open cron — unit tests.
 *
 * Covers the pure helpers in `lib/lms-annual-cycle-cron.ts`. The
 * DB-touching runAnnualCycleAutoOpen() is exercised manually + via the
 * Playwright e2e by triggering a test cycle in the admin UI; the
 * idempotency guard (unique index on company_id + cycle_year) is
 * tested in `lms-annual-ack.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cycleYearForAutoOpen } from "../lib/lms-annual-ack.js";

describe("cycleYearForAutoOpen", () => {
  it("returns the calendar year of the given date", () => {
    assert.equal(
      cycleYearForAutoOpen(new Date("2026-12-01T15:00:00Z")),
      2026,
    );
  });

  it("uses UTC year (Dec 31 23:59 UTC counts as the same year)", () => {
    assert.equal(
      cycleYearForAutoOpen(new Date("2026-12-31T23:59:59Z")),
      2026,
    );
  });

  it("rolls over to the next year on Jan 1 UTC", () => {
    assert.equal(
      cycleYearForAutoOpen(new Date("2027-01-01T00:00:00Z")),
      2027,
    );
  });

  it("works for the current year by default", () => {
    const y = cycleYearForAutoOpen();
    assert.ok(y >= 2025 && y <= 2100, `unexpected year ${y}`);
  });
});
