/**
 * Booking-complete conversion message — unit tests.
 *
 * Run (no server, no DB):
 *   npx tsx --test artifacts/qleno/src/lib/booking-conversion.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBookingCompleteMessage } from "./booking-conversion.js";

const PHES = "phes-cleaning";

// Real shapes returned by the three booking endpoints (routes/public.ts).
const CONFIRM_RESULT = {
  ok: true, client_id: 42, job_id: 9001, recurring_job_id: null, home_id: 7,
  pricing: { base_price: 300, final_total: 320 },
  first_visit_total: 416, quote_id: 555,
};
const LEGACY_BOOK_RESULT = {
  ok: true, client_id: 42, job_id: 9002, home_id: 7,
  pricing: { final_total: 250 }, first_visit_total: 250,
};
const COMMERCIAL_RESULT = {
  ok: true, client_id: 42, job_id: 9003,
  pricing: { final_total: 180 }, first_visit_total: 180,
};
// Walkthrough = commercial quote request. No job, no payment.
const WALKTHROUGH_RESULT = { ok: true, client_id: 42 };

describe("buildBookingCompleteMessage", () => {
  it("fires on a Stripe-confirmed booking with the exact contract shape", () => {
    const msg = buildBookingCompleteMessage(PHES, CONFIRM_RESULT);
    assert.deepEqual(msg, {
      type: "qleno-booking-complete",
      bookingId: "9001",
      quoteId: 555,
      value: 416,
      currency: "USD",
    });
  });

  it("uses the amount actually booked, not the pre-multiplier total", () => {
    // condition multiplier 1.3 → booked 416, pricing.final_total still 320.
    assert.equal(buildBookingCompleteMessage(PHES, CONFIRM_RESULT)!.value, 416);
  });

  it("fires on the legacy (Stripe-disabled) and commercial paths", () => {
    assert.equal(buildBookingCompleteMessage(PHES, LEGACY_BOOK_RESULT)!.bookingId, "9002");
    assert.equal(buildBookingCompleteMessage(PHES, LEGACY_BOOK_RESULT)!.value, 250);
    assert.equal(buildBookingCompleteMessage(PHES, COMMERCIAL_RESULT)!.bookingId, "9003");
    assert.equal(buildBookingCompleteMessage(PHES, COMMERCIAL_RESULT)!.value, 180);
  });

  it("does NOT fire for a walkthrough quote request (no job, no payment)", () => {
    assert.equal(buildBookingCompleteMessage(PHES, WALKTHROUGH_RESULT), null);
  });

  it("does NOT fire without a booking id — phes.io would drop the message anyway", () => {
    for (const missing of [null, undefined, ""]) {
      assert.equal(buildBookingCompleteMessage(PHES, { ok: true, job_id: missing, first_visit_total: 300 }), null);
    }
  });

  it("does NOT fire for another tenant", () => {
    assert.equal(buildBookingCompleteMessage("some-other-cleaner", CONFIRM_RESULT), null);
    assert.equal(buildBookingCompleteMessage("", CONFIRM_RESULT), null);
  });

  it("does NOT fire without a result", () => {
    assert.equal(buildBookingCompleteMessage(PHES, null), null);
    assert.equal(buildBookingCompleteMessage(PHES, undefined), null);
  });

  it("falls back to pricing.final_total, then to 0 — never NaN or negative", () => {
    assert.equal(buildBookingCompleteMessage(PHES, { job_id: 1, pricing: { final_total: 199.99 } })!.value, 199.99);
    assert.equal(buildBookingCompleteMessage(PHES, { job_id: 1 })!.value, 0);
    assert.equal(buildBookingCompleteMessage(PHES, { job_id: 1, first_visit_total: "not-a-number" })!.value, 0);
    assert.equal(buildBookingCompleteMessage(PHES, { job_id: 1, first_visit_total: -5 })!.value, 0);
  });

  it("always sends bookingId as a string, whatever the API returns", () => {
    assert.equal(buildBookingCompleteMessage(PHES, { job_id: 9004 })!.bookingId, "9004");
    assert.equal(buildBookingCompleteMessage(PHES, { job_id: "9005" })!.bookingId, "9005");
    assert.equal(buildBookingCompleteMessage(PHES, { jobId: 9006 })!.bookingId, "9006");
  });
});
