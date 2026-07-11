// [discount-commission-fix 2026-07-11] Proves the fix: a discount must not dock
// the cleaner's pay. For residential jobs base_fee doubles as the commission
// base, so a baked-in discount lowers commission. The fix pins commission_base
// to the PRE-discount amount at quote-convert, and the pay engine already
// prefers commission_base over base_fee/billed_amount. These are pure engine
// tests — no DB.
//
//   DATABASE_URL=postgres://stub@stub/stub tsx --test src/tests/discount-commission.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCommissionRows, type CommissionInputJob } from "../lib/commission-compute.js";

const phesRates = { res_tech_pay_pct: 0.35, deep_clean_pay_pct: 0.32, move_in_out_pay_pct: 0.32 };
const commercial = { commercial_hourly_rate: 20, commercial_comp_mode: "allowed_hours" as const };

function job(p: Partial<CommissionInputJob> & { id: number }): CommissionInputJob {
  return {
    id: p.id,
    assigned_user_id: "assigned_user_id" in p ? p.assigned_user_id! : 32,
    service_type: p.service_type ?? "standard_clean",
    account_id: "account_id" in p ? p.account_id! : null,
    base_fee: p.base_fee ?? "0",
    billed_amount: "billed_amount" in p ? p.billed_amount! : null,
    commission_base: "commission_base" in p ? p.commission_base! : null,
    allowed_hours: p.allowed_hours ?? "0",
    actual_hours: p.actual_hours ?? "0",
    branch_id: p.branch_id ?? 1,
    scheduled_date: p.scheduled_date ?? "2026-04-15",
  };
}

// Service $400, 10% promo = $40 off → client pays $360 (the discounted base_fee).
describe("discount must not dock cleaner pay", () => {
  it("BUG shape: discounted base_fee with no commission_base underpays the cleaner", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, base_fee: "360.00", billed_amount: "360.00" })], // no commission_base
      resRates: phesRates,
      commercial,
    });
    assert.equal(rows[0].amount, 126.0); // 360 × 0.35 — $14 short (the bug)
  });

  it("FIX shape: commission_base pinned to the pre-discount $400 pays the full amount", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, base_fee: "360.00", billed_amount: "360.00", commission_base: "400.00" })],
      resRates: phesRates,
      commercial,
    });
    assert.equal(rows[0].amount, 140.0); // 400 × 0.35 — full service price
  });

  it("the difference equals the discount × the fee-split rate (the amount the cleaner was losing)", () => {
    const discounted = computeCommissionRows({
      jobs: [job({ id: 1, base_fee: "360.00", billed_amount: "360.00" })],
      resRates: phesRates, commercial,
    })[0].amount;
    const fixed = computeCommissionRows({
      jobs: [job({ id: 1, base_fee: "360.00", billed_amount: "360.00", commission_base: "400.00" })],
      resRates: phesRates, commercial,
    })[0].amount;
    assert.equal(Math.round((fixed - discounted) * 100) / 100, 14.0); // $40 discount × 0.35
  });

  it("no discount (commission_base null) is unchanged — engine falls back to base_fee", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, base_fee: "400.00", billed_amount: "400.00" })],
      resRates: phesRates, commercial,
    });
    assert.equal(rows[0].amount, 140.0); // 400 × 0.35, fallback path untouched
  });
});
