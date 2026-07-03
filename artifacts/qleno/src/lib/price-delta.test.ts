/**
 * Run with: pnpm exec tsx --test src/lib/price-delta.test.ts
 * (uses Node's built-in `node:test` runner — no vitest/jest needed.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computePriceDelta } from "./price-delta.js";

test("Case A: billed_amount is null → no delta, price shows base_fee", () => {
  const r = computePriceDelta({
    amount: 250,
    billedAmount: null,
    hourlyRate: null,
    billingMethod: null,
  });
  assert.equal(r.deltaAmount, null);
  assert.equal(r.display, "$250.00");
});

test("Case A (undefined billed): no delta, price shows base_fee", () => {
  const r = computePriceDelta({
    amount: 180,
    billedAmount: undefined,
    hourlyRate: null,
    billingMethod: null,
  });
  assert.equal(r.deltaAmount, null);
  assert.equal(r.display, "$180.00");
});

test("Case B: billed_amount === base_fee → no delta, price shows base_fee", () => {
  const r = computePriceDelta({
    amount: 200,
    billedAmount: 200,
    hourlyRate: null,
    billingMethod: null,
  });
  assert.equal(r.deltaAmount, null);
  assert.equal(r.display, "$200.00");
});

test("Case B (within epsilon): tiny float drift → no delta", () => {
  // Re-aggregation can produce $200.000001 vs $200 — not worth surfacing.
  const r = computePriceDelta({
    amount: 200,
    billedAmount: 200.0001,
    hourlyRate: null,
    billingMethod: null,
  });
  assert.equal(r.deltaAmount, null);
  assert.equal(r.display, "$200.00");
});

test("Case C (positive): billed > base_fee → delta renders, price shows billed", () => {
  const r = computePriceDelta({
    amount: 200,
    billedAmount: 245,
    hourlyRate: null,
    billingMethod: null,
  });
  assert.equal(r.deltaAmount, 45);
  assert.equal(r.display, "$245.00");
});

test("Case C (negative): billed < base_fee → delta renders negative, price shows billed", () => {
  const r = computePriceDelta({
    amount: 250,
    billedAmount: 230,
    hourlyRate: null,
    billingMethod: null,
  });
  assert.equal(r.deltaAmount, -20);
  assert.equal(r.display, "$230.00");
});

test("Case C: half-dollar threshold — $0.50 difference renders delta", () => {
  const r = computePriceDelta({
    amount: 200,
    billedAmount: 200.5,
    hourlyRate: null,
    billingMethod: null,
  });
  assert.equal(r.deltaAmount, 0.5);
});

test("Case C: under threshold — $0.49 difference does NOT render delta", () => {
  const r = computePriceDelta({
    amount: 200,
    billedAmount: 200.49,
    hourlyRate: null,
    billingMethod: null,
  });
  assert.equal(r.deltaAmount, null);
});

test("Hourly job: shows the full total with the rate as detail, delta suppressed", () => {
  const r = computePriceDelta({
    amount: 200, // base_fee = $50/hr × 4h = the computed total
    billedAmount: 999, // ignored for hourly
    hourlyRate: 50,
    billingMethod: "hourly",
    allowedHours: 4,
  });
  assert.equal(r.isHourly, true);
  assert.equal(r.deltaAmount, null);
  assert.equal(r.display, "$200.00");
  assert.equal(r.hourlyDetail, "$50/hr × 4h");
});

test("Edge: base_fee 0, billed null → no delta, $0 display", () => {
  const r = computePriceDelta({
    amount: 0,
    billedAmount: null,
    hourlyRate: null,
    billingMethod: null,
  });
  assert.equal(r.deltaAmount, null);
  assert.equal(r.display, "$0.00");
});

test("Edge: base_fee 0 with billed set — delta suppressed (no original to compare against)", () => {
  // baseFee > 0 guard means a job created with no base_fee shouldn't
  // suddenly show a "↑ $X" pill the moment billed_amount lands.
  const r = computePriceDelta({
    amount: 0,
    billedAmount: 150,
    hourlyRate: null,
    billingMethod: null,
  });
  assert.equal(r.deltaAmount, null);
  assert.equal(r.display, "$150.00"); // shows billed when present
});
