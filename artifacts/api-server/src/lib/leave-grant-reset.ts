/**
 * Time-off grant + annual reset engine (Phes work-anniversary model).
 *
 * Confirmed by Sal 2026-06-20:
 *   - Every employee has their OWN benefit year, anchored to their hire
 *     date. All buckets (PLAWA, PTO, Unpaid) reset on the employee's WORK
 *     ANNIVERSARY — NOT a Jan-1 calendar reset. Matches the handbook's
 *     individualized "Benefit Year."
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
 * model is "set the bank to the tenure entitlement each benefit year" —
 * NOT carryover arithmetic. `applyReset` stays for any tenant that wants
 * the allowance/carryover model; Phes uses the entitlement model here.
 *
 * The grant/reset is unified into ONE idempotent operation
 * (`planLeaveGrant`) so the daily cron handles three cases with one rule,
 * keyed off each employee's benefit-year start (most recent anniversary):
 *   - initial_grant : employee crosses the waiting-period gate
 *   - annual_reset  : first run of a new benefit year (re-front-load)
 *   - tier_topup    : granted is below the current tenure tier (PTO 40→80)
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

/** The start of the employee's CURRENT benefit year as of `asOf`: the
 *  most recent hire-anniversary on or before `asOf`. Used to decide
 *  whether this benefit year's grant has already landed. Both args
 *  YYYY-MM-DD; returns a UTC Date. (Feb-29 hires roll to Mar-1 in
 *  non-leap years via JS Date normalization.) */
export function benefitYearStartDate(hireDate: string, asOf: string): Date {
  const h = new Date(`${hireDate}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  let anniv = new Date(
    Date.UTC(a.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate()),
  );
  if (anniv.getTime() > a.getTime()) {
    anniv = new Date(
      Date.UTC(a.getUTCFullYear() - 1, h.getUTCMonth(), h.getUTCDate()),
    );
  }
  return anniv;
}

/** Target granted hours for the CURRENT benefit year for one bucket.
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
 *  Idempotent: re-running within the same benefit year is a no-op once
 *  the year's grant has landed (except a tenure tier bump). */
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

  // hireDate is non-null here (ent > 0 requires it). Reset is keyed off
  // the employee's benefit year, not the calendar: the grant for this
  // benefit year has landed iff last_reset_at is on/after the most recent
  // anniversary.
  const benefitYearStartMs = benefitYearStartDate(hireDate as string, asOf).getTime();
  const lastResetMs = balance?.last_reset_at
    ? new Date(balance.last_reset_at).getTime()
    : null;

  // First touch of this benefit year → front-load the entitlement and
  // zero used. New row = initial grant; an older row = annual reset.
  if (lastResetMs === null || lastResetMs < benefitYearStartMs) {
    return {
      entitlement: ent,
      new_granted: ent,
      new_used: 0,
      action: balance === null ? "initial_grant" : "annual_reset",
    };
  }

  // Already granted this benefit year. The only legitimate change is a
  // tenure tier bump (PTO crossing 2 years): top granted UP, preserve used.
  if (ent > granted) {
    return { entitlement: ent, new_granted: ent, new_used: used, action: "tier_topup" };
  }
  return { entitlement: ent, new_granted: granted, new_used: used, action: "none" };
}
