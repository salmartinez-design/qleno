/**
 * Cancellation policy — resolves the customer charge for a given (action,
 * client, company, job) tuple.
 *
 * Charging rules (Sal's stated policy, June 2026):
 *   - cancel  → full charge (per-client cancel_fee_pct ?? company default)
 *   - lockout → full charge (per-client lockout_fee_pct ?? company default)
 *   - move / bump / skip / cancel_service → no charge
 *   - modify is NOT a cancellation; it routes to the schedule editor
 *
 * For charging actions, we DO NOT mark the job 'cancelled' with a zero
 * billed_amount — instead, the existing billed_amount stays. Per Sal:
 * "Job's base_fee + billed_amount stays — mark job 'complete' with
 * cancellation note." The cancellation_log row carries the audit.
 *
 * This module is pure: it reads the inputs, returns the decision. The
 * route layer does the DB write + status flip + log row.
 */

export type CancelAction =
  | "move"
  | "bump"
  | "skip"
  | "cancel"
  | "lockout"
  | "cancel_service";

export const CANCEL_ACTIONS: readonly CancelAction[] = [
  "move", "bump", "skip", "cancel", "lockout", "cancel_service",
];

/** Actions that auto-charge the customer. */
export const CHARGING_ACTIONS: ReadonlySet<CancelAction> = new Set(["cancel", "lockout"]);

/** Actions that terminate the recurring schedule (affects future jobs). */
export const FUTURE_AFFECTING_ACTIONS: ReadonlySet<CancelAction> = new Set(["cancel_service"]);

export interface PolicyInput {
  action: CancelAction;
  /** Effective amount on the job (billed_amount ?? base_fee). */
  jobAmount: number;
  /** Per-tenant defaults — always non-null in practice (DB defaults to 100). */
  companyDefaultCancelFeePct: number;
  companyDefaultLockoutFeePct: number;
  /** Per-tenant FLAT fees ($). When > 0, the flat fee is charged INSTEAD of
   *  the percentage for that action. Default 0 = bill the percentage. Lets a
   *  tenant choose flat-rate vs % of job cost. */
  companyDefaultCancelFeeFlat?: number;
  companyDefaultLockoutFeeFlat?: number;
  /** Per-client overrides — NULL means "use the company default". */
  clientCancelFeePct: number | null;
  clientLockoutFeePct: number | null;
}

export interface PolicyResult {
  charge_amount: number;
  fee_pct_applied: number;
  /** Dollars when a flat fee was applied (0 when the percentage was used). */
  fee_flat_applied: number;
  charges_customer: boolean;
  affects_future_jobs: boolean;
  /** Status the job row should end up in after this action. */
  next_job_status: "cancelled" | "complete";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function resolveCancellationPolicy(input: PolicyInput): PolicyResult {
  const charges = CHARGING_ACTIONS.has(input.action);
  const affectsFuture = FUTURE_AFFECTING_ACTIONS.has(input.action);

  if (!charges) {
    return {
      charge_amount: 0,
      fee_pct_applied: 0,
      fee_flat_applied: 0,
      charges_customer: false,
      affects_future_jobs: affectsFuture,
      next_job_status: "cancelled",
    };
  }

  const pct = input.action === "lockout"
    ? (input.clientLockoutFeePct ?? input.companyDefaultLockoutFeePct)
    : (input.clientCancelFeePct ?? input.companyDefaultCancelFeePct);

  // [cancel-fee-flat 2026-06-17] A tenant can set a FLAT fee per action; when
  // present (> 0) it's charged instead of the percentage. Tenants that bill a
  // percentage of the job cost leave the flat at 0.
  const flat = input.action === "lockout"
    ? (input.companyDefaultLockoutFeeFlat ?? 0)
    : (input.companyDefaultCancelFeeFlat ?? 0);
  const usingFlat = flat > 0;

  const charge_amount = usingFlat
    ? round2(flat)
    : round2(Math.max(0, input.jobAmount) * (pct / 100));

  return {
    charge_amount,
    fee_pct_applied: usingFlat ? 0 : pct,
    fee_flat_applied: usingFlat ? round2(flat) : 0,
    charges_customer: charge_amount > 0,
    affects_future_jobs: affectsFuture,
    // Per Sal: charged cancellations stay as a 'complete' artifact so the
    // billed_amount lands on the revenue reports unchanged.
    next_job_status: "complete",
  };
}
