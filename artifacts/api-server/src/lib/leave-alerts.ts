/**
 * Cutover 3A — Use-it-or-lose-it alerts.
 *
 * Detects whether an employee's reset is "within N days" given the
 * tenant's leave_reset_basis. Pure: takes the inputs and a reference
 * "today" date, returns a single boolean + the computed reset date.
 *
 * Two reset bases:
 *
 *   work_anniversary  Reset date = next occurrence of the employee's
 *                     hire-date month+day on or after `today`. If
 *                     today is the anniversary, the alert STILL fires
 *                     (zero days out) — the office cares about same-
 *                     day visibility.
 *
 *   calendar_year     Reset date = next Dec 31 on or after `today`.
 */

export type LeaveResetBasis = "work_anniversary" | "calendar_year";

export type AlertEvaluationInput = {
  reset_basis: LeaveResetBasis;
  hire_date: string | null; // YYYY-MM-DD; required for work_anniversary
  today: string; // YYYY-MM-DD
  lead_days: number;
};

export type AlertEvaluation = {
  /** Should the alert fire for this employee right now? */
  should_alert: boolean;
  /** The computed next reset date (YYYY-MM-DD), null when unresolvable. */
  next_reset: string | null;
  /** Days remaining until reset (>=0 when applicable). */
  days_until_reset: number | null;
};

/** Returns the next anniversary date (YYYY-MM-DD) on or after `today`. */
export function nextAnniversary(hireDate: string, today: string): string {
  // Inputs are YYYY-MM-DD. We work in UTC to avoid TZ drift on the
  // "is today >= hire month+day this year?" comparison.
  const [hy, hm, hd] = hireDate.split("-").map(Number);
  const [ty] = today.split("-").map(Number);
  let candidateYear = ty;
  const candidate = formatYMD(candidateYear, hm!, hd!);
  if (candidate < today) candidateYear += 1;
  return formatYMD(candidateYear, hm!, hd!);
}

function formatYMD(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Calendar-year reset = next Dec 31 on or after today. */
export function nextCalendarYearReset(today: string): string {
  const [ty] = today.split("-").map(Number);
  return `${String(ty).padStart(4, "0")}-12-31` >= today
    ? `${String(ty).padStart(4, "0")}-12-31`
    : `${String((ty as number) + 1).padStart(4, "0")}-12-31`;
}

function daysBetween(earlier: string, later: string): number {
  const a = new Date(`${earlier}T00:00:00Z`).getTime();
  const b = new Date(`${later}T00:00:00Z`).getTime();
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

/** Evaluate whether the use-it-or-lose-it alert should fire today. */
export function evaluateUseItOrLoseItAlert(
  input: AlertEvaluationInput,
): AlertEvaluation {
  if (input.reset_basis === "work_anniversary") {
    if (!input.hire_date) {
      return { should_alert: false, next_reset: null, days_until_reset: null };
    }
    const reset = nextAnniversary(input.hire_date, input.today);
    const days = daysBetween(input.today, reset);
    return {
      should_alert: days >= 0 && days <= input.lead_days,
      next_reset: reset,
      days_until_reset: days,
    };
  }
  // calendar_year
  const reset = nextCalendarYearReset(input.today);
  const days = daysBetween(input.today, reset);
  return {
    should_alert: days >= 0 && days <= input.lead_days,
    next_reset: reset,
    days_until_reset: days,
  };
}
