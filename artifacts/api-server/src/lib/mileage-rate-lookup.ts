/**
 * Cutover 2A (corrective) — Dated mileage rate selection.
 *
 * The rate paid on a given leg is the row whose effective_date is the
 * LATEST on or before the leg's date AND (end_date IS NULL OR
 * end_date >= leg date). Rows are never overwritten; an IRS change
 * creates a new row and (optionally) closes the prior one. Past
 * periods stay reproducible from their original rate.
 *
 * Mirrors the shape of pay-rate-lookup so the office mental model and
 * the audit story line up across hourly and per-mile.
 */

export type MileageRateRowInput = {
  rate: string | number;
  effective_date: string; // YYYY-MM-DD
  end_date: string | null; // YYYY-MM-DD or null
};

/** Pick the effective $/mi for `date` from a list of mileage rate
 *  rows for a single tenant. Returns null when no row applies — the
 *  caller MUST handle null by skipping + flagging, never by silently
 *  falling back to a hardcoded rate. */
export function pickMileageRateForDate(
  rates: MileageRateRowInput[],
  date: string,
): number | null {
  let best: MileageRateRowInput | null = null;
  for (const r of rates) {
    if (r.effective_date > date) continue;
    if (r.end_date != null && r.end_date < date) continue;
    if (!best || r.effective_date > best.effective_date) best = r;
  }
  if (!best) return null;
  const n = Number(best.rate);
  return Number.isFinite(n) ? n : null;
}
