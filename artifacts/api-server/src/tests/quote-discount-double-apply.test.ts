import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { quoteAdjustmentsForScope, netQuoteManualAdjustment } from "../lib/quote-adjustments.js";

// [quote-discount-double-apply 2026-08-20]
// Francisco, 2026-08-20: "When a quote includes a discount, Qleno appears to
// take the already-discounted total from the quote and use it as the new base
// rate, then applies the discount again to that amount."
//
// The real quote 632 from that morning: $240 of service, the office typed
// "$30 off", the customer was quoted $210. The job was created with a base
// rate of $210 and a -$30 line on it, and billed $180.
//
// base_fee has to be the price BEFORE the office's adjustment, because the
// adjustment rides along as its own line on the job. These tests pin the two
// halves of that: which adjustment rows count, and what they net to.
function baseFeeFromQuote(totalPrice: number, codedDiscount: number, adjustments: unknown, scopeId: number | null) {
  const net = netQuoteManualAdjustment(adjustments, scopeId);
  return Math.round((totalPrice + codedDiscount - net) * 100) / 100;
}

describe("quote discount is applied exactly once", () => {
  it("recovers the pre-discount rate from the quoted total (quote 632)", () => {
    const adjustments = [{ type: "subtract", amount: 30, reason: "", scope_id: 5 }];
    assert.equal(netQuoteManualAdjustment(adjustments, 5), -30);
    // 210 quoted + 30 given back = the 240 of service that was actually sold.
    assert.equal(baseFeeFromQuote(210, 0, adjustments, 5), 240);
  });

  it("charges the discount once, not twice", () => {
    const adjustments = [{ type: "subtract", amount: 30, reason: "First clean", scope_id: 5 }];
    const baseFee = baseFeeFromQuote(210, 0, adjustments, 5);
    const carried = quoteAdjustmentsForScope(adjustments, 5).reduce((s, a) => s + a.signed, 0);
    // What the customer ends up billed has to equal what they were quoted.
    assert.equal(baseFee + carried, 210);
  });

  it("removes a surcharge the office typed, since it re-lands as its own line", () => {
    const adjustments = [{ type: "add", amount: 45, reason: "Extra floor", scope_id: 5 }];
    assert.equal(netQuoteManualAdjustment(adjustments, 5), 45);
    assert.equal(baseFeeFromQuote(285, 0, adjustments, 5), 240);
  });

  it("ignores adjustments typed against a scope the customer did not book", () => {
    const adjustments = [
      { type: "subtract", amount: 30, reason: "", scope_id: 5 },
      { type: "subtract", amount: 500, reason: "other option", scope_id: 9 },
    ];
    assert.equal(netQuoteManualAdjustment(adjustments, 5), -30);
    assert.equal(baseFeeFromQuote(210, 0, adjustments, 5), 240);
  });

  it("keeps rows with no scope on them, whatever was booked", () => {
    const adjustments = [{ type: "subtract", amount: 30, reason: "", scope_id: null }];
    assert.equal(netQuoteManualAdjustment(adjustments, 5), -30);
    assert.equal(netQuoteManualAdjustment(adjustments, null), -30);
  });

  it("still backs out a coupon code on its own", () => {
    assert.equal(baseFeeFromQuote(180, 20, null, null), 200);
  });

  it("handles a coupon code and a typed discount together", () => {
    const adjustments = [{ type: "subtract", amount: 30, reason: "", scope_id: 5 }];
    // 240 of service, 30 typed off, 20 coupon = 190 quoted.
    assert.equal(baseFeeFromQuote(190, 20, adjustments, 5), 240);
  });

  it("leaves an undiscounted quote exactly where it was", () => {
    assert.equal(netQuoteManualAdjustment([], 5), 0);
    assert.equal(netQuoteManualAdjustment(undefined, 5), 0);
    assert.equal(baseFeeFromQuote(240, 0, [], 5), 240);
  });

  it("skips junk rows instead of poisoning the rate", () => {
    const adjustments = [
      { type: "subtract", amount: 0, scope_id: 5 },
      { type: "subtract", amount: "abc", scope_id: 5 },
      { type: "subtract", scope_id: 5 },
      { type: "subtract", amount: -15, scope_id: 5 },
      { type: "subtract", amount: 30, scope_id: 5 },
    ];
    assert.equal(quoteAdjustmentsForScope(adjustments, 5).length, 1);
    assert.equal(netQuoteManualAdjustment(adjustments, 5), -30);
  });

  it("nets a discount and a surcharge on the same quote", () => {
    const adjustments = [
      { type: "subtract", amount: 30, scope_id: 5 },
      { type: "add", amount: 10, scope_id: 5 },
    ];
    assert.equal(netQuoteManualAdjustment(adjustments, 5), -20);
    assert.equal(baseFeeFromQuote(220, 0, adjustments, 5), 240);
  });
});
