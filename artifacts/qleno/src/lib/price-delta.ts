/**
 * [job-card-redesign] Pure helper for the chip's price + delta render.
 *
 * The dispatch payload exposes both `amount` (the original quote, sourced
 * from jobs.base_fee) and `billed_amount` (the current charged price,
 * sourced from jobs.billed_amount and updated by add-on / hour / discount
 * edits). The chip shows a green "↑ $X" or red "↓ $X" pill ONLY when
 * those two diverge by at least $0.50 — small float drift from
 * recalculation isn't worth surfacing.
 *
 * Hourly jobs intentionally hide the delta: the displayed "$X/hr" is
 * the hourly rate, not the job total, so subtracting from base_fee
 * isn't meaningful.
 */

export interface PriceDeltaInput {
  amount: number | null | undefined;          // base_fee on the payload
  billedAmount: number | null | undefined;    // billed_amount on the payload
  hourlyRate: number | null | undefined;
  billingMethod: string | null | undefined;
  allowedHours?: number | null | undefined;   // billed hours for hourly jobs
}

export interface PriceDelta {
  /** What to render as the price text (already $-prefixed). */
  display: string;
  /** Signed dollar delta (current − original). null when no pill should render. */
  deltaAmount: number | null;
  /** True for hourly jobs — caller can use this to suppress the delta. */
  isHourly: boolean;
  /** For hourly jobs, the rate detail to show under the total ("$50/hr × 4h"). */
  hourlyDetail?: string | null;
}

const DELTA_EPSILON = 0.5;

export function computePriceDelta(input: PriceDeltaInput): PriceDelta {
  const isHourly = input.billingMethod === "hourly" && input.hourlyRate != null;

  if (isHourly) {
    // [hourly-billing 2026-07-03] Show the full computed TOTAL (base_fee =
    // rate × billed hours + add-ons), not the bare rate — the office must see
    // the price, and it must move when the billed hours change (PPM 3h→4h).
    // The rate stays visible as a secondary detail ("$50/hr × 4h").
    const total = Number(input.amount ?? 0);
    const rate = (input.hourlyRate ?? 0).toFixed(0);
    const ah = input.allowedHours;
    return {
      display: total.toLocaleString("en-US", { style: "currency", currency: "USD" }),
      deltaAmount: null,
      isHourly: true,
      hourlyDetail: ah != null && ah > 0 ? `$${rate}/hr × ${ah}h` : `$${rate}/hr`,
    };
  }

  const baseFee = Number(input.amount ?? 0);
  const billed = input.billedAmount != null ? Number(input.billedAmount) : null;

  // Delta renders only when:
  //   - billed is non-null AND
  //   - base_fee was a real positive number (so we have an "original" to
  //     diff against; jobs imported with base_fee=0 don't pop a "↑ $150"
  //     pill the moment billed_amount lands), AND
  //   - the two diverge by at least $0.50 (filter float drift from
  //     re-aggregation)
  const delta = billed != null && baseFee > 0 && Math.abs(billed - baseFee) >= DELTA_EPSILON
    ? billed - baseFee
    : null;

  // Display: billed if present (it's the current price), else base_fee.
  // Preserves the prior `billed ?? base_fee` semantic — billed is more
  // current even when delta is suppressed (e.g. base=0).
  const displayValue = billed != null ? billed : baseFee;
  return {
    // [penny-exact 2026-06-04] Render full cents + thousands separators
    // ($1,339.20 — not $1339). Dispatch dollars are reconciled against
    // MaidCentral/ADP payroll to the cent, so rounding the chip drops the
    // exact figure the office is matching against.
    display: displayValue.toLocaleString("en-US", { style: "currency", currency: "USD" }),
    deltaAmount: delta,
    isHourly: false,
  };
}
