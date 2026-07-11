/**
 * Scorecard scale normalization (2026-07-11).
 *
 * The `scorecards.score` column is meant to hold the customer's rating on a
 * 0-4 scale (4 = Thrilled ... 1 = Major Concerns), the same scale the customer
 * profile UI and the `scorecard_avg` reader assume. Two things had drifted:
 *
 *   1. The inbound-SMS path wrote `Math.round(weight * 100)` — a 0-100 value
 *      (100 / 75 / 40 / 0) — into `score`. The profile reads that as 0-4 with a
 *      `>= 4` "green" threshold, so "A Few Concerns" (stored 40) rendered GREEN
 *      as if it were top marks. That's the "negative feedback came back like
 *      good feedback" bug.
 *   2. Seed data wrote a correct 0-4 value, so the column ended up mixed-scale.
 *
 * The fix stores the 0-4 `rating` in `score` going forward. This helper
 * canonicalizes any historical row back to 0-4 for the audit + backfill, so a
 * legacy 0-100 row (or one missing `rating`) still resolves correctly.
 *
 * Pure — no DB, no I/O. Unit-tested.
 */

/** weight (as written by the SMS path) -> 0-4 rating. Keys are stringified. */
export const RATING_FROM_WEIGHT: Readonly<Record<string, number>> = Object.freeze({
  "1": 4,
  "0.75": 3,
  "0.4": 2,
  "0": 1,
});

export interface ScorecardScaleRow {
  score?: number | string | null;
  rating?: number | string | null;
  weight?: number | string | null;
}

/**
 * The canonical 0-4 rating for a scorecard row.
 *
 * Priority: the explicit `rating` column (authoritative) -> a `score` already
 * on the 0-4 scale -> reverse-map from `weight` -> reverse-map from a 0-100
 * `score`. Returns null only when nothing usable is present.
 */
export function canonicalRating(row: ScorecardScaleRow): number | null {
  const rating = row.rating == null ? null : Number(row.rating);
  if (rating != null && Number.isFinite(rating)) return rating; // authoritative

  // `weight` is the unambiguous signal when present (0 -> rating 1), so it wins
  // over a low `score` — a stored score of 0 is a weight-0 "Major Concerns"
  // (rating 1), not a literal 0-4 rating of 0.
  const weight = row.weight == null ? null : String(Number(row.weight));
  if (weight != null && weight in RATING_FROM_WEIGHT) return RATING_FROM_WEIGHT[weight];

  const score = row.score == null ? null : Number(row.score);
  if (score != null && Number.isFinite(score)) {
    if (score >= 1 && score <= 4) return score; // already 0-4 (seed rows, 1-4)
    // Legacy 0-100 score with no rating/weight — reverse the weight*100 mapping.
    if (score >= 100) return 4;
    if (score >= 75) return 3;
    if (score >= 40) return 2;
    return 1; // 0..<40 -> Major Concerns
  }
  return null;
}

/** True when a row's stored `score` is off the 0-4 scale (needs backfill). */
export function isMisScaledScore(row: ScorecardScaleRow): boolean {
  const score = row.score == null ? null : Number(row.score);
  return score != null && Number.isFinite(score) && score > 4;
}
