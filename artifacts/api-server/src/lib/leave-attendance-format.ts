/**
 * Pure helpers for the attendance-summary endpoint (Phase 2). No DB — so the
 * trickier bits (parsing unexcused hours out of the note marker, cleaning the
 * note for display, picking the next disciplinary step) are unit-testable
 * without the drizzle client. The DB query + assembly lives in routes/leave.ts.
 */

/** Discipline-type → human label (matches the dispatch/board conventions). */
export const DISC_LABEL: Record<string, string> = {
  tardy_warning: "Tardy warning",
  absence_warning: "Written warning",
  final_warning: "Final warning",
  quality_probation: "Quality probation",
  termination: "Termination review",
  custom: "Discipline",
};

/** Unexcused hours live in the attendance_log note as "unexcused hours: X.XX"
 *  (written by the ladder). Same regex the ladder reads back with. */
export const UNEXCUSED_HOURS_RE = /unexcused hours:\s*([0-9.]+)/i;

export function parseUnexcusedHours(notes: string | null): number {
  const m = UNEXCUSED_HOURS_RE.exec(notes || "");
  return m ? Number(m[1]) || 0 : 0;
}

/** Strip the "unexcused hours: X" marker (and wrapping parens) for display. */
export function cleanUnexNote(notes: string | null): string {
  return (
    (notes || "")
      .replace(/unexcused hours:\s*[0-9.]+/i, "")
      .replace(/^\s*\(|\)\s*$/g, "")
      .trim() || "Unexcused absence"
  );
}

export type LadderStep = { threshold_hours?: number; window_days?: number; discipline_type?: string; label?: string };

/** The lowest configured threshold the employee has NOT yet reached. Returns
 *  null when no steps are configured or all are already crossed. */
export function pickNextStep(
  steps: ReadonlyArray<LadderStep>,
  rollingHours: number,
): { threshold: number; label: string } | null {
  return steps
    .map((s) => ({
      threshold: Number(s?.threshold_hours),
      label: s?.label || DISC_LABEL[String(s?.discipline_type)] || "Discipline",
    }))
    .filter((s) => s.threshold > 0)
    .sort((a, b) => a.threshold - b.threshold)
    .find((s) => s.threshold > rollingHours) || null;
}

/** Max rolling window across the configured steps, floored at `fallback`. */
export function maxLadderWindow(steps: ReadonlyArray<LadderStep>, fallback: number): number {
  return steps.reduce((m, s) => Math.max(m, Number(s?.window_days) || 0), fallback);
}
