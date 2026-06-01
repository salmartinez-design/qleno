/**
 * Cutover 4a — commission auto-compute tests. Pure helpers.
 *
 * Defends:
 *   A. Routing — residential vs commercial by account_id, residential
 *      service-type tiers (deep clean / move-in-out at 32%, standard 35%).
 *   B. Commercial hours signal — allowed_hours by default, actual_hours
 *      when company config says so AND actual > 0.
 *   C. jobTotal waterfall — billed_amount when set, else base_fee.
 *   D. Override — per-job final_pay wins over computed.
 *   E. Skip rules — null assigned_user_id, zero amount.
 *   F. Reconciler — insert/update/void buckets correct; voided existing
 *      rows treated as "no longer applies" (re-insert if computed wants it
 *      back); unchanged rows produce no diff.
 *   G. Rounding — 2-decimal precision.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCommissionRows,
  reconcileCommissionRows,
  type CommissionInputJob,
} from "../lib/commission-compute.js";

const phesRates = {
  res_tech_pay_pct: 0.35,
  deep_clean_pay_pct: 0.32,
  move_in_out_pay_pct: 0.32,
};
const commercialAllowed = {
  commercial_hourly_rate: 20,
  commercial_comp_mode: "allowed_hours" as const,
};
const commercialActual = {
  commercial_hourly_rate: 20,
  commercial_comp_mode: "actual_hours" as const,
};

function job(p: Partial<CommissionInputJob> & { id: number }): CommissionInputJob {
  // Use `in` checks where null is a meaningful value (assigned_user_id,
  // billed_amount, account_id) so callers can override defaults to null.
  return {
    id: p.id,
    assigned_user_id: "assigned_user_id" in p ? p.assigned_user_id! : 32,
    service_type: p.service_type ?? "standard_clean",
    account_id: "account_id" in p ? p.account_id! : null,
    base_fee: p.base_fee ?? "0",
    billed_amount: "billed_amount" in p ? p.billed_amount! : null,
    allowed_hours: p.allowed_hours ?? "0",
    actual_hours: p.actual_hours ?? "0",
    branch_id: p.branch_id ?? 1,
    scheduled_date: p.scheduled_date ?? "2026-04-15",
  };
}

describe("Commission compute — routing", () => {
  it("residential standard clean × 35% on jobTotal", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, billed_amount: "200.00", service_type: "standard_clean" })],
      resRates: phesRates,
      commercial: commercialAllowed,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 70.0); // 200 × 0.35
    assert.equal(rows[0].basis, "residential_pool");
  });

  it("residential deep clean × 32% (tiered)", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, billed_amount: "300.00", service_type: "deep_clean" })],
      resRates: phesRates,
      commercial: commercialAllowed,
    });
    assert.equal(rows[0].amount, 96.0); // 300 × 0.32
  });

  it("residential move_in × 32% (tiered)", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, billed_amount: "300.00", service_type: "move_in" })],
      resRates: phesRates,
      commercial: commercialAllowed,
    });
    assert.equal(rows[0].amount, 96.0);
  });
  it("residential move_out × 32% (tiered)", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, billed_amount: "300.00", service_type: "move_out" })],
      resRates: phesRates,
      commercial: commercialAllowed,
    });
    assert.equal(rows[0].amount, 96.0);
  });

  it("commercial (account_id present) — $/hr × allowed_hours", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, account_id: 5, allowed_hours: "4.0", actual_hours: "0" })],
      resRates: phesRates,
      commercial: commercialAllowed,
    });
    assert.equal(rows[0].amount, 80.0); // 20 × 4
    assert.equal(rows[0].basis, "commercial_hourly");
  });

  it("commercial in actual_hours mode uses actual when > 0", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, account_id: 5, allowed_hours: "4.0", actual_hours: "3.5" })],
      resRates: phesRates,
      commercial: commercialActual,
    });
    assert.equal(rows[0].amount, 70.0); // 20 × 3.5
  });

  it("commercial in actual_hours mode falls back to allowed when actual=0", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, account_id: 5, allowed_hours: "4.0", actual_hours: "0" })],
      resRates: phesRates,
      commercial: commercialActual,
    });
    assert.equal(rows[0].amount, 80.0); // 20 × 4 (allowed, since actual=0)
  });
});

describe("Commission compute — jobTotal waterfall + overrides + skips", () => {
  it("billed_amount takes precedence over base_fee", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, billed_amount: "250.00", base_fee: "200.00" })],
      resRates: phesRates,
      commercial: commercialAllowed,
    });
    assert.equal(rows[0].amount, 87.5); // 250 × 0.35
  });

  it("base_fee used when billed_amount null", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, base_fee: "200.00", billed_amount: null })],
      resRates: phesRates,
      commercial: commercialAllowed,
    });
    assert.equal(rows[0].amount, 70.0);
  });

  it("per-job final_pay override wins over computed", () => {
    const overrides = new Map([["32:1", 50.0]]);
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, billed_amount: "200.00", assigned_user_id: 32 })],
      resRates: phesRates,
      commercial: commercialAllowed,
      overrides,
    });
    assert.equal(rows[0].amount, 50.0);
  });

  it("skip job with null assigned_user_id", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, assigned_user_id: null, billed_amount: "200.00" })],
      resRates: phesRates,
      commercial: commercialAllowed,
    });
    assert.equal(rows.length, 0);
  });

  it("skip zero-amount rows (both billed and base are 0)", () => {
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, billed_amount: "0", base_fee: "0" })],
      resRates: phesRates,
      commercial: commercialAllowed,
    });
    assert.equal(rows.length, 0);
  });
});

describe("Commission reconcile — insert / update / void", () => {
  const computed = [
    { user_id: 32, job_id: 100, amount: 70.0, basis: "residential_pool" as const, branch_id: 1, scheduled_date: "2026-04-15" },
    { user_id: 32, job_id: 101, amount: 80.0, basis: "commercial_hourly" as const, branch_id: 1, scheduled_date: "2026-04-16" },
  ];

  it("nothing existing → all to_insert", () => {
    const r = reconcileCommissionRows({ computed, existing: [] });
    assert.equal(r.to_insert.length, 2);
    assert.equal(r.to_update.length, 0);
    assert.equal(r.to_void.length, 0);
  });

  it("identical existing → no diff (idempotent re-run)", () => {
    const r = reconcileCommissionRows({
      computed,
      existing: [
        { id: 10, user_id: 32, job_id: 100, amount: "70.00", voided_at: null },
        { id: 11, user_id: 32, job_id: 101, amount: "80.00", voided_at: null },
      ],
    });
    assert.equal(r.to_insert.length, 0);
    assert.equal(r.to_update.length, 0);
    assert.equal(r.to_void.length, 0);
  });

  it("amount changed → to_update", () => {
    const r = reconcileCommissionRows({
      computed,
      existing: [
        { id: 10, user_id: 32, job_id: 100, amount: "60.00", voided_at: null }, // was $60, now $70
        { id: 11, user_id: 32, job_id: 101, amount: "80.00", voided_at: null }, // unchanged
      ],
    });
    assert.equal(r.to_update.length, 1);
    assert.equal(r.to_update[0].new_amount, 70.0);
    assert.equal(r.to_insert.length, 0);
  });

  it("job dropped from compute set → to_void", () => {
    const r = reconcileCommissionRows({
      computed: [computed[0]], // only job 100
      existing: [
        { id: 10, user_id: 32, job_id: 100, amount: "70.00", voided_at: null },
        { id: 11, user_id: 32, job_id: 101, amount: "80.00", voided_at: null }, // job 101 no longer in computed
      ],
    });
    assert.equal(r.to_void.length, 1);
    assert.equal(r.to_void[0].job_id, 101);
  });

  it("existing voided row + computed wants it back → to_insert (not update)", () => {
    const r = reconcileCommissionRows({
      computed: [computed[0]],
      existing: [
        { id: 10, user_id: 32, job_id: 100, amount: "70.00", voided_at: new Date() },
      ],
    });
    assert.equal(r.to_insert.length, 1);
    assert.equal(r.to_update.length, 0);
    assert.equal(r.to_void.length, 0);
  });

  it("voided row not in computed → no action (already voided)", () => {
    const r = reconcileCommissionRows({
      computed: [],
      existing: [
        { id: 10, user_id: 32, job_id: 100, amount: "70.00", voided_at: new Date() },
      ],
    });
    assert.equal(r.to_void.length, 0);
  });
});

describe("Commission compute — rounding", () => {
  it("preserves 2-decimal precision (no float drift)", () => {
    // 0.65 × 0.35 = 0.2275 → 0.23 after round2
    const rows = computeCommissionRows({
      jobs: [job({ id: 1, billed_amount: "0.65" })],
      resRates: phesRates,
      commercial: commercialAllowed,
    });
    assert.equal(rows[0].amount, 0.23);
  });
});
