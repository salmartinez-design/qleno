/**
 * PLAWA attendance-compliance helpers (Illinois Paid Leave for All Workers Act).
 *
 * Pure functions — no DB, no side effects — so they unit-test without a
 * database and can be reused by the leave route, the ladder writer, and the
 * reliability read.
 *
 * Two compliance rules live here:
 *
 *   1. Minimum-increment floor. PLAWA lets an employer require a minimum
 *      increment for leave use, capped at 2 hours. Phes sets 2h. So a same-day
 *      call-off or tardy that draws PLAWA deducts AT LEAST 2 hours from the
 *      bank — UNLESS the employee's scheduled shift that day was shorter than
 *      2h, in which case you can't require more than the shift.
 *
 *   2. Occurrence weighting. The disciplinary ladder counts INCIDENTS per
 *      benefit year. A protected (PLAWA-covered, proper-notice) absence counts
 *      ZERO. A plain unexcused absence counts 1. A No-Call/No-Show counts 2 —
 *      it's a procedural notice violation the state lets us penalize, and it
 *      counts regardless of remaining PLAWA balance.
 *
 * NONE of this is legal advice — it encodes the office's written policy for
 * review, and no dollars or terminations move automatically from these numbers.
 */

/** Phes's PLAWA minimum-increment. IL caps the employer-set minimum at 2h. */
export const MIN_PLAWA_INCREMENT_HOURS = 2;

/** A No-Call/No-Show weighs this many occurrences on the unexcused ladder. */
export const NCNS_OCCURRENCE_WEIGHT = 2;

/**
 * Floor a PLAWA deduction to the minimum increment.
 *
 * @param slug             the leave bucket slug (only 'plawa' is floored)
 * @param requestedHours   hours the office is deducting
 * @param scheduledShiftHours  the employee's scheduled shift length that day,
 *                             if known. When it's a positive number below the
 *                             minimum increment, the floor drops to the shift
 *                             length (can't require more leave than the shift).
 * @returns the hours to actually deduct.
 */
export function applyPlawaMinimumIncrement(
  slug: string,
  requestedHours: number,
  scheduledShiftHours?: number | null,
): number {
  const req = Number(requestedHours);
  if (!Number.isFinite(req) || req <= 0) return req;
  if (String(slug).toLowerCase() !== "plawa") return req; // only PLAWA is floored
  if (req >= MIN_PLAWA_INCREMENT_HOURS) return req; // already at/over the minimum

  // Sub-minimum request. The floor is 2h, unless the scheduled shift was
  // shorter than 2h — then the shift length is the ceiling on what we can
  // require, so floor to that instead.
  const shift = Number(scheduledShiftHours);
  if (Number.isFinite(shift) && shift > 0 && shift < MIN_PLAWA_INCREMENT_HOURS) {
    return Math.max(req, shift);
  }
  return MIN_PLAWA_INCREMENT_HOURS;
}

/** One attendance-log row, as far as occurrence counting cares. */
export interface OccurrenceRow {
  type: "absent" | "tardy" | "ncns" | string;
  /** protected = PLAWA-covered with proper notice → never counts. */
  protected: boolean | null;
}

/**
 * Count unexcused-ladder occurrences from a set of attendance rows.
 *
 * Protected rows never count (PLAWA covers them). Plain unexcused absences
 * count 1 each. No-Call/No-Shows count {@link NCNS_OCCURRENCE_WEIGHT} each and
 * are NEVER treated as protected — a procedural violation stands regardless of
 * PLAWA balance.
 */
export function countUnexcusedOccurrences(rows: ReadonlyArray<OccurrenceRow>): number {
  let count = 0;
  for (const r of rows) {
    if (r.type === "ncns") {
      count += NCNS_OCCURRENCE_WEIGHT; // procedural — balance-independent, never protected
      continue;
    }
    if (r.protected) continue; // PLAWA-covered absence — zero
    if (r.type === "absent") count += 1;
  }
  return count;
}
