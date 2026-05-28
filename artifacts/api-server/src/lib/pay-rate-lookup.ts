/**
 * Cutover 1E — Dated rate selection.
 *
 * The effective hourly rate for an employee on a given date is the
 * rate row with the LATEST effective_date that is <= the date AND
 * (end_date IS NULL OR end_date >= date). Rows are never overwritten;
 * a rate change creates a new row and closes the prior one off.
 *
 * Returns null if no rate row applies — the pay pipeline flags the
 * summary with `missing_rate` so the office sees it.
 */

export type RateRowInput = {
  hourly_rate: string | number;
  effective_date: string; // YYYY-MM-DD
  end_date: string | null; // YYYY-MM-DD or null
};

/** Pick the effective rate for `date` from a list of rate rows for a
 *  single user. Date strings compared lexicographically — safe for
 *  YYYY-MM-DD ISO dates. */
export function pickRateForDate(
  rates: RateRowInput[],
  date: string,
): number | null {
  let best: RateRowInput | null = null;
  for (const r of rates) {
    if (r.effective_date > date) continue;
    if (r.end_date != null && r.end_date < date) continue;
    if (!best || r.effective_date > best.effective_date) best = r;
  }
  if (!best) return null;
  const n = Number(best.hourly_rate);
  return Number.isFinite(n) ? n : null;
}
