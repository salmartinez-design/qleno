/**
 * Cutover 1E — Money math on top of hours computation.
 *
 * Combines:
 *   - regular_minutes + overtime_minutes from lib/pay-hours.ts
 *   - hourly_rate as of the period from lib/pay-rate-lookup.ts
 *   - sum of pay_adjustments rows for the period
 *
 * Money is stored as numeric(10,2) — kept as cents internally to
 * dodge JS float drift, rounded once at the boundary. Overtime
 * multiplier is 1.5x the regular rate (FLSA standard).
 */
import { minutesToHours } from "./pay-hours.js";

export type ComputeSummaryInput = {
  regular_minutes: number;
  overtime_minutes: number;
  hourly_rate: number | null;
  adjustments_cents: number;
};

export type ComputeSummaryResult = {
  regular_hours: number;
  overtime_hours: number;
  regular_pay_cents: number;
  overtime_pay_cents: number;
  adjustments_cents: number;
  gross_cents: number;
};

export function computeSummary(
  input: ComputeSummaryInput,
): ComputeSummaryResult {
  const regularHours = minutesToHours(input.regular_minutes);
  const overtimeHours = minutesToHours(input.overtime_minutes);

  if (input.hourly_rate == null) {
    return {
      regular_hours: regularHours,
      overtime_hours: overtimeHours,
      regular_pay_cents: 0,
      overtime_pay_cents: 0,
      adjustments_cents: input.adjustments_cents,
      gross_cents: input.adjustments_cents,
    };
  }

  const rateCents = Math.round(input.hourly_rate * 100);
  // (minutes * rate_cents / 60) yields cents directly; round at the end.
  const regularPayCents = Math.round(
    (input.regular_minutes * rateCents) / 60,
  );
  // FLSA overtime = 1.5x. Compute the OT minutes at 1.5x.
  const overtimePayCents = Math.round(
    (input.overtime_minutes * rateCents * 1.5) / 60,
  );
  const grossCents =
    regularPayCents + overtimePayCents + input.adjustments_cents;

  return {
    regular_hours: regularHours,
    overtime_hours: overtimeHours,
    regular_pay_cents: regularPayCents,
    overtime_pay_cents: overtimePayCents,
    adjustments_cents: input.adjustments_cents,
    gross_cents: grossCents,
  };
}

export function dollarsToCents(amount: number | string): number {
  return Math.round(Number(amount) * 100);
}

export function centsToDollarString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}
