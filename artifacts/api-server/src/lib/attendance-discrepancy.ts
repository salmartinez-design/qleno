/**
 * Cutover 3B — Pure attendance discrepancy classification.
 *
 * No DB imports. The caller (the /scan route handler) loads jobs +
 * clock events + approved leave, converts every clock event's
 * `event_at` to Chicago wall-clock `{date, minutesOfDay}`, computes
 * Chicago `now` `{date, minutesOfDay}`, and passes the lot here.
 *
 * The classifier NEVER constructs a Date from text. It compares
 * minutes-of-day on date strings and date strings lexicographically
 * (YYYY-MM-DD sorts correctly). DST is handled at the route layer by
 * `Intl.DateTimeFormat({ timeZone: "America/Chicago" })`.
 *
 * Cross-midnight `worked_minutes` is computed from absolute Date
 * timestamps the caller provides on each ClockEventForOverlay (the
 * `event_at` field), not from the `minutesOfDay` projection — that
 * projection only feeds the LATE comparison.
 *
 * MID-DAY RE-CLOCK POLICY: pairs (first_in, last_out). Bracket
 * minutes include breaks. This differs intentionally from
 * pay-hours.ts which pairs strictly for OT bucketing. The overlay's
 * question is "did the tech show up roughly the right amount", not
 * "exactly how many billable minutes". Different question, different
 * pairing.
 *
 * SHORT false-negative: when a tech takes a long break the bracket
 * is inflated and SHORT may not fire. This is the documented
 * trade-off. Callers can pass a stricter eligibility/pairing fn if
 * needed.
 */

import { parseScheduledTime } from "./parse-scheduled-time.js";
import {
  classifyEligibility,
  type EligibilityCheckInput,
} from "./pay-eligibility.js";

export const LATE_THRESHOLD_MINUTES_DEFAULT = 20;
export const NO_SHOW_WAIT_MINUTES_DEFAULT = 20;
export const SHORT_THRESHOLD_MINUTES_DEFAULT = 20;

/** Single clock event after the route handler has projected
 *  `event_at` into Chicago wall-clock components. Absolute Date is
 *  still attached so cross-midnight pairing can use timestamp math. */
export interface ClockEventForOverlay {
  id: number;
  job_id: number;
  user_id: number;
  event_type: "clock_in" | "clock_out";
  /** Absolute timestamp (UTC). Used for cross-midnight bracket math. */
  event_at: Date;
  /** Chicago wall-clock projection of `event_at` (YYYY-MM-DD). */
  event_date: string;
  /** Chicago wall-clock projection of `event_at` (minutes-of-day). */
  event_minutes_of_day: number;
  is_correction: boolean;
  correction_of_event_id: number | null;
  /** Eligibility fields the helper hands to classifyEligibility. */
  gps_status: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  exception_reason: string | null;
  exception_reviewed_at: Date | string | null;
}

export interface ScheduledAssignment {
  job_id: number;
  user_id: number;
  /** YYYY-MM-DD */
  scheduled_date: string;
  /** Minutes-of-day, Chicago wall-clock. Null when jobs.scheduled_time
   *  is empty / unparseable — the classifier still emits NO_SHOW /
   *  MISSING_CLOCKOUT (those rules don't need a time), but cannot
   *  evaluate LATE. */
  scheduled_time_minutes: number | null;
  estimated_hours: number | null;
}

export interface ApprovedLeaveWindow {
  leave_request_id: number;
  user_id: number;
  /** YYYY-MM-DD */
  start_date: string;
  /** YYYY-MM-DD */
  end_date: string;
  hours: number;
}

export type DiscrepancyKind =
  | "late"
  | "short"
  | "no_show"
  | "missing_clockout"
  | "on_time";

export interface DiscrepancyResult {
  kind: DiscrepancyKind;
  minutes_late: number | null;
  minutes_short: number | null;
  clock_in_event_id: number | null;
  clock_out_event_id: number | null;
  leave_request_id: number | null;
  /** True when an approved leave fully covers this date (hours >= 8).
   *  Signal-only — the classifier still emits the proposal so the route
   *  can decide what to do (the route auto-dismisses these). */
  suppressed_by_leave: boolean;
}

export interface ClassifyConfig {
  lateThresholdMinutes?: number;
  noShowWaitMinutes?: number;
  shortThresholdMinutes?: number;
  /** Custom eligibility fn for testing. Default: classifyEligibility
   *  from pay-eligibility.ts (excludes unreviewed exceptions). */
  eligibilityFn?: (e: EligibilityCheckInput) => boolean;
}

export interface PairedClockEvents {
  clock_in: ClockEventForOverlay | null;
  clock_out: ClockEventForOverlay | null;
  /** Bracket minutes (last_out - first_in). NULL when either side is
   *  missing. Cross-midnight aware via absolute event_at timestamps. */
  worked_minutes: number | null;
}

function defaultEligibility(e: EligibilityCheckInput): boolean {
  const r = classifyEligibility(e);
  return r === "eligible_captured" || r === "eligible_reviewed_exception";
}

/**
 * Resolve the correction chain — when one event has is_correction=true
 * + correction_of_event_id pointing at another, the corrected row's
 * timestamps replace the original's. Latest correction wins. Filters
 * via the injected eligibility fn (default = pay-pipeline rules).
 *
 * Returns first eligible clock_in + last eligible clock_out for the
 * user/job pair. Collapses mid-day re-clocks intentionally — see
 * file header comment.
 */
export function pairClockEventsForJobUser(
  events: ReadonlyArray<ClockEventForOverlay>,
  config: ClassifyConfig = {},
): PairedClockEvents {
  const eligibilityFn = config.eligibilityFn ?? defaultEligibility;

  // Materialize corrections. Walk the list once: rows where
  // is_correction=true OVERWRITE the original (by event_at + chicago
  // projection); originals that have been corrected are skipped.
  const correctedIds = new Set<number>();
  for (const e of events) {
    if (e.is_correction && e.correction_of_event_id != null) {
      correctedIds.add(e.correction_of_event_id);
    }
  }
  const materialized = events.filter((e) => !correctedIds.has(e.id));
  const eligible = materialized.filter((e) => eligibilityFn(e));

  const ins = eligible
    .filter((e) => e.event_type === "clock_in")
    .sort((a, b) => a.event_at.getTime() - b.event_at.getTime());
  const outs = eligible
    .filter((e) => e.event_type === "clock_out")
    .sort((a, b) => a.event_at.getTime() - b.event_at.getTime());

  const clock_in = ins[0] ?? null;
  const clock_out = outs[outs.length - 1] ?? null;

  let worked_minutes: number | null = null;
  if (clock_in && clock_out) {
    const ms = clock_out.event_at.getTime() - clock_in.event_at.getTime();
    if (Number.isFinite(ms) && ms > 0) {
      worked_minutes = Math.round(ms / 60000);
    }
  }
  return { clock_in, clock_out, worked_minutes };
}

/** Date strings (YYYY-MM-DD) compare lexicographically. */
function compareDates(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Pick the first approved leave window whose [start..end] inclusive
 *  range contains `date`. Returns null if none. */
function pickFirstOverlap(
  windows: ReadonlyArray<ApprovedLeaveWindow>,
  date: string,
): ApprovedLeaveWindow | null {
  for (const w of windows) {
    if (compareDates(w.start_date, date) <= 0 && compareDates(date, w.end_date) <= 0) {
      return w;
    }
  }
  return null;
}

/**
 * Classify the (user, job, scheduled_date) tuple as one of:
 *   late | short | no_show | missing_clockout | on_time
 *
 * Caller responsibilities:
 *   - Only pass events for this exact (user_id, job_id) pair.
 *   - Pre-project Chicago wall-clock fields (event_date, event_minutes_of_day).
 *   - Pass `nowDateChicago` + `nowMinutesOfDayChicago` (the route uses
 *     Intl.DateTimeFormat with timeZone: 'America/Chicago').
 *   - `leaveWindows` may include leaves for other users; the classifier
 *     filters to the assignment's user_id.
 */
export function classifyDiscrepancy(
  assignment: ScheduledAssignment,
  events: ReadonlyArray<ClockEventForOverlay>,
  leaveWindows: ReadonlyArray<ApprovedLeaveWindow>,
  nowMinutesOfDayChicago: number,
  nowDateChicago: string,
  config: ClassifyConfig = {},
): DiscrepancyResult {
  const lateThreshold = config.lateThresholdMinutes ?? LATE_THRESHOLD_MINUTES_DEFAULT;
  const noShowWait = config.noShowWaitMinutes ?? NO_SHOW_WAIT_MINUTES_DEFAULT;
  const shortThreshold = config.shortThresholdMinutes ?? SHORT_THRESHOLD_MINUTES_DEFAULT;

  // Step 1: surface any approved leave for this user that overlaps
  // the scheduled date. suppressed_by_leave when the leave is full-day
  // (>=8 hours).
  const userLeaves = leaveWindows.filter((w) => w.user_id === assignment.user_id);
  const overlap = pickFirstOverlap(userLeaves, assignment.scheduled_date);
  const leave_request_id = overlap ? overlap.leave_request_id : null;
  const suppressed_by_leave = !!overlap && overlap.hours >= 8;

  // Step 2: pair events. Restrict to this (user, job).
  const ours = events.filter(
    (e) => e.user_id === assignment.user_id && e.job_id === assignment.job_id,
  );
  const { clock_in, clock_out, worked_minutes } = pairClockEventsForJobUser(
    ours,
    config,
  );

  const dateCompare = compareDates(nowDateChicago, assignment.scheduled_date);
  const isPastDay = dateCompare > 0;
  const isSameDay = dateCompare === 0;

  // Step 3: NO_SHOW. clock_in==null AND (past day OR same day past
  // start+wait). scheduled_time_minutes may be null — in that case the
  // wait-window check cannot fire, but a past day still counts as no-show.
  if (clock_in == null) {
    let noShow = isPastDay;
    if (!noShow && isSameDay && assignment.scheduled_time_minutes != null) {
      noShow =
        nowMinutesOfDayChicago >= assignment.scheduled_time_minutes + noShowWait;
    }
    if (noShow) {
      return {
        kind: "no_show",
        minutes_late: null,
        minutes_short: null,
        clock_in_event_id: null,
        clock_out_event_id: null,
        leave_request_id,
        suppressed_by_leave,
      };
    }
    // Step 4: pre-start (or same-day under wait) → on_time
    return {
      kind: "on_time",
      minutes_late: null,
      minutes_short: null,
      clock_in_event_id: null,
      clock_out_event_id: null,
      leave_request_id,
      suppressed_by_leave,
    };
  }

  // Step 5: MISSING_CLOCKOUT — clocked in but never clocked out and
  // either the day is over OR the bracket exceeds 16h. Uses absolute
  // event_at math (cross-midnight aware).
  if (clock_out == null) {
    const minutesSinceIn = Math.round(
      (Date.now() - clock_in.event_at.getTime()) / 60000,
    );
    const stale = isPastDay || minutesSinceIn > 16 * 60;
    if (stale) {
      return {
        kind: "missing_clockout",
        minutes_late: null,
        minutes_short: null,
        clock_in_event_id: clock_in.id,
        clock_out_event_id: null,
        leave_request_id,
        suppressed_by_leave,
      };
    }
    // Step 6: still clocked in, same day, not stale → on_time
    return {
      kind: "on_time",
      minutes_late: null,
      minutes_short: null,
      clock_in_event_id: clock_in.id,
      clock_out_event_id: null,
      leave_request_id,
      suppressed_by_leave,
    };
  }

  // Step 7: LATE — clock_in.minutesOfDay - scheduled_time_minutes >= threshold.
  // Skipped when scheduled_time_minutes is null (we can't compute lateness
  // against an unknown scheduled time).
  if (assignment.scheduled_time_minutes != null) {
    const delta = clock_in.event_minutes_of_day - assignment.scheduled_time_minutes;
    if (delta >= lateThreshold) {
      return {
        kind: "late",
        minutes_late: delta,
        minutes_short: null,
        clock_in_event_id: clock_in.id,
        clock_out_event_id: clock_out.id,
        leave_request_id,
        suppressed_by_leave,
      };
    }
  }

  // Step 8: SHORT — estimated_hours not null, bracket short by >= threshold.
  if (
    assignment.estimated_hours != null &&
    worked_minutes != null
  ) {
    const expected = Math.round(assignment.estimated_hours * 60);
    const shortBy = expected - worked_minutes;
    if (shortBy >= shortThreshold) {
      return {
        kind: "short",
        minutes_late: null,
        minutes_short: shortBy,
        clock_in_event_id: clock_in.id,
        clock_out_event_id: clock_out.id,
        leave_request_id,
        suppressed_by_leave,
      };
    }
  }

  // Step 9: otherwise → on_time
  return {
    kind: "on_time",
    minutes_late: null,
    minutes_short: null,
    clock_in_event_id: clock_in.id,
    clock_out_event_id: clock_out.id,
    leave_request_id,
    suppressed_by_leave,
  };
}

/** Re-export so callers needing both helpers import from one place. */
export { parseScheduledTime };
