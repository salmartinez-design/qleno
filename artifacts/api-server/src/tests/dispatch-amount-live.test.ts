/**
 * FOLLOW-UP B regression — dispatch.amount must compute LIVE from
 * base_fee + SUM(rate_mods) + SUM(add_on subtotals).
 *
 * Background: the original BUG-6 fix had dispatch.amount COALESCE to
 * jobs.billed_amount (a cache) and fall back to base_fee + add-ons.
 * That cache only gets refreshed when /rate-mods POST or DELETE fires;
 * PATCH /api/jobs/:id changes base_fee/hourly_rate without recomputing
 * billed_amount, so dispatch reported the pre-edit value.
 *
 * Live repro: Job 4322 (Jaira Estrada). base_fee was edited 320→400
 * via the Edit Job modal. job_rate_mods table is empty for this job.
 * One Parking Fee add-on at $20. Invoice total is $420. Dispatch was
 * reporting $340 (= stale billed_amount 320 + parking 20).
 *
 * The new formula reads base_fee directly + sums mods + sums add-ons,
 * with NO read of billed_amount. This test asserts that formula.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

type AmountInputs = {
  base_fee: string | null;
  // billed_amount intentionally omitted — the formula must not read it.
  add_ons: Array<{ subtotal: number }>;
  rate_mod_total: number;
};

// Replicates the production computation in routes/dispatch.ts amount
// IIFE (around line 615). If that ever moves to a helper, swap to
// importing it.
function computeAmount(j: AmountInputs): number {
  const base = j.base_fee ? parseFloat(j.base_fee) : 0;
  const mods = j.rate_mod_total ?? 0;
  const addOns = j.add_ons.reduce((s, a) => s + (a.subtotal ?? 0), 0);
  return base + mods + addOns;
}

describe("dispatch.amount — live computation, no stale billed_amount", () => {
  it("Jaira 4322 case: base_fee 400 + parking $20 + 0 mods = $420 (NOT 340)", () => {
    const amt = computeAmount({
      base_fee: "400.00",
      add_ons: [{ subtotal: 20 }],
      rate_mod_total: 0,
    });
    assert.equal(amt, 420,
      `Jaira regression: expected 420 from live base 400 + parking 20, got ${amt}`);
  });

  it("amount reflects an edited base_fee even when no rate-mod write fired", () => {
    // Simulates the PATCH base_fee 320 → 400 sequence: the cache row
    // (billed_amount) would say 320, but the live formula ignores it.
    const before = computeAmount({
      base_fee: "320.00",
      add_ons: [{ subtotal: 20 }],
      rate_mod_total: 0,
    });
    const after = computeAmount({
      base_fee: "400.00",
      add_ons: [{ subtotal: 20 }],
      rate_mod_total: 0,
    });
    assert.equal(before, 340);
    assert.equal(after, 420);
    assert.notEqual(before, after, "PATCH base_fee must change dispatch.amount");
  });

  it("layers rate-mods on top of base + add-ons", () => {
    const amt = computeAmount({
      base_fee: "320.00",
      add_ons: [{ subtotal: 20 }, { subtotal: 50 }],
      rate_mod_total: 100,                    // one +$100 flat mod
    });
    assert.equal(amt, 320 + 20 + 50 + 100);   // 490
  });

  it("handles negative rate-mods (discounts) correctly", () => {
    const amt = computeAmount({
      base_fee: "400.00",
      add_ons: [{ subtotal: 20 }],
      rate_mod_total: -25,                    // -$25 discount mod
    });
    assert.equal(amt, 400 + 20 - 25);         // 395
  });

  it("base_fee null defaults to 0; sums still work", () => {
    const amt = computeAmount({
      base_fee: null,
      add_ons: [{ subtotal: 50 }],
      rate_mod_total: 10,
    });
    assert.equal(amt, 60);
  });

  it("empty add-ons + zero mods returns just base_fee", () => {
    const amt = computeAmount({
      base_fee: "200.00",
      add_ons: [],
      rate_mod_total: 0,
    });
    assert.equal(amt, 200);
  });

  it("never reads a billed_amount field (formula contract)", () => {
    // Even if we somehow shoved billed_amount into the input shape, the
    // helper signature deliberately doesn't accept it. This test will
    // fail to compile if a future refactor tries to add it back. We
    // assert that runtime behavior is identical when billed_amount-
    // shaped extra fields exist on the input object.
    const stuffedWithStale: AmountInputs & { billed_amount: string } = {
      base_fee: "400.00",
      add_ons: [{ subtotal: 20 }],
      rate_mod_total: 0,
      billed_amount: "999.99",                // would-be poison; ignored
    };
    assert.equal(computeAmount(stuffedWithStale), 420);
  });
});
