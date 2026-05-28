/**
 * Cutover 1E — Hours computation from 1C clock events.
 *
 * Pure functions. No DB, no I/O. The pay routes call these with rows
 * pulled from job_clock_events; this file decides what counts.
 *
 * Pipeline:
 *   1. Apply the eligibility filter (lib/pay-eligibility.ts) to every
 *      clock event.
 *   2. Pair (user_id, job_id) clock_in → clock_out; both must be eligible.
 *   3. Compute minutes worked = (clock_out_at − clock_in_at).
 *   4. Bucket minutes into ISO weeks (Sunday-start by default for
 *      Illinois weekly OT). Anything over 40 hr in a week is OT.
 *   5. Track exclusions and surface them as flag strings.
 *
 * Money math is downstream — see lib/pay-summary.ts. This file only
 * produces hours + flags.
 */
import {
  classifyEligibility,
  type EligibilityCheckInput,
  type EligibilityReason,
} from "./pay-eligibility.js";

export type ClockEventForPay = EligibilityCheckInput & {
  id: number;
  job_id: number;
  user_id: number;
  event_type: "clock_in" | "clock_out";
  event_at: Date | string;
};

export type WorkedSegment = {
  user_id: number;
  job_id: number;
  start: Date;
  end: Date;
  minutes: number;
};

export type ComputeHoursResult = {
  worked_segments: WorkedSegment[];
  regular_minutes: number;
  overtime_minutes: number;
  // Flags surfaced on the per-user summary so the office sees gaps.
  // The 1E spec calls out these three by name; the implementation
  // emits exactly this set + any further granular reasons.
  flags: string[];
  // For audit: every excluded event and why.
  exclusions: Array<{ event_id: number; reason: EligibilityReason }>;
};

/**
 * Compute one user's hours over the pay period. Caller supplies the
 * user's clock events for the period (both eligible and not — this
 * function decides which to count).
 *
 * `weekStartDay`: 0 = Sunday (default; standard US weekly OT bucketing),
 * 1 = Monday, etc. Tenants may override later via setting.
 */
export function computeHoursForUser(
  events: ClockEventForPay[],
  weekStartDay: number = 0,
): ComputeHoursResult {
  const flags = new Set<string>();
  const exclusions: ComputeHoursResult["exclusions"] = [];

  // 1. Eligibility filter.
  const eligibleById = new Map<number, ClockEventForPay>();
  for (const ev of events) {
    const reason = classifyEligibility(ev);
    if (reason === "eligible_captured" || reason === "eligible_reviewed_exception") {
      eligibleById.set(ev.id, ev);
    } else {
      exclusions.push({ event_id: ev.id, reason });
      if (reason === "ineligible_exception_unreviewed") {
        flags.add("unreviewed_gps_exception");
      } else {
        flags.add("ineligible_clock_event");
      }
    }
  }

  // 2. Pair clock_in → clock_out per job. Same user already; group by job.
  const byJob = new Map<number, ClockEventForPay[]>();
  for (const ev of eligibleById.values()) {
    const arr = byJob.get(ev.job_id) ?? [];
    arr.push(ev);
    byJob.set(ev.job_id, arr);
  }

  const segments: WorkedSegment[] = [];
  for (const [jobId, jobEvents] of byJob) {
    // Sort by event_at ascending so we can walk the in/out pairs.
    jobEvents.sort(
      (a, b) =>
        new Date(a.event_at).getTime() - new Date(b.event_at).getTime(),
    );
    let openIn: ClockEventForPay | null = null;
    for (const ev of jobEvents) {
      if (ev.event_type === "clock_in") {
        if (openIn != null) {
          // Two consecutive clock_ins with no clock_out — abandon the
          // earlier one and treat this as the new open. Flag the gap.
          flags.add("orphan_clock_in");
        }
        openIn = ev;
      } else if (ev.event_type === "clock_out") {
        if (openIn == null) {
          // Clock_out with no matching clock_in. Surface but don't pay.
          flags.add("orphan_clock_out");
          continue;
        }
        const start = new Date(openIn.event_at);
        const end = new Date(ev.event_at);
        const minutes = Math.max(
          0,
          Math.round((end.getTime() - start.getTime()) / 60_000),
        );
        if (minutes > 0) {
          segments.push({
            user_id: ev.user_id,
            job_id: jobId,
            start,
            end,
            minutes,
          });
        }
        openIn = null;
      }
    }
    if (openIn != null) {
      flags.add("missing_clock_out");
    }
  }

  // 3. Weekly OT bucketing.
  const weekTotals = new Map<string, number>();
  for (const seg of segments) {
    // Bucket by the segment's start. A shift that crosses a week
    // boundary is rare; we keep the whole shift in the bucket where
    // it started. Tenants needing strict split-at-boundary semantics
    // can opt in later.
    const key = weekKeyFor(seg.start, weekStartDay);
    weekTotals.set(key, (weekTotals.get(key) ?? 0) + seg.minutes);
  }

  let regularMinutes = 0;
  let overtimeMinutes = 0;
  const FORTY_HOURS_MINUTES = 40 * 60;
  for (const total of weekTotals.values()) {
    if (total <= FORTY_HOURS_MINUTES) {
      regularMinutes += total;
    } else {
      regularMinutes += FORTY_HOURS_MINUTES;
      overtimeMinutes += total - FORTY_HOURS_MINUTES;
    }
  }

  return {
    worked_segments: segments,
    regular_minutes: regularMinutes,
    overtime_minutes: overtimeMinutes,
    flags: Array.from(flags).sort(),
    exclusions,
  };
}

/** ISO-week-style key, parameterized by week-start day-of-week. */
function weekKeyFor(date: Date, weekStartDay: number): string {
  // Anchor on a UTC date so DST doesn't shift bucket boundaries.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diff = (day - weekStartDay + 7) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}
