/**
 * Commercial pricing rules — one definition of "does this visit's price still
 * agree with its hours?", shared by the api-server and the frontend.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * National Able cut from 8 hours a day to 4 in August 2026. Their invoices were
 * always right — those bill actual hours at $50. But `jobs.base_fee`, the number
 * every report reads, stayed at the 8-hour price of $400 on 266 future visits,
 * and the schedule template kept generating more of them. Qleno carried $53,100
 * of revenue that was never going to arrive, for four months, and nothing
 * anywhere said a word.
 *
 * ── Why the obvious fix is wrong ──────────────────────────────────────────
 *
 * The instinct is to make price a derived field: hours × rate, recalculated
 * whenever hours change. An audit of all 41 active commercial schedules on Phes
 * says no. THIRTY-EIGHT of them have no hourly rate at all — Autochlor $150,
 * City Light Church $175, every Cucci, KMA, PPM and ProManage site. They are
 * flat price per visit and the hours on them are a labor budget, not a billing
 * input. Deriving price from hours would rewrite prices on 38 accounts that
 * never agreed to be billed that way. Of the three schedules that DO carry an
 * hourly rate, one (Ricardo Davis) has a stale $62.50/hr against a flat $125
 * invoiced price, so deriving would have raised his bill to $187.50.
 *
 * So: never derive, never auto-correct. Detect the disagreement and say so.
 * A human decides whether the price or the hours is the thing that's wrong.
 *
 * ── When this fires ───────────────────────────────────────────────────────
 *
 * Only when all of these hold, which is what keeps the 38 flat-fee schedules
 * silent:
 *   - an hourly rate is set and positive        (no rate = flat fee, nothing to compare)
 *   - hours are set and positive                (no hours = nothing to multiply)
 *   - the price is not manually pinned          (manual_rate_override = an agreed price)
 *   - price and hours × rate differ by over 1¢  (tolerance for numeric rounding)
 */

export type CommercialPricingInput = {
  /** Labor budget. Schedules carry `duration_minutes`; jobs carry `allowed_hours`. */
  hours: number | string | null | undefined;
  /** The price actually stored — `base_fee` on both jobs and schedules. */
  fee: number | string | null | undefined;
  /** `commercial_hourly_rate` on a schedule, `hourly_rate` on a job. */
  rate: number | string | null | undefined;
  /** A pinned, separately agreed price. Pinned prices are never questioned. */
  manualRateOverride?: boolean | null;
};

export type CommercialPricingMismatch = {
  hours: number;
  rate: number;
  /** hours × rate, rounded to the cent. */
  expectedFee: number;
  /** What is stored today. */
  storedFee: number;
  /** expectedFee − storedFee. Negative means the stored price is too high. */
  difference: number;
};

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Minutes → hours, for callers holding a schedule's `duration_minutes`. */
export function hoursFromMinutes(minutes: number | string | null | undefined): number | null {
  const m = num(minutes);
  return m === null ? null : m / 60;
}

/**
 * The disagreement between a commercial visit's stored price and its hours ×
 * rate, or `null` when there is nothing to compare (see the header for the four
 * conditions). `null` is the normal answer — it covers every flat-fee schedule.
 */
export function commercialPricingMismatch(
  input: CommercialPricingInput,
): CommercialPricingMismatch | null {
  if (input.manualRateOverride) return null;

  const rate = num(input.rate);
  const hours = num(input.hours);
  const fee = num(input.fee);
  if (rate === null || rate <= 0) return null;
  if (hours === null || hours <= 0) return null;
  if (fee === null) return null;

  const expectedFee = round2(hours * rate);
  const storedFee = round2(fee);
  const difference = round2(expectedFee - storedFee);
  if (Math.abs(difference) <= 0.01) return null;

  return { hours, rate, expectedFee, storedFee, difference };
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * The mismatch as one plain sentence, for a banner or a warning row. Says what
 * is true, not what to do — the decision belongs to whoever reads it.
 */
export function describeCommercialPricingMismatch(m: CommercialPricingMismatch): string {
  const hrs = Number.isInteger(m.hours) ? String(m.hours) : m.hours.toFixed(2);
  return (
    `Priced at ${money(m.storedFee)}, but ${hrs} ${m.hours === 1 ? "hour" : "hours"} ` +
    `at ${money(m.rate)}/hr is ${money(m.expectedFee)}.`
  );
}
