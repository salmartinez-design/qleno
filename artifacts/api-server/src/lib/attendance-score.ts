/**
 * Attendance sub-score — the ladder-based model. [attendance-ladder 2026-08-21]
 *
 * Replaces the old days-ratio ("scheduled days minus weighted violations, over
 * scheduled days"), which made a single tardy worth about a fifth of a point on
 * a tech's headline Performance Score. A worker could be one occurrence from a
 * written warning and still show a green 99%. The score and the discipline that
 * actually happens to someone disagreed, so the score taught nobody anything.
 *
 * The new model reads the SAME numbers the disciplinary ladder reads: occurrences
 * in the benefit year, counted on two independent tracks (tardy, unexcused). The
 * score is how far along the ladder you are, expressed as a percentage:
 *
 *     score = 100 − (occurrences ÷ termination-step) × 100
 *
 * so 0 occurrences = 100%, and standing at the termination rung = 0%. On Phes's
 * configured 3/4/5 ladder, one occurrence costs 20 points of attendance and,
 * at the 25% blend weight, 5 points of the headline score. That is a number an
 * employee can feel, which is the entire point.
 *
 * FOUR THINGS THIS FILE IS CAREFUL ABOUT
 *
 * 1. The termination step is TENANT DATA, never a constant. It comes from
 *    company_attendance_policy.{tardy,unexcused}_occurrence_steps. Phes runs
 *    3=written / 4=final / 5=termination on both tracks today, but a tenant that
 *    configures a 10-step ladder must get a 10-step curve, not a 5-step one. If
 *    no ladder is configured there is no denominator and no honest score, so the
 *    result is null — a dash — never a flattering 100%.
 *
 * 2. The two tracks show the WORSE of the two, never an average. Someone with 4
 *    tardies and 0 absences is one rung from termination; averaging the tracks
 *    would report them as comfortably fine. Each track is measured against its
 *    OWN termination step and the worse RATIO wins, which is identical to
 *    max(tardy, unexcused) whenever the two ladders match (they do at Phes) and
 *    stays correct if a tenant ever sets them differently.
 *
 * 3. Protected absences count ZERO. The old score filtered on row type alone, so
 *    a PLAWA-covered sick day — leave the employee is legally entitled to — pulled
 *    their score down. That is the kind of bug that turns a scorecard into a
 *    retaliation claim. Counting here routes through countUnexcusedOccurrences,
 *    the same function the ladder uses, so protection is honored identically in
 *    both places. A No-Call/No-Show still counts, protected or not: the missing
 *    phone call is procedural and independent of anyone's leave balance.
 *
 * 4. There is ONE window and it is the employee's own benefit year, opening on
 *    their work anniversary. Both tracks use it, and so does the disciplinary
 *    ladder, so the score and the write-up can never be measured off different
 *    calendars. See attendanceWindowStart.
 */

import { benefitYearStartDate } from "./leave-grant-reset.js";
import { countUnexcusedOccurrences, type OccurrenceRow } from "./attendance-compliance.js";

/** One step of a tenant's configured occurrence ladder. */
export interface LadderStepLike {
  occurrence: number | string;
  discipline_type?: string;
}

/**
 * The occurrence count at which a tenant's ladder reaches termination — the
 * denominator of the score.
 *
 * Prefers a step explicitly typed 'termination'. Falls back to the highest
 * configured occurrence when a tenant's last rung is named something else
 * (a 'custom' final review, say), because the top of the ladder is the bottom
 * of the score either way. Returns null when nothing usable is configured;
 * callers must render a dash rather than invent a denominator.
 */
export function terminationOccurrences(
  steps: ReadonlyArray<LadderStepLike> | null | undefined,
): number | null {
  if (!Array.isArray(steps)) return null;
  const valid = steps
    .map((s) => Number(s?.occurrence))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!valid.length) return null;

  const term = steps
    .filter((s) => String(s?.discipline_type ?? "").toLowerCase() === "termination")
    .map((s) => Number(s?.occurrence))
    .filter((n) => Number.isFinite(n) && n > 0);

  return term.length ? Math.min(...term) : Math.max(...valid);
}

/**
 * Where this employee's score window opens: the start of their benefit year,
 * which is their work anniversary. Both args and the return are YYYY-MM-DD.
 *
 * ONE WINDOW, DELIBERATELY. [one-window 2026-08-21]
 *
 * An earlier draft of this file floored the window at the 2026-07-01 Qleno
 * cutover, to keep unverified MaidCentral-era rows from dragging a score down.
 * That floor was removed before it ever shipped, for two reasons:
 *
 *   - The disciplinary ladder never had it. The ladder counts occurrences from
 *     the plain benefit year, which is what the employee handbook and the LMS
 *     teach. Hilda Gallegos's own file shows the split a floor would create: her
 *     final-warning row reads "unexcused-occ by=2026-05-25 count=4" while a
 *     floored score would display 3 of 5. Two numbers for one fact, on one
 *     screen, is the exact defect this rewrite set out to close.
 *   - It is unnecessary for tardies, because the tardy slate was wiped on
 *     2026-08-21 (231 rows, 220 of them the June 25 bulk import) at Sal's
 *     instruction: "Wipe everyones tardies ... lets give everyone a clean slate."
 *     No stale tardy history is left for a floor to guard against.
 *
 * That leaves the imported ABSENCE rows, which Sal deliberately kept — "As far as
 * the other attendance buckets to my knowledge they are working fine." Flooring
 * them would have silently re-scored absences during a session scoped to tardies.
 * Leaving them unfloored keeps absence scoring byte-identical to what production
 * already does.
 *
 * If unverified imported history ever does need to come out of the score, delete
 * the rows the way the tardies were deleted. Do not reintroduce a second window:
 * a date the score honors and the ladder ignores is how the two drift apart.
 */
export function attendanceWindowStart(hireDate: string, asOf: string): string {
  return benefitYearStartDate(hireDate, asOf).toISOString().slice(0, 10);
}

export interface AttendanceLadderInput {
  /** Attendance rows already narrowed to the window. Both tracks together. */
  rows: ReadonlyArray<OccurrenceRow>;
  /** The tenant's tardy ladder, as configured. */
  tardySteps: ReadonlyArray<LadderStepLike> | null | undefined;
  /** The tenant's unexcused ladder, as configured. */
  unexcusedSteps: ReadonlyArray<LadderStepLike> | null | undefined;
}

export interface AttendanceLadderScore {
  /** 0–100, or null when no ladder is configured to measure against. */
  score: number | null;
  tardy_occurrences: number;
  unexcused_occurrences: number;
  tardy_termination_at: number | null;
  unexcused_termination_at: number | null;
  /** Which track produced the score — the worse of the two. */
  driver: "tardy" | "unexcused" | null;
}

/**
 * The score itself, from occurrence rows plus the tenant's two ladders.
 *
 * Pure: no DB, no clock. Every judgment call above is visible here in about
 * fifteen lines, which is the point of keeping it separate from the query.
 */
export function scoreAttendanceLadder(input: AttendanceLadderInput): AttendanceLadderScore {
  // Tardies: protection zeroes a row, same rule the ladder writer applies.
  // (A protected tardy is unusual but the office can flag one, and when they
  // do it must not count here either.)
  const tardy_occurrences = input.rows.filter(
    (r) => r.type === "tardy" && !r.protected,
  ).length;

  // Unexcused: absences and no-shows, weighted by the shared counter so that
  // protection and the NCNS weight can never drift between score and ladder.
  const unexcused_occurrences = countUnexcusedOccurrences(
    input.rows.filter((r) => r.type === "absent" || r.type === "ncns"),
  );

  const tardyTerm = terminationOccurrences(input.tardySteps);
  const unexTerm = terminationOccurrences(input.unexcusedSteps);

  // Each track against its own ladder; the worse ratio wins. With both ladders
  // at 5 this is exactly max(tardy, unexcused) over 5.
  const ratios: Array<{ ratio: number; driver: "tardy" | "unexcused" }> = [];
  if (tardyTerm) ratios.push({ ratio: tardy_occurrences / tardyTerm, driver: "tardy" });
  if (unexTerm) ratios.push({ ratio: unexcused_occurrences / unexTerm, driver: "unexcused" });

  if (!ratios.length) {
    return {
      score: null,
      tardy_occurrences,
      unexcused_occurrences,
      tardy_termination_at: tardyTerm,
      unexcused_termination_at: unexTerm,
      driver: null,
    };
  }

  const worst = ratios.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  const raw = 100 - worst.ratio * 100;
  const score = Math.max(0, Math.min(100, Math.round(raw * 100) / 100));

  return {
    score,
    tardy_occurrences,
    unexcused_occurrences,
    tardy_termination_at: tardyTerm,
    unexcused_termination_at: unexTerm,
    // A clean record has no driver worth naming — don't tell the UI that
    // "tardy" is dragging a perfect score.
    driver: worst.ratio > 0 ? worst.driver : null,
  };
}
