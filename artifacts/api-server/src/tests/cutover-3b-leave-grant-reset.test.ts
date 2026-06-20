/**
 * Time-off grant + calendar-year reset engine (Phes model).
 * Pure tests — no DB. Names per the buckets seeded for co1.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  completedYearsOfService,
  entitlementHours,
  planLeaveGrant,
  type GrantBucket,
} from "../lib/leave-grant-reset.js";

const ASOF = "2026-06-20";
const CEILING = 80;

const PLAWA: GrantBucket = {
  slug: "plawa",
  accrual_mode: "flat_grant",
  annual_cap_hours: 40,
  waiting_period_days: 90,
  carryover_allowed: false,
};
const PTO: GrantBucket = {
  slug: "pto_phes",
  accrual_mode: "flat_grant",
  annual_cap_hours: 40,
  waiting_period_days: 365,
  carryover_allowed: true,
};
const UNPAID: GrantBucket = {
  slug: "unpaid_leave",
  accrual_mode: "flat_grant",
  annual_cap_hours: 40,
  waiting_period_days: 0,
  carryover_allowed: false,
};

describe("completedYearsOfService", () => {
  it("Diana 2024-06-18 → 2 years by 2026-06-20", () => {
    assert.equal(completedYearsOfService("2024-06-18", ASOF), 2);
  });
  it("anniversary not yet reached counts one fewer", () => {
    assert.equal(completedYearsOfService("2024-06-18", "2026-06-17"), 1);
  });
  it("Alma 2025-06-03 → 1 year by 2026-06-20", () => {
    assert.equal(completedYearsOfService("2025-06-03", ASOF), 1);
  });
  it("hired this year → 0", () => {
    assert.equal(completedYearsOfService("2026-05-01", ASOF), 0);
  });
});

describe("entitlementHours — PLAWA (sick, 40 front-loaded after 90d, no carryover)", () => {
  it("past 90 days → 40", () => {
    assert.equal(entitlementHours(PLAWA, "2026-01-26", ASOF, CEILING), 40);
  });
  it("within 90 days → 0 (not eligible)", () => {
    assert.equal(entitlementHours(PLAWA, "2026-05-25", ASOF, CEILING), 0);
  });
  it("never scales with tenure (carryover false)", () => {
    assert.equal(entitlementHours(PLAWA, "2019-09-01", ASOF, CEILING), 40);
  });
  it("null hire date → 0", () => {
    assert.equal(entitlementHours(PLAWA, null, ASOF, CEILING), 0);
  });
});

describe("entitlementHours — PTO (40 @ 1yr → 80 @ 2yr, hard cap 80)", () => {
  it("under 1 year → 0", () => {
    assert.equal(entitlementHours(PTO, "2025-08-01", ASOF, CEILING), 0);
  });
  it("1 year (Alma) → 40", () => {
    assert.equal(entitlementHours(PTO, "2025-06-03", ASOF, CEILING), 40);
  });
  it("2 years (Diana) → 80", () => {
    assert.equal(entitlementHours(PTO, "2024-06-18", ASOF, CEILING), 80);
  });
  it("3+ years stays capped at 80 (Norma)", () => {
    assert.equal(entitlementHours(PTO, "2023-05-11", ASOF, CEILING), 80);
  });
});

describe("entitlementHours — Unpaid personal (40 from day one)", () => {
  it("eligible day one → 40", () => {
    assert.equal(entitlementHours(UNPAID, "2026-06-16", ASOF, CEILING), 40);
  });
});

describe("entitlementHours — non-flat-grant buckets never grant", () => {
  it("office_recorded → 0", () => {
    assert.equal(
      entitlementHours({ ...PLAWA, accrual_mode: "office_recorded" }, "2020-01-01", ASOF, CEILING),
      0,
    );
  });
  it("accrue_per_hours → 0", () => {
    assert.equal(
      entitlementHours({ ...PLAWA, accrual_mode: "accrue_per_hours" }, "2020-01-01", ASOF, CEILING),
      0,
    );
  });
});

describe("planLeaveGrant", () => {
  it("no balance + eligible → initial_grant (40, used 0)", () => {
    const p = planLeaveGrant(PLAWA, null, "2026-01-26", ASOF, CEILING);
    assert.equal(p.action, "initial_grant");
    assert.equal(p.new_granted, 40);
    assert.equal(p.new_used, 0);
  });

  it("no balance + not eligible → none (0/0)", () => {
    const p = planLeaveGrant(PLAWA, null, "2026-05-25", ASOF, CEILING);
    assert.equal(p.action, "none");
    assert.equal(p.new_granted, 0);
  });

  it("balance from last year + eligible → annual_reset (re-front-load, used 0)", () => {
    const p = planLeaveGrant(
      PLAWA,
      { granted_hours: 40, used_hours: 32, last_reset_at: new Date("2025-01-01T12:00:00Z") },
      "2024-01-01",
      ASOF,
      CEILING,
    );
    assert.equal(p.action, "annual_reset");
    assert.equal(p.new_granted, 40);
    assert.equal(p.new_used, 0); // prior-year usage wiped
  });

  it("balance granted this year, entitlement unchanged → none (preserve used)", () => {
    const p = planLeaveGrant(
      PTO,
      { granted_hours: 40, used_hours: 10, last_reset_at: new Date("2026-01-01T12:00:00Z") },
      "2025-06-03",
      ASOF,
      CEILING,
    );
    assert.equal(p.action, "none");
    assert.equal(p.new_granted, 40);
    assert.equal(p.new_used, 10);
  });

  it("PTO crosses 2-year tier mid-year → tier_topup to 80, used preserved", () => {
    const p = planLeaveGrant(
      PTO,
      { granted_hours: 40, used_hours: 10, last_reset_at: new Date("2026-01-01T12:00:00Z") },
      "2024-06-18", // 2 years as of ASOF
      ASOF,
      CEILING,
    );
    assert.equal(p.action, "tier_topup");
    assert.equal(p.new_granted, 80);
    assert.equal(p.new_used, 10); // NOT reset — only the bank tops up
  });

  it("handbook example: PTO bank tops UP to tier, never stacks (no +on-top)", () => {
    // Used 20 of 40 in year 1; at the year reset the bank is set to the
    // year's entitlement, not 20 carried + a fresh grant.
    const p = planLeaveGrant(
      PTO,
      { granted_hours: 40, used_hours: 20, last_reset_at: new Date("2025-06-30T12:00:00Z") },
      "2024-06-18",
      ASOF,
      CEILING,
    );
    assert.equal(p.action, "annual_reset");
    assert.equal(p.new_granted, 80); // tier at 2yr
    assert.equal(p.new_used, 0);
    // available = 80, NOT 20 + 80 = 100, NOT 20 + 40 = 60
  });
});
