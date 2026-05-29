/**
 * Cutover 3A — Pure leave-balance math.
 *
 * Three accrual modes:
 *
 *   flat_grant       Annual cap granted at eligibility + each reset.
 *                    Used + available straightforward.
 *
 *   accrue_per_hours hours accrue at accrual_rate per hour worked.
 *                    The hours-worked feed comes from 1C clock events
 *                    filtered by the same paid-eligibility filter the
 *                    pay pipeline uses. Snapshot is written to
 *                    employee_leave_balances.granted_hours at reset;
 *                    between resets the route layer computes from
 *                    clock events on demand.
 *
 *   office_recorded  Starts at cap, decrements as office records
 *                    entries. No grant flow.
 *
 * PTO ceiling math (anniversary-reset):
 *
 *   prior_balance = granted - used        (carryover candidate)
 *   capped_carry  = MIN(prior_balance, balance_ceiling)
 *   pre_grant     = (carryover_allowed ? capped_carry : 0)
 *   post_grant    = MIN(pre_grant + grant, balance_ceiling)
 *   forfeited     = (pre_grant + grant) - post_grant
 *
 * Phes example: prior 60 (used 0), grant 40, ceiling 80
 *   pre_grant = MIN(60, 80) = 60
 *   post_grant = MIN(60 + 40, 80) = 80
 *   forfeited = 100 - 80 = 20    ← the 20 the user described
 *
 * Numbers persist as numeric(8,2) strings; this module passes them
 * through as numbers internally and lets the route do the .toFixed(2)
 * at the DB boundary.
 */

export type AccrualMode = "flat_grant" | "accrue_per_hours" | "office_recorded";

export type ComputeBalanceInput = {
  accrual_mode: AccrualMode;
  granted_hours: number;
  used_hours: number;
  annual_cap_hours: number;
};

export type Balance = {
  granted: number;
  used: number;
  available: number;
};

/** Current available = granted - used, clamped to >= 0. */
export function computeCurrentBalance(input: ComputeBalanceInput): Balance {
  const granted = Number(input.granted_hours) || 0;
  const used = Number(input.used_hours) || 0;
  const available = Math.max(0, round2(granted - used));
  return { granted: round2(granted), used: round2(used), available };
}

/** Accrue from worked hours: hours_worked × accrual_rate, capped at
 *  annual_cap_hours. This is the function the route calls each time
 *  it reads an accrue_per_hours balance between resets — it does NOT
 *  write back; the snapshot only updates at reset. */
export function accrueFromWorkedHours(
  hoursWorked: number,
  accrualRate: number,
  annualCapHours: number,
): number {
  if (hoursWorked <= 0 || accrualRate <= 0) return 0;
  return Math.min(annualCapHours, round2(hoursWorked * accrualRate));
}

export type ApplyResetInput = {
  accrual_mode: AccrualMode;
  prior_balance: number;
  annual_cap_hours: number;
  carryover_allowed: boolean;
  balance_ceiling_hours: number;
};

export type ResetResult = {
  /** New granted_hours value to write back at the boundary. */
  new_granted: number;
  /** Hours that were dropped on the floor at reset because the
   *  ceiling truncated them. Surface to the office as a flag. */
  forfeited_hours: number;
};

/** Apply the annual reset to a balance. Returns the new
 *  granted_hours and any hours forfeited to the ceiling.
 *
 *  - flat_grant: grants annual_cap each reset; ceiling caps the
 *    post-grant balance.
 *  - accrue_per_hours: zeroes the accrual snapshot at reset (the
 *    new year accrues fresh). Carryover is the unused portion of
 *    the prior balance, still subject to the ceiling.
 *  - office_recorded: resets to annual_cap (counts down from cap;
 *    carryover doesn't make sense for this mode).
 */
export function applyReset(input: ApplyResetInput): ResetResult {
  const cap = Math.max(0, input.annual_cap_hours);
  const ceiling = Math.max(0, input.balance_ceiling_hours);
  const prior = Math.max(0, input.prior_balance);

  if (input.accrual_mode === "office_recorded") {
    return { new_granted: cap, forfeited_hours: 0 };
  }

  const grant = input.accrual_mode === "flat_grant" ? cap : 0;
  // Carryover candidate = what would carry over if the ceiling were
  // infinite. Capped by ceiling before the grant lands.
  const carryoverCandidate = input.carryover_allowed ? prior : 0;
  const cappedCarry = Math.min(carryoverCandidate, ceiling);
  const postGrant = Math.min(cappedCarry + grant, ceiling);
  // Forfeit counts hours the ceiling truncated — both at the
  // carryover step AND at the post-grant step. It does NOT count
  // hours dropped because carryover was disallowed (those are
  // "didn't roll over", a separate semantic).
  const forfeited = round2(
    Math.max(0, carryoverCandidate + grant - postGrant),
  );

  return { new_granted: round2(postGrant), forfeited_hours: forfeited };
}

/** Round to 2 decimal places without float drift. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "Past waiting period?" — given a hire date and waiting_period_days,
 *  has the employee accrued enough service for this bucket?
 *  Dates compared lexicographically (YYYY-MM-DD). */
export function isPastWaitingPeriod(
  hireDate: string,
  waitingPeriodDays: number,
  asOf: string,
): boolean {
  if (waitingPeriodDays <= 0) return true;
  const hire = new Date(`${hireDate}T00:00:00Z`);
  const target = new Date(`${asOf}T00:00:00Z`);
  const diffMs = target.getTime() - hire.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return diffDays >= waitingPeriodDays;
}
