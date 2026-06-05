/**
 * Per-tech pay-type engine tests (lib/commission-paytype.ts).
 *
 * Ground truth = MaidCentral June 1, 2026 paychecks. Defends:
 *   A. fee_split — gross base × scope% × hour-weighted share, MC %-rounding.
 *   B. allowed_hours — max(allowed-share, actual) × rate.
 *   C. hourly — actual × rate, independent of price/budget.
 *   D. Mixed pay types on ONE job (Cusimano: Norma fee_split, Jose hourly).
 *   E. Breakage deduction (% and flat), default off, floored at $0.
 *   F. Smart defaults + override resolution.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeTechPay,
  computeJobTechPays,
  defaultPayForJob,
  resolveTechPayInput,
  type JobPayContext,
} from "../lib/commission-paytype.js";

describe("pay-type engine — MaidCentral June 1 parity", () => {
  it("fee_split: single tech, full scope % (Ward $186 × 35%)", () => {
    const ctx: JobPayContext = { baseFee: 186, allowedHours: 3.1, totalTechHours: 2.0 };
    const r = computeTechPay(ctx, { user_id: 1, techHours: 2.0, payType: "fee_split", hourlyRate: 0, scopePct: 0.35 });
    assert.equal(r.amount, 65.1);
  });

  it("fee_split: two equal techs split the % (Deep Clean 32% → 16% each on $628.40 gross)", () => {
    const ctx: JobPayContext = { baseFee: 628.4, allowedHours: 8.2, totalTechHours: 6.56 };
    const a = computeTechPay(ctx, { user_id: 1, techHours: 3.28, payType: "fee_split", hourlyRate: 0, scopePct: 0.32 });
    assert.equal(a.amount, 100.54);
    assert.equal(a.effectivePct, 0.16);
  });

  it("fee_split: unequal split rounds % like MC (Norma 3.18/6.35 of 35% on $540 → 17.53% → $94.66)", () => {
    const ctx: JobPayContext = { baseFee: 540, allowedHours: 9.0, totalTechHours: 6.35 };
    const r = computeTechPay(ctx, { user_id: 1, techHours: 3.18, payType: "fee_split", hourlyRate: 0, scopePct: 0.35 });
    assert.equal(r.effectivePct, 0.1753);
    assert.equal(r.amount, 94.66);
  });

  it("allowed_hours: pays the budget when faster (Halper 3.5 allowed > 1.77 actual → $70)", () => {
    const ctx: JobPayContext = { baseFee: 0, allowedHours: 3.5, totalTechHours: 1.77 };
    const r = computeTechPay(ctx, { user_id: 1, techHours: 1.77, payType: "allowed_hours", hourlyRate: 20, scopePct: 0 });
    assert.equal(r.amount, 70.0);
    assert.equal(r.effectiveHours, 3.5);
  });

  it("allowed_hours: pays actual when over budget (8.18 actual > 8 allowed → $163.60)", () => {
    const ctx: JobPayContext = { baseFee: 0, allowedHours: 8.0, totalTechHours: 8.18 };
    const r = computeTechPay(ctx, { user_id: 1, techHours: 8.18, payType: "allowed_hours", hourlyRate: 20, scopePct: 0 });
    assert.equal(r.amount, 163.6);
  });

  it("hourly: flat wage on actual, ignores price/budget (Carpet 2.17 × $25 → $54.25)", () => {
    const ctx: JobPayContext = { baseFee: 120, allowedHours: 1.5, totalTechHours: 2.17 };
    const r = computeTechPay(ctx, { user_id: 1, techHours: 2.17, payType: "hourly", hourlyRate: 25, scopePct: 0 });
    assert.equal(r.amount, 54.25);
  });

  it("mixed pay types on ONE job (Cusimano: Norma fee_split $94.66 + Jose hourly $63.40)", () => {
    const ctx: JobPayContext = { baseFee: 540, allowedHours: 9.0, totalTechHours: 6.35 };
    const rows = computeJobTechPays(ctx, [
      { user_id: 1, techHours: 3.18, payType: "fee_split", hourlyRate: 0, scopePct: 0.35 },
      { user_id: 2, techHours: 3.17, payType: "hourly", hourlyRate: 20, scopePct: 0 },
    ]);
    assert.equal(rows[0].amount, 94.66);
    assert.equal(rows[1].amount, 63.4);
    // The pool is NOT fully distributed — hourly tech is paid independently.
    assert.equal(rows[0].amount + rows[1].amount, 158.06);
  });
});

describe("pay-type engine — breakage deduction", () => {
  const ctx: JobPayContext = { baseFee: 628.4, allowedHours: 8.2, totalTechHours: 6.56 };
  const base = { user_id: 1, techHours: 3.28, payType: "fee_split" as const, hourlyRate: 0, scopePct: 0.32 };

  it("default: no deduction (gross == net)", () => {
    const r = computeTechPay(ctx, base);
    assert.equal(r.grossAmount, 100.54);
    assert.equal(r.deduction, 0);
    assert.equal(r.amount, 100.54);
  });

  it("percent deduction (10% of $100.54 → $90.49)", () => {
    const r = computeTechPay(ctx, { ...base, deductionPct: 0.1 });
    assert.equal(r.deduction, 10.05);
    assert.equal(r.amount, 90.49);
  });

  it("flat deduction ($25 off)", () => {
    const r = computeTechPay(ctx, { ...base, deductionFlat: 25 });
    assert.equal(r.amount, 75.54);
  });

  it("deduction never pushes pay negative", () => {
    const r = computeTechPay(ctx, { ...base, deductionFlat: 9999 });
    assert.equal(r.amount, 0);
  });
});

describe("pay-type engine — smart defaults + override resolution", () => {
  it("commercial defaults to allowed_hours at company $/hr", () => {
    const d = defaultPayForJob({ isCommercial: true, serviceType: "commercial_cleaning", commercialHourlyRate: 20, scopePct: 0 });
    assert.equal(d.payType, "allowed_hours");
    assert.equal(d.hourlyRate, 20);
  });

  it("residential defaults to fee_split at the service-type %", () => {
    const d = defaultPayForJob({ isCommercial: false, serviceType: "deep_clean", commercialHourlyRate: 20, scopePct: 0.32 });
    assert.equal(d.payType, "fee_split");
    assert.equal(d.scopePct, 0.32);
  });

  it("override wins over default (office sets a tech to hourly)", () => {
    const input = resolveTechPayInput({
      user_id: 1, techHours: 2.17,
      overridePayType: "hourly", overrideHourlyRate: 25, overridePct: null,
      defaults: { payType: "allowed_hours", hourlyRate: 20, scopePct: 0 },
    });
    assert.equal(input.payType, "hourly");
    assert.equal(input.hourlyRate, 25);
  });

  it("null override inherits the default", () => {
    const input = resolveTechPayInput({
      user_id: 1, techHours: 3,
      overridePayType: null, overrideHourlyRate: null, overridePct: null,
      defaults: { payType: "fee_split", hourlyRate: 0, scopePct: 0.35 },
    });
    assert.equal(input.payType, "fee_split");
    assert.equal(input.scopePct, 0.35);
  });
});
