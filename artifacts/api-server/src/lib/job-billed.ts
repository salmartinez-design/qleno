// [billed-reconcile 2026-07-27] Single source of truth for a job's BILLED
// total — the number the client was actually invoiced. Extracted from the
// dispatch board's live `amount` computation (routes/dispatch.ts) so every
// surface (dispatch card, Time Clock revenue, reports) reconciles to the same
// figure instead of each re-deriving it and drifting.
//
// WHY this exists: the parking fee (and every add-on) is stored as a separate
// job_add_ons row — it is NOT folded into base_fee / billed_amount /
// commission_base. Only code that JOINs and SUMs job_add_ons sees it. The
// dispatch card did; the Time Clock did not, so National Able #4357 read
// $380 (stale commission_base, no parking) on the clock while the Jobs page
// correctly showed $420 ($50/hr × 8h + $20 parking). This helper is that one
// correct computation, shared.
//
// It is display-only revenue. It does NOT drive commission or pay — those go
// through lib/commission-paytype.ts, which reads its own bases.

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

export interface BilledJobFields {
  base_fee: number | string | null | undefined;
  billed_amount: number | string | null | undefined;
  hourly_rate: number | string | null | undefined;
  allowed_hours: number | string | null | undefined;
  manual_rate_override: boolean | null | undefined;
}

export interface BilledSums {
  /** SUM of ALL job_rate_mods.amount for the job. */
  mods?: number;
  /** SUM of job_rate_mods.amount WHERE mod_type='flat' (commercial adds only
   *  flat mods — a 'time' mod already grew allowed_hours, so its dollars are
   *  already inside rate × hrs). */
  flatMods?: number;
  /** SUM of job_add_ons.subtotal (parking fee, etc.). */
  addOns?: number;
  /** SUM of job_discounts.amount — subtracted from gross to mirror the invoice. */
  discount?: number;
}

/**
 * GROSS billed (before discounts). Mirrors the dispatch board's inner `gross`
 * closure exactly:
 *   • Commercial, not pinned, with rate & hours → rate × hours + flat mods + add-ons
 *   • Commercial pinned (manual_rate_override) or missing inputs → base_fee + all mods
 *     (add-ons are considered already inside the pinned base_fee — do not re-add)
 *   • Residential → explicit billed_amount if set, else base_fee + all mods
 *     (base_fee is the all-in residential total that ALREADY includes add-ons —
 *     re-adding them double-counts, so we never add add-ons on residential)
 */
export function computeJobBilledGross(
  j: BilledJobFields,
  sums: BilledSums,
  isCommercial: boolean
): number {
  const mods = sums.mods ?? 0;
  const flatMods = sums.flatMods ?? 0;
  const addOns = sums.addOns ?? 0;
  const override = j.manual_rate_override === true;

  if (isCommercial) {
    const rate = num(j.hourly_rate) ?? 0;
    const hrs = num(j.allowed_hours) ?? 0;
    if (!override && rate > 0 && hrs > 0) {
      return rate * hrs + flatMods + addOns;
    }
    const base = num(j.base_fee) ?? 0;
    return base + mods;
  }

  const billed = num(j.billed_amount);
  if (billed != null && billed > 0) return billed;
  const base = num(j.base_fee) ?? 0;
  return base + mods;
}

/** NET billed = gross − discounts, rounded to cents, floored at 0. This is the
 *  figure the dispatch card shows and the invoice charges. */
export function computeJobBilledNet(
  j: BilledJobFields,
  sums: BilledSums,
  isCommercial: boolean
): number {
  const gross = computeJobBilledGross(j, sums, isCommercial);
  const discount = sums.discount ?? 0;
  const net = Math.round((gross - discount) * 100) / 100;
  return net > 0 ? net : 0;
}
