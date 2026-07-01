/**
 * Cancellation tech-pay resolver.
 *
 * When a charging cancellation fires (cancel / lockout), the assigned
 * tech(s) still earn something — they were on the schedule, may have
 * driven out, may have shown up to a locked door. Two modes per the
 * tenant's policy:
 *
 *   flat    — fixed dollar amount per cancellation event, regardless of
 *             job size. Phes default $60.
 *   percent — percentage of the customer's charge_amount. Lets the
 *             tenant say "tech keeps 40% of whatever we collected".
 *
 * Free actions (move / bump / skip / cancel_service) pay nothing —
 * there's no charge to share and the visit wasn't fulfilled.
 *
 * The total is split equally across the assigned tech(s). We do NOT do
 * proportional-by-minutes here because nobody actually worked — there's
 * no clock data to weight by.
 *
 * Pure function. The route layer fetches the tenant policy + assigned
 * tech list and the calling caller decides how to write the
 * additional_pay rows.
 */

import type { CancelAction } from "./cancellation-policy.js";
import { CHARGING_ACTIONS } from "./cancellation-policy.js";

export type CancellationTechPayMode = "flat" | "percent";

export interface TechPayPolicy {
  mode: CancellationTechPayMode;
  /** Dollars when mode='flat'; percentage 0-100 when mode='percent'. */
  amount: number;
}

export interface TechPayInput {
  action: CancelAction;
  /** Customer-side charge for this cancellation (post-override). */
  customerChargeAmount: number;
  /** Number of assigned techs to split the pay across. */
  numTechs: number;
  policy: TechPayPolicy;
  /**
   * [cancel-fee-policy 2026-07-01] Explicit operator override for whether this
   * cancellation pays the assigned tech(s) — set by the cancel modal's "Pay the
   * assigned tech the $60 cancellation fee" checkbox.
   *   true      → pay per policy.
   *   false     → waive the tech's fee (pay nothing).
   *   undefined → default (pay).
   *
   * Policy (Sal, 2026-07-01): an inside-48hr cancellation charges the customer
   * the full job amount AND pays the assigned tech the flat $60 fee — for BOTH
   * `cancel` and `lockout`. So the default is to PAY. The office waives it
   * per-job (payTech=false) for unexpected circumstances, and a full fee waiver
   * (customerChargeAmount → 0) is handled by the caller, which skips this
   * resolver entirely when nothing is charged.
   */
  payTech?: boolean;
}

export interface TechPayResult {
  /** Total dollars to distribute across the assigned techs. */
  total_pay: number;
  /** Each tech's slice (total_pay / numTechs, rounded). */
  pay_per_tech: number;
  /** True when policy resolved to a non-zero payout. */
  pays_tech: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function resolveCancellationTechPay(input: TechPayInput): TechPayResult {
  const empty: TechPayResult = { total_pay: 0, pay_per_tech: 0, pays_tech: false };

  if (!CHARGING_ACTIONS.has(input.action)) return empty;
  if (input.numTechs <= 0) return empty;

  // Whether this event pays the tech at all. A charging cancellation pays the
  // flat fee by default (Sal's policy: cancel/lockout both owe the tech $60);
  // the office waives it per-job via payTech=false. See TechPayInput.payTech.
  const shouldPay = input.payTech ?? true;
  if (!shouldPay) return empty;

  const total = input.policy.mode === "percent"
    ? round2(Math.max(0, input.customerChargeAmount) * (input.policy.amount / 100))
    : round2(Math.max(0, input.policy.amount));

  if (total === 0) return empty;

  return {
    total_pay: total,
    pay_per_tech: round2(total / input.numTechs),
    pays_tech: true,
  };
}
