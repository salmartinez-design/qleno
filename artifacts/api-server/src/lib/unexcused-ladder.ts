/**
 * Cutover 3A — Cumulative unexcused-hours threshold ladder.
 *
 * Distinct from the existing per-event tardy_steps + absence_steps
 * (those advance with each event). This module evaluates CUMULATIVE
 * unexcused HOURS over a rolling window:
 *
 *   "After 8 unexcused hours in the last 90 days, fire a written
 *    warning. After 16, final warning. After 24, termination review."
 *
 * The ladder lives in company_attendance_policy.unexcused_hours_steps
 * as JSONB. Each step is:
 *
 *   {
 *     threshold_hours: number,
 *     window_days:     number,
 *     discipline_type: 'tardy_warning' | 'absence_warning' |
 *                      'final_warning' | 'termination' | 'custom',
 *     label?:          string,
 *     notify:          boolean
 *   }
 *
 * Pure: takes attendance entries + previously-triggered steps and
 * returns which step (if any) was crossed by the NEW entry. The
 * route writes the discipline_log row and fires the notification.
 */

export type UnexcusedStep = {
  threshold_hours: number;
  window_days: number;
  discipline_type:
    | "tardy_warning"
    | "absence_warning"
    | "final_warning"
    | "termination"
    | "custom";
  label?: string;
  notify: boolean;
};

export type UnexcusedEntry = {
  /** YYYY-MM-DD calendar day of the unexcused entry. */
  date: string;
  /** Hours unexcused on that day. Treated as a single bucket the
   *  window can sum over. */
  hours: number;
};

export type LadderEvaluation = {
  /** The step that fired, if any. Returns the HIGHEST threshold the
   *  cumulative window now meets — so a single bad day that crosses
   *  multiple thresholds still emits one discipline row at the
   *  highest level. */
  triggered_step: UnexcusedStep | null;
  /** Cumulative unexcused hours that triggered the evaluation. */
  cumulative_hours: number;
  /** Window end date used for the evaluation. */
  as_of: string;
};

/** Number of days between two ISO dates (calendar-day diff). */
function daysBetween(earlier: string, later: string): number {
  const a = new Date(`${earlier}T00:00:00Z`).getTime();
  const b = new Date(`${later}T00:00:00Z`).getTime();
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

/** Evaluate the ladder against an entries history at a given date.
 *  Returns the highest step the cumulative window crosses, or null. */
export function evaluateLadder(
  steps: ReadonlyArray<UnexcusedStep>,
  entries: ReadonlyArray<UnexcusedEntry>,
  asOf: string,
  alreadyTriggeredThresholds: ReadonlySet<number>,
): LadderEvaluation {
  if (steps.length === 0) {
    return { triggered_step: null, cumulative_hours: 0, as_of: asOf };
  }
  // Sort steps by threshold ASC — we walk them and return the
  // highest one the cumulative window crosses + hasn't been fired
  // for already.
  const sorted = [...steps].sort((a, b) => a.threshold_hours - b.threshold_hours);

  // Use each step's window_days to compute the relevant cumulative.
  // A step fires if cum >= threshold AND threshold not already-fired.
  let triggered: UnexcusedStep | null = null;
  let triggeredCum = 0;
  for (const step of sorted) {
    if (alreadyTriggeredThresholds.has(step.threshold_hours)) continue;
    let cum = 0;
    for (const e of entries) {
      const ageDays = daysBetween(e.date, asOf);
      if (ageDays < 0) continue; // future entry — skip
      if (ageDays > step.window_days) continue;
      cum += e.hours;
    }
    if (cum >= step.threshold_hours) {
      triggered = step;
      triggeredCum = cum;
      // Keep walking — return the HIGHEST threshold that fires.
    }
  }
  return {
    triggered_step: triggered,
    cumulative_hours: round2(triggeredCum),
    as_of: asOf,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Occurrence-based ladder (PHES, Sal 2026-06-24).
//
// The PHES handbook/LMS disciplinary ladder counts INCIDENTS per Benefit Year
// (work anniversary), NOT cumulative hours. Two independent counters: unexcused
// absences and tardies. This pure evaluator returns the HIGHEST step the
// occurrence count crosses that hasn't already fired this benefit year — so a
// jump (e.g. straight to the 5th occurrence) emits one row at the highest level,
// never re-firing a lower step.
// ─────────────────────────────────────────────────────────────────────────────
export type OccurrenceStep = {
  occurrence: number; // fires at the Nth occurrence (1-based)
  discipline_type:
    | "tardy_warning"
    | "absence_warning"
    | "final_warning"
    | "termination"
    | "custom";
  label?: string;
  notify: boolean;
};

export type OccurrenceEvaluation = {
  triggered_step: OccurrenceStep | null;
  occurrence_count: number;
};

export function evaluateOccurrenceLadder(
  steps: ReadonlyArray<OccurrenceStep>,
  occurrenceCount: number,
  alreadyFiredOccurrences: ReadonlySet<number>,
): OccurrenceEvaluation {
  const sorted = [...steps]
    .filter((s) => Number(s.occurrence) > 0)
    .sort((a, b) => a.occurrence - b.occurrence);
  let triggered: OccurrenceStep | null = null;
  for (const step of sorted) {
    if (alreadyFiredOccurrences.has(step.occurrence)) continue;
    if (occurrenceCount >= step.occurrence) {
      triggered = step; // keep walking → highest crossed, not-yet-fired step
    }
  }
  return { triggered_step: triggered, occurrence_count: occurrenceCount };
}

/** The next step the employee has NOT yet reached (for the card progress bar).
 *  Returns null when no steps configured or all crossed. */
export function nextOccurrenceStep(
  steps: ReadonlyArray<OccurrenceStep>,
  occurrenceCount: number,
): OccurrenceStep | null {
  return (
    [...steps]
      .filter((s) => Number(s.occurrence) > 0)
      .sort((a, b) => a.occurrence - b.occurrence)
      .find((s) => s.occurrence > occurrenceCount) || null
  );
}
