/**
 * Time-off grant + annual reset engine (Phes calendar-year model).
 *
 * Confirmed by Sal 2026-06-20:
 *   - ALL buckets reset on the CALENDAR YEAR (Jan 1), for every employee.
 *     There is no per-employee work-anniversary reset.
 *   - PLAWA (sick): 40h FRONT-LOADED after 90 days, NO carryover.
 *   - PTO: 40h after 1 year, topping up to 80h (hard cap) at 2 years.
 *   - Unpaid personal: 40h from day one.
 *
 * This is a deliberately DIFFERENT model from lib/leave-balance.ts
 * `applyReset` (the generic carryover-candidate math). That function
 * carries the unused prior balance forward and adds a grant on top
 * (capped at the ceiling) — which for PTO would yield 60h, not 80h, for
 * the handbook's "used 20 of 40, top up to 80" example. The handbook is
 * explicit: "we top up to the cap, we do not add on top." So the Phes
 * model is "set the bank to the tenure entitlement each year" — NOT
 * carryover arithmetic. `applyReset` stays for any tenant that wants the
 * allowance/carryover model; Phes uses the entitlement model here.
 *
 * The grant/reset is unified into ONE idempotent operation
 * (`planLeaveGrant`) so the daily cron handles three cases with one rule:
 *   - initial_grant : employee crosses the waiting-period gate mid-year
 *   - annual_reset  : first run of a new calendar year (re-front-load)
 *   - tier_topup    : PTO crosses its 2-year tenure tier mid-year
 *
 * The pure functions here take no DB and are unit-tested. The DB wrapper
 * (`reconcileCompanyLeaveBalances`) lives in ./leave-reconcile.ts and
 * composes these — split out so importing the pure math in tests doesn't
 * pull in the drizzle client.
 */

import { isPastWaitingPeriod, round2 } from "./leave-balance.js";

export type GrantAccrualMode =
  | "flat_grant"
  | "accrue_per_hours"
  | "office_recorded";

export type GrantBucket = {
  slug: string;
  accrual_mode: GrantAccrualMode;
  annual_cap_hours: number;
  waiting_period_days: number;
  carryover_allowed: boolean;
};

export type GrantBalance = {
  granted_hours: number;
  used_hours: number;
  last_reset_at: Date | null;
};

export type GrantAction =
  | "none"
  | "initial_grant"
  | "annual_reset"
  | "tier_topup";

export type GrantPlan = {
  entitlement: number;
  new_granted: number;
  new_used: number;
  action: GrantAction;
};

/** Full completed years of service as of `asOf`. Both args YYYY-MM-DD.
 *  Anniversary not yet reached in `asOf`'s year counts as one fewer. */
export function completedYearsOfService(
  hireDate: string,
  asOf: string,
): number {
  const h = new Date(`${hireDate}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  let years = a.getUTCFullYear() - h.getUTCFullYear();
  const annivThisYear = new Date(
    Date.UTC(a.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate()),
  );
  if (a.getTime() < annivThisYear.getTime()) years -= 1;
  return Math.max(0, years);
}

/** Target granted hours for the CURRENT calendar year for one bucket.
 *  Returns 0 when the employee hasn't cleared the waiting period (i.e.
 *  not eligible yet) or the bucket isn't a flat grant.
 *
 *  Tenure tier: for a carryover bucket whose ceiling exceeds the annual
 *  cap (Phes PTO: cap 40, ceiling 80), entitlement = cap × completed
 *  years, capped at the ceiling. So PTO is 40 in year 1 and 80 from
 *  year 2 on. Non-carryover buckets (PLAWA, Unpaid) are always the cap. */
export function entitlementHours(
  bucket: GrantBucket,
  hireDate: string | null,
  asOf: string,
  ceilingHours: number,
): number {
  if (bucket.accrual_mode !== "flat_grant") return 0;
  if (!hireDate) return 0;
  if (!isPastWaitingPeriod(hireDate, bucket.waiting_period_days, asOf)) {
    return 0;
  }
  const base = Math.max(0, bucket.annual_cap_hours);
  if (bucket.carryover_allowed && ceilingHours > base) {
    const years = Math.max(1, completedYearsOfService(hireDate, asOf));
    return Math.min(ceilingHours, round2(base * years));
  }
  return base;
}

/** Plan the grant/reset action for one (employee, bucket) as of `asOf`.
 *  Idempotent: re-running within the same calendar year is a no-op once
 *  the year's grant has landed (except a mid-year tenure tier bump). */
export function planLeaveGrant(
  bucket: GrantBucket,
  balance: GrantBalance | null,
  hireDate: string | null,
  asOf: string,
  ceilingHours: number,
): GrantPlan {
  const granted = balance ? round2(balance.granted_hours) : 0;
  const used = balance ? round2(balance.used_hours) : 0;
  const ent = entitlementHours(bucket, hireDate, asOf, ceilingHours);

  // Not grantable / not eligible yet → leave whatever is there untouched.
  if (bucket.accrual_mode !== "flat_grant" || ent <= 0) {
    return { entitlement: ent, new_granted: granted, new_used: used, action: "none" };
  }

  const currentYear = new Date(`${asOf}T00:00:00Z`).getUTCFullYear();
  const lastResetYear = balance?.last_reset_at
    ? new Date(balance.last_reset_at).getUTCFullYear()
    : null;

  // First touch of this calendar year → front-load the entitlement and
  // zero used. New row = initial grant; an older row = annual reset.
  if (lastResetYear === null || lastResetYear < currentYear) {
    return {
      entitlement: ent,
      new_granted: ent,
      new_used: 0,
      action: balance === null ? "initial_grant" : "annual_reset",
    };
  }

  // Already granted this year. The only legitimate mid-year change is a
  // tenure tier bump (PTO crossing 2 years): top granted UP, preserve used.
  if (ent > granted) {
    return { entitlement: ent, new_granted: ent, new_used: used, action: "tier_topup" };
  }
  return { entitlement: ent, new_granted: granted, new_used: used, action: "none" };
}
