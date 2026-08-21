/**
 * The one place the attendance sub-score is put into words.
 *
 * [attendance-ladder 2026-08-21] The attendance sub-score used to be a days
 * ratio — violations over scheduled tech-days across the trailing 90 — so the
 * honest caption underneath it was "N issues · M days". It is now the
 * occurrence ladder itself (lib/attendance-score.ts on the server): the count
 * on each track measured against that track's termination rung, over the
 * employee's benefit year floored at the cutover.
 *
 * Two consequences the UI has to respect, and both of them used to be wrong:
 *
 *   1. "M days" is no longer part of the math. Leaving it on screen implies a
 *      tech can dilute a late by working more days. They cannot — one late is
 *      one rung whether they worked 3 days or 60.
 *   2. The three sub-scores no longer share a window. Satisfaction and
 *      complaint-free are still trailing 90; attendance runs from the benefit
 *      year (or the cutover, whichever is later). Any header that stamps
 *      "trailing 90 days" across all three is now a false claim about two
 *      thirds of the card, so windows are labelled per row instead.
 *
 * A dash is not a zero. When there is no hire date or no configured ladder the
 * score is null and the caption says which, rather than implying a clean
 * record.
 */

export interface AttendanceDetailLike {
  tardy_occurrences: number;
  unexcused_occurrences: number;
  tardy_termination_at: number | null;
  unexcused_termination_at: number | null;
}

export type AttendanceUnavailable = "no_hire_date" | "no_ladder" | null;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07-01" → "Jul 1". Parsed by hand: `new Date("2026-07-01")` is UTC
 *  midnight and renders as Jun 30 for anyone west of Greenwich. */
export function shortDate(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  if (!m) return "";
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The caption under the Attendance tile: what was counted, and since when. */
export function attendanceSubLabel(
  detail: AttendanceDetailLike | null | undefined,
  windowFrom: string | null | undefined,
  unavailable: AttendanceUnavailable,
): string {
  if (unavailable === "no_hire_date") return "start date needed";
  if (unavailable === "no_ladder") return "attendance policy not set";
  if (!detail) return "";

  const parts: string[] = [];
  if (detail.tardy_occurrences > 0) parts.push(plural(detail.tardy_occurrences, "late", "lates"));
  if (detail.unexcused_occurrences > 0) parts.push(plural(detail.unexcused_occurrences, "absence", "absences"));
  const counted = parts.length ? parts.join(" · ") : "no lates or absences";

  const since = shortDate(windowFrom);
  return since ? `${counted}, since ${since}` : counted;
}

/** How close this employee is to the last rung, for the surfaces that have the
 *  room to say it. Empty when the ladder is unconfigured or the record clean. */
export function attendanceLadderNote(
  detail: AttendanceDetailLike | null | undefined,
): string {
  if (!detail) return "";
  const worst = Math.max(
    detail.tardy_termination_at ? detail.tardy_occurrences / detail.tardy_termination_at : 0,
    detail.unexcused_termination_at ? detail.unexcused_occurrences / detail.unexcused_termination_at : 0,
  );
  if (worst <= 0) return "";
  const onTardy = detail.tardy_termination_at
    && detail.tardy_occurrences / detail.tardy_termination_at >= worst;
  const occ = onTardy ? detail.tardy_occurrences : detail.unexcused_occurrences;
  const term = (onTardy ? detail.tardy_termination_at : detail.unexcused_termination_at) ?? 0;
  if (!term) return "";
  return `${occ} of ${term}`;
}
