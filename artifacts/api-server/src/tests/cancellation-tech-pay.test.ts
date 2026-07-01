/**
 * Tests for the cancellation tech-pay resolver.
 *
 * Defends:
 *   A. Charging actions (cancel/lockout) pay; free actions don't.
 *   B. Flat mode = fixed dollars regardless of customer charge.
 *   C. Percent mode = % of customer charge.
 *   D. Equal split across the assigned tech count.
 *   E. Zero techs → zero pay (no divide-by-zero).
 *   F. Rounding to 2 decimals.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCancellationTechPay,
  type CancellationTechPayMode,
} from "../lib/cancellation-tech-pay.js";
import type { CancelAction } from "../lib/cancellation-policy.js";

const flatPhes = { mode: "flat" as CancellationTechPayMode, amount: 60 };

describe("Cancellation tech-pay — action routing", () => {
  it("free actions pay nothing", () => {
    for (const action of ["move", "bump", "skip", "cancel_service"] as CancelAction[]) {
      const r = resolveCancellationTechPay({
        action, customerChargeAmount: 200, numTechs: 1, policy: flatPhes,
      });
      assert.equal(r.total_pay, 0, `${action} should not pay`);
      assert.equal(r.pays_tech, false, `${action} pays_tech`);
    }
  });

  // [cancel-fee-policy 2026-07-01] Both charging actions pay the flat fee by
  // default (Sal's rule: an inside-48hr cancel charges the customer full + pays
  // the tech $60). Applies to cancel AND lockout.
  it("cancel and lockout both pay by default", () => {
    for (const action of ["cancel", "lockout"] as CancelAction[]) {
      const r = resolveCancellationTechPay({
        action, customerChargeAmount: 200, numTechs: 1, policy: flatPhes,
      });
      assert.equal(r.total_pay, 60, `${action} should pay the flat fee`);
      assert.equal(r.pays_tech, true);
    }
  });
});

describe("Cancellation tech-pay — payTech override (waive)", () => {
  it("payTech:false waives the tech fee on a cancel", () => {
    const r = resolveCancellationTechPay({
      action: "cancel", customerChargeAmount: 200, numTechs: 1, policy: flatPhes,
      payTech: false,
    });
    assert.equal(r.total_pay, 0, "office waived the tech's cancellation fee");
    assert.equal(r.pays_tech, false);
  });

  it("payTech:false waives the tech fee on a lockout too", () => {
    const r = resolveCancellationTechPay({
      action: "lockout", customerChargeAmount: 200, numTechs: 1, policy: flatPhes,
      payTech: false,
    });
    assert.equal(r.total_pay, 0);
    assert.equal(r.pays_tech, false);
  });

  it("payTech:true is the same as the default (pays)", () => {
    const r = resolveCancellationTechPay({
      action: "cancel", customerChargeAmount: 200, numTechs: 1, policy: flatPhes,
      payTech: true,
    });
    assert.equal(r.total_pay, 60);
    assert.equal(r.pays_tech, true);
  });

  it("free actions never pay even with payTech:true", () => {
    for (const action of ["move", "bump", "skip", "cancel_service"] as CancelAction[]) {
      const r = resolveCancellationTechPay({
        action, customerChargeAmount: 200, numTechs: 1, policy: flatPhes, payTech: true,
      });
      assert.equal(r.pays_tech, false, `${action} must never pay`);
    }
  });
});

// Payout math is action-independent (mode/amount/numTechs). Exercise it via
// `lockout`, which pays by default post-2026-07-01; a plain cancel would
// short-circuit to $0 before the math and defeat the point of these cases.
describe("Cancellation tech-pay — modes", () => {
  it("flat mode = fixed dollars regardless of customer charge", () => {
    const a = resolveCancellationTechPay({
      action: "lockout", customerChargeAmount: 50, numTechs: 1, policy: flatPhes,
    });
    const b = resolveCancellationTechPay({
      action: "lockout", customerChargeAmount: 500, numTechs: 1, policy: flatPhes,
    });
    assert.equal(a.total_pay, 60);
    assert.equal(b.total_pay, 60);
  });

  it("percent mode = % of customer charge", () => {
    const r = resolveCancellationTechPay({
      action: "lockout", customerChargeAmount: 200, numTechs: 1,
      policy: { mode: "percent", amount: 40 },
    });
    assert.equal(r.total_pay, 80); // 200 × 0.40
  });

  it("percent mode at 0% → zero pay, pays_tech=false", () => {
    const r = resolveCancellationTechPay({
      action: "lockout", customerChargeAmount: 200, numTechs: 1,
      policy: { mode: "percent", amount: 0 },
    });
    assert.equal(r.total_pay, 0);
    assert.equal(r.pays_tech, false);
  });
});

describe("Cancellation tech-pay — splitting", () => {
  it("flat $60 / 2 techs = $30 each", () => {
    const r = resolveCancellationTechPay({
      action: "lockout", customerChargeAmount: 200, numTechs: 2, policy: flatPhes,
    });
    assert.equal(r.total_pay, 60);
    assert.equal(r.pay_per_tech, 30);
  });

  it("flat $60 / 3 techs = $20 each (clean divide)", () => {
    const r = resolveCancellationTechPay({
      action: "lockout", customerChargeAmount: 200, numTechs: 3, policy: flatPhes,
    });
    assert.equal(r.pay_per_tech, 20);
  });

  it("percent 33.33% / 3 techs handles fractional split", () => {
    const r = resolveCancellationTechPay({
      action: "lockout", customerChargeAmount: 100, numTechs: 3,
      policy: { mode: "percent", amount: 33.33 },
    });
    // 100 × 0.3333 = 33.33 → split 3 → 11.11
    assert.equal(r.total_pay, 33.33);
    assert.equal(r.pay_per_tech, 11.11);
  });
});

describe("Cancellation tech-pay — edge cases", () => {
  it("zero techs → zero pay (no divide-by-zero)", () => {
    const r = resolveCancellationTechPay({
      action: "cancel", customerChargeAmount: 200, numTechs: 0, policy: flatPhes,
    });
    assert.equal(r.total_pay, 0);
    assert.equal(r.pay_per_tech, 0);
    assert.equal(r.pays_tech, false);
  });

  it("negative customer charge clamps to 0 (percent mode)", () => {
    const r = resolveCancellationTechPay({
      action: "lockout", customerChargeAmount: -50, numTechs: 1,
      policy: { mode: "percent", amount: 50 },
    });
    assert.equal(r.total_pay, 0);
  });

  it("negative flat amount clamps to 0", () => {
    const r = resolveCancellationTechPay({
      action: "lockout", customerChargeAmount: 200, numTechs: 1,
      policy: { mode: "flat", amount: -60 },
    });
    assert.equal(r.total_pay, 0);
  });
});
