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
  benefitYearStartDate,
  type GrantBucket,
} from "../lib/leave-grant-reset.js";
import { checkAdvanceNotice } from "../lib/leave-request-rules.js";

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

  it("last reset in PRIOR benefit year → annual_reset (re-front-load, used 0)", () => {
    // Norma-like: hire 5/11, last reset on the 2025 anniversary. As of
    // 2026-06-20 the benefit year started 2026-05-11, so the 2025 grant
    // is stale → re-front-load.
    const p = planLeaveGrant(
      PLAWA,
      { granted_hours: 40, used_hours: 32, last_reset_at: new Date("2025-05-11T12:00:00Z") },
      "2023-05-11",
      ASOF,
      CEILING,
    );
    assert.equal(p.action, "annual_reset");
    assert.equal(p.new_granted, 40);
    assert.equal(p.new_used, 0); // prior-benefit-year usage wiped
  });

  it("NO calendar reset: Jan-1 does NOT reset; before the anniversary it's still the prior benefit year", () => {
    // Hire 5/11; as of 2026-04-01 (before the 2026 anniversary) the
    // current benefit year started 2025-05-11. A reset stamped 2025-05-11
    // is still current → none. (A Jan-1 calendar model would have reset.)
    const p = planLeaveGrant(
      PLAWA,
      { granted_hours: 40, used_hours: 12, last_reset_at: new Date("2025-05-11T12:00:00Z") },
      "2023-05-11",
      "2026-04-01",
      CEILING,
    );
    assert.equal(p.action, "none");
    assert.equal(p.new_granted, 40);
    assert.equal(p.new_used, 12); // preserved — same benefit year
  });

  it("balance granted THIS benefit year, entitlement unchanged → none (preserve used)", () => {
    const p = planLeaveGrant(
      PTO,
      { granted_hours: 40, used_hours: 10, last_reset_at: new Date("2026-06-10T12:00:00Z") },
      "2025-06-03", // benefit year started 2026-06-03; reset 6/10 is current
      ASOF,
      CEILING,
    );
    assert.equal(p.action, "none");
    assert.equal(p.new_granted, 40);
    assert.equal(p.new_used, 10);
  });

  it("PTO tier bump within the benefit year → tier_topup to 80, used preserved", () => {
    // Anniversary 6/18 already reset granted to 40 (stale), but tenure is
    // now 2yr so the tier is 80 → top the bank up without zeroing used.
    const p = planLeaveGrant(
      PTO,
      { granted_hours: 40, used_hours: 10, last_reset_at: new Date("2026-06-19T12:00:00Z") },
      "2024-06-18", // benefit year started 2026-06-18; 2 years tenure
      ASOF,
      CEILING,
    );
    assert.equal(p.action, "tier_topup");
    assert.equal(p.new_granted, 80);
    assert.equal(p.new_used, 10); // NOT reset — only the bank tops up
  });

  it("handbook example: PTO bank tops UP to tier at the anniversary, never stacks", () => {
    // Used 20 of 40; at the benefit-year (anniversary) reset the bank is
    // set to the tenure entitlement, not 20 carried + a fresh grant.
    const p = planLeaveGrant(
      PTO,
      { granted_hours: 40, used_hours: 20, last_reset_at: new Date("2025-06-18T12:00:00Z") },
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

describe("checkAdvanceNotice — 7-day for PTO/Unpaid, exempt for sick", () => {
  const ptoB = { requestable: true, waiting_period_days: 365, accrual_mode: "flat_grant" as const, exempt_from_blackout: false, display_name: "PTO" };
  const sickB = { requestable: true, waiting_period_days: 90, accrual_mode: "flat_grant" as const, exempt_from_blackout: true, display_name: "PLAWA" };
  it("PTO start within 7 days → fail", () => {
    const r = checkAdvanceNotice(ptoB, "2026-06-23", "2026-06-20");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "insufficient_notice");
  });
  it("PTO start exactly 7 days out → ok", () => {
    assert.equal(checkAdvanceNotice(ptoB, "2026-06-27", "2026-06-20").ok, true);
  });
  it("Sick (exempt) same-day → ok (emergency path)", () => {
    assert.equal(checkAdvanceNotice(sickB, "2026-06-20", "2026-06-20").ok, true);
  });
});

describe("benefitYearStartDate", () => {
  it("most recent anniversary on/before asOf", () => {
    assert.equal(benefitYearStartDate("2023-05-11", "2026-06-20").toISOString().slice(0, 10), "2026-05-11");
  });
  it("before this year's anniversary → last year's", () => {
    assert.equal(benefitYearStartDate("2023-05-11", "2026-04-01").toISOString().slice(0, 10), "2025-05-11");
  });
  it("Aug hire mid-year → prior Aug", () => {
    assert.equal(benefitYearStartDate("2025-08-01", "2026-06-20").toISOString().slice(0, 10), "2025-08-01");
  });
});
