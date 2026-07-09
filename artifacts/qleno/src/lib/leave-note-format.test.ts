/**
 * Leave note parser tests (Phase 4). Run: npx tsx --test leave-note-format.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLeaveNote, leaveBucketLabel } from "./leave-note-format.ts";

describe("parseLeaveNote — MC import format", () => {
  it("usage/pto", () => {
    const p = parseLeaveNote("[MC import #11] usage/pto — Approved");
    assert.equal(p.bucketSlug, "pto");
    assert.equal(p.kind, "Used");
    assert.equal(p.clean, "Approved");
  });
  it("accrual/plawa", () => {
    const p = parseLeaveNote("[MC import #13] accrual/plawa — Employee has been here 90 days");
    assert.equal(p.bucketSlug, "plawa");
    assert.equal(p.kind, "Accrued");
    assert.equal(p.kindTone, "good");
    assert.equal(p.clean, "Employee has been here 90 days");
  });
  it("adjustment/pto", () => {
    const p = parseLeaveNote("[MC import #13] adjustment/pto — Update after PTO Audit");
    assert.equal(p.kind, "Adjustment");
    assert.equal(p.kindTone, "warn");
  });
  it("payout/pto cash-out", () => {
    const p = parseLeaveNote("[MC import #1] payout/pto — All hours were cashed out - MC");
    assert.equal(p.kind, "Payout");
    assert.equal(p.clean, "All hours were cashed out - MC");
  });
  it("cancelled/pto", () => {
    const p = parseLeaveNote("[MC import #9] cancelled/pto — Cancelled");
    assert.equal(p.kind, "Cancelled");
    assert.equal(p.kindTone, "bad");
  });
  it("unspecified with (no note) placeholder → clean empty", () => {
    const p = parseLeaveNote("[MC import #10] unspecified/plawa — (no note)");
    assert.equal(p.kind, "Recorded");
    assert.equal(p.clean, "");
  });
});

describe("parseLeaveNote — app-approved format", () => {
  it("full_day", () => {
    const p = parseLeaveNote("leave_request #5 approved (full_day) usage/pto");
    assert.equal(p.bucketSlug, "pto");
    assert.equal(p.kind, "Used");
    assert.equal(p.clean, "Approved");
  });
  it("morning half-day", () => {
    const p = parseLeaveNote("leave_request #8 approved (morning) usage/plawa");
    assert.equal(p.bucketSlug, "plawa");
    assert.equal(p.clean, "Approved (morning)");
  });
});

describe("parseLeaveNote — fallbacks", () => {
  it("unknown text passes through clean, no bucket", () => {
    const p = parseLeaveNote("some free-form office note");
    assert.equal(p.bucketSlug, null);
    assert.equal(p.kind, "");
    assert.equal(p.clean, "some free-form office note");
  });
  it("null/empty safe", () => {
    assert.equal(parseLeaveNote(null).clean, "");
    assert.equal(parseLeaveNote(undefined).bucketSlug, null);
  });
});

describe("leaveBucketLabel", () => {
  it("maps slugs to display labels", () => {
    assert.equal(leaveBucketLabel("pto_phes"), "PTO");
    assert.equal(leaveBucketLabel("plawa"), "Sick");
    assert.equal(leaveBucketLabel("unpaid_leave"), "Unpaid");
    assert.equal(leaveBucketLabel("unexcused"), "Unexcused");
  });
});
