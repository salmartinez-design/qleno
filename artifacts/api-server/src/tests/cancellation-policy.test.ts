/**
 * Tests for the cancellation policy resolver.
 *
 * Defends:
 *   A. Action routing — only 'cancel' and 'lockout' charge; others free.
 *   B. Per-client override beats company default.
 *   C. Lockout uses lockout_fee_pct, cancel uses cancel_fee_pct.
 *   D. cancel_service flags affects_future_jobs.
 *   E. Status transitions — charged → 'complete' (per Sal); free → 'cancelled'.
 *   F. Rounding to 2 decimals.
 *   G. Zero / negative job amount handled gracefully.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCancellationPolicy,
  CANCEL_ACTIONS,
  CHARGING_ACTIONS,
  FUTURE_AFFECTING_ACTIONS,
  type CancelAction,
} from "../lib/cancellation-policy.js";

const phesDefaults = {
  companyDefaultCancelFeePct: 100,
  companyDefaultLockoutFeePct: 100,
  clientCancelFeePct: null,
  clientLockoutFeePct: null,
};

describe("Cancellation policy — action routing", () => {
  it("only 'cancel' and 'lockout' are charging actions", () => {
    assert.deepEqual([...CHARGING_ACTIONS].sort(), ["cancel", "lockout"]);
  });

  it("only 'cancel_service' affects future jobs", () => {
    assert.deepEqual([...FUTURE_AFFECTING_ACTIONS], ["cancel_service"]);
  });

  it("free actions return charge=0 and status=cancelled", () => {
    for (const action of ["move", "bump", "skip", "cancel_service"] as CancelAction[]) {
      const r = resolveCancellationPolicy({ action, jobAmount: 200, ...phesDefaults });
      assert.equal(r.charge_amount, 0, `${action} should not charge`);
      assert.equal(r.charges_customer, false, `${action} charges_customer`);
      assert.equal(r.next_job_status, "cancelled", `${action} should cancel`);
    }
  });

  it("'cancel' charges full at 100% — status=complete (per Sal's policy)", () => {
    const r = resolveCancellationPolicy({ action: "cancel", jobAmount: 200, ...phesDefaults });
    assert.equal(r.charge_amount, 200);
    assert.equal(r.fee_pct_applied, 100);
    assert.equal(r.charges_customer, true);
    assert.equal(r.next_job_status, "complete");
    assert.equal(r.affects_future_jobs, false);
  });

  it("'lockout' charges full at 100% — status=complete", () => {
    const r = resolveCancellationPolicy({ action: "lockout", jobAmount: 200, ...phesDefaults });
    assert.equal(r.charge_amount, 200);
    assert.equal(r.next_job_status, "complete");
  });

  it("'cancel_service' is free + affects future", () => {
    const r = resolveCancellationPolicy({ action: "cancel_service", jobAmount: 200, ...phesDefaults });
    assert.equal(r.charge_amount, 0);
    assert.equal(r.affects_future_jobs, true);
    assert.equal(r.next_job_status, "cancelled");
  });
});

describe("Cancellation policy — per-client overrides", () => {
  it("client cancel_fee_pct=50 overrides company default", () => {
    const r = resolveCancellationPolicy({
      action: "cancel",
      jobAmount: 200,
      ...phesDefaults,
      clientCancelFeePct: 50,
    });
    assert.equal(r.charge_amount, 100); // 200 × 0.50
    assert.equal(r.fee_pct_applied, 50);
  });

  it("client lockout_fee_pct=0 (waived) — still goes to status=complete", () => {
    const r = resolveCancellationPolicy({
      action: "lockout",
      jobAmount: 200,
      ...phesDefaults,
      clientLockoutFeePct: 0,
    });
    assert.equal(r.charge_amount, 0);
    assert.equal(r.fee_pct_applied, 0);
    assert.equal(r.charges_customer, false); // explicit waive
    assert.equal(r.next_job_status, "complete"); // still a charging-class action
  });

  it("client cancel override does NOT apply to lockout action (different field)", () => {
    const r = resolveCancellationPolicy({
      action: "lockout",
      jobAmount: 200,
      ...phesDefaults,
      clientCancelFeePct: 25,
      // clientLockoutFeePct stays null → uses company default 100
    });
    assert.equal(r.charge_amount, 200);
    assert.equal(r.fee_pct_applied, 100);
  });
});

describe("Cancellation policy — edge cases", () => {
  it("zero job amount → zero charge even on charging actions", () => {
    const r = resolveCancellationPolicy({ action: "cancel", jobAmount: 0, ...phesDefaults });
    assert.equal(r.charge_amount, 0);
    assert.equal(r.charges_customer, false);
    assert.equal(r.next_job_status, "complete"); // still a charging-class action
  });

  it("negative job amount clamps to 0", () => {
    const r = resolveCancellationPolicy({ action: "cancel", jobAmount: -50, ...phesDefaults });
    assert.equal(r.charge_amount, 0);
  });

  it("rounds to 2 decimals (no float drift)", () => {
    const r = resolveCancellationPolicy({
      action: "cancel",
      jobAmount: 0.65,
      ...phesDefaults,
      clientCancelFeePct: 35,
    });
    // 0.65 × 0.35 = 0.2275 → round2 → 0.23
    assert.equal(r.charge_amount, 0.23);
  });

  it("all 6 CANCEL_ACTIONS resolve without throwing", () => {
    for (const action of CANCEL_ACTIONS) {
      const r = resolveCancellationPolicy({ action, jobAmount: 100, ...phesDefaults });
      assert.ok(["cancelled", "complete"].includes(r.next_job_status));
    }
    assert.equal(CANCEL_ACTIONS.length, 6);
  });
});
