/**
 * Cutover 3A — Pure leave-request validation.
 *
 * Three rule layers, all returning a structured RuleResult so the
 * route can emit a precise refusal message:
 *
 *   1. Bucket gate: must be requestable.
 *   2. Waiting period: employee must be past it for this bucket.
 *   3. Balance gate: requested hours <= available (only for buckets
 *      where balance applies — flat_grant + accrue_per_hours).
 *   4. Blackout overlap: per the per-bucket exempt_from_blackout flag.
 *      Exempt buckets (PLAWA) are NEVER auto-denied. Non-exempt are
 *      auto-denied at create time; the row still persists so office
 *      can override.
 *
 * Pure: takes pre-loaded data, returns outcome. The route does the
 * DB I/O.
 */

import { isPastWaitingPeriod } from "./leave-balance.js";

export type RuleOk = { ok: true };
export type RuleFail = { ok: false; code: string; message: string };
export type RuleResult = RuleOk | RuleFail;

export type BucketForValidation = {
  requestable: boolean;
  waiting_period_days: number;
  accrual_mode: "flat_grant" | "accrue_per_hours" | "office_recorded";
  exempt_from_blackout: boolean;
  display_name: string;
};

/** A single blackout window. Dates are YYYY-MM-DD strings. */
export type BlackoutWindow = {
  start_date: string;
  end_date: string;
  label: string;
};

export function checkRequestable(bucket: BucketForValidation): RuleResult {
  if (!bucket.requestable) {
    return {
      ok: false,
      code: "bucket_not_requestable",
      message: `${bucket.display_name} is recorded by the office, not requested by employees.`,
    };
  }
  return { ok: true };
}

export function checkWaitingPeriod(
  bucket: BucketForValidation,
  hireDate: string | null,
  asOf: string,
): RuleResult {
  if (bucket.waiting_period_days <= 0) return { ok: true };
  if (!hireDate) {
    return {
      ok: false,
      code: "missing_hire_date",
      message: "Cannot check waiting period — hire date is not set.",
    };
  }
  if (!isPastWaitingPeriod(hireDate, bucket.waiting_period_days, asOf)) {
    return {
      ok: false,
      code: "before_waiting_period",
      message: `${bucket.display_name} is available after ${bucket.waiting_period_days} days from hire.`,
    };
  }
  return { ok: true };
}

/** PTO + Unpaid Personal require 7 days' advance notice (per handbook).
 *  Short-notice buckets — PLAWA/sick, identified by exempt_from_blackout
 *  (the protected, grace-call bucket) — are exempt: same-day / emergency
 *  requests are allowed. Keyed on exempt_from_blackout to avoid a new
 *  column; PLAWA is the only exempt bucket and the only short-notice one. */
export const ADVANCE_NOTICE_DAYS = 7;

export function checkAdvanceNotice(
  bucket: BucketForValidation,
  startDate: string,
  asOf: string,
): RuleResult {
  if (bucket.exempt_from_blackout) return { ok: true }; // sick/emergency path
  const cutoff = addDaysISO(asOf, ADVANCE_NOTICE_DAYS);
  if (startDate < cutoff) {
    return {
      ok: false,
      code: "insufficient_notice",
      message: `${bucket.display_name} requires ${ADVANCE_NOTICE_DAYS} days' advance notice. Earliest start date is ${cutoff}.`,
    };
  }
  return { ok: true };
}

/** asOf (YYYY-MM-DD) + n days, as YYYY-MM-DD (UTC). */
function addDaysISO(asOf: string, n: number): string {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function checkBalance(
  bucket: BucketForValidation,
  requestedHours: number,
  availableHours: number,
): RuleResult {
  if (bucket.accrual_mode === "office_recorded") {
    // Office-recorded buckets are not request-driven (caught upstream
    // by requestable=false) but be defensive.
    return { ok: true };
  }
  if (requestedHours <= 0) {
    return {
      ok: false,
      code: "non_positive_hours",
      message: "Hours requested must be positive.",
    };
  }
  if (requestedHours > availableHours) {
    return {
      ok: false,
      code: "over_balance",
      message: `Requested ${requestedHours.toFixed(2)} h exceeds available ${availableHours.toFixed(2)} h for ${bucket.display_name}.`,
    };
  }
  return { ok: true };
}

/** Does [startA, endA] overlap [startB, endB]? Inclusive on both
 *  ends — a request that ends on the first day of a blackout
 *  overlaps. */
export function datesOverlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string,
): boolean {
  return startA <= endB && endA >= startB;
}

export type BlackoutOutcome =
  | { overlaps: false }
  | {
      overlaps: true;
      blackout: BlackoutWindow;
      /** True when the leg is fully inside the blackout window. */
      fully_inside: boolean;
      /** True when the request spans into days outside the blackout
       *  (operator may want to re-submit for the open dates). */
      spans_outside: boolean;
    };

/** Detect the first blackout window the request overlaps, with
 *  reporting flags for the message text. Caller may iterate over
 *  multiple blackouts; first hit short-circuits. */
export function detectBlackoutOverlap(
  startDate: string,
  endDate: string,
  blackouts: ReadonlyArray<BlackoutWindow>,
): BlackoutOutcome {
  for (const b of blackouts) {
    if (datesOverlap(startDate, endDate, b.start_date, b.end_date)) {
      const fullyInside = startDate >= b.start_date && endDate <= b.end_date;
      const spansOutside = startDate < b.start_date || endDate > b.end_date;
      return { overlaps: true, blackout: b, fully_inside: fullyInside, spans_outside: spansOutside };
    }
  }
  return { overlaps: false };
}
