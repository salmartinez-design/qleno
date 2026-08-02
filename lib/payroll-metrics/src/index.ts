/**
 * Canonical payroll metric definitions — the aggregate sibling of
 * `commission-compute.ts`.
 *
 * ── Why this package exists ───────────────────────────────────────────────
 *
 * `commission-compute.ts` made per-job commission a single source of truth
 * ("never inline × 0.35 or × 20 again" — CLAUDE.md). The metrics computed ON
 * TOP of it never got the same treatment, so by 2026-07-31 the payroll screens
 * had six different names for two different numbers:
 *
 *   Revenue   → `billed_amount ?? base_fee` (revenue-trend)
 *               `base_fee` alone            (reports job-costing)
 *   Payroll   → `grand_total`               (the Labor % numerator)
 *               `commission`                (the card printed beside it)
 *   Mileage   → every earned leg            (the Mileage card)
 *               applied legs only           (what's actually inside a total)
 *   Week      → job `scheduled_date`        (commission)
 *               `created_at`                (tips + adjustments)
 *
 * None of it was miscalculating. Every surface was internally consistent and
 * mutually contradictory, which is worse: Sal read 26.8% off a chart whose
 * denominator silently blended two branches, and a Labor % of 28.7% that could
 * not be derived from the two cards sitting next to it.
 *
 * The fix is not more careful arithmetic at each call site — it's removing the
 * call sites' freedom to invent arithmetic. Everything here is pure so it can
 * be unit-tested without a database, and it lives in a workspace package so the
 * api-server and the frontend import the SAME definition rather than two
 * mirrors that drift apart the first time only one of them is edited.
 *
 * ── The invariants (enforced in payroll-metrics-invariants.test.ts) ───────
 *
 *   1. Components sum to their total. `totalPay` is the only way to collapse
 *      PayComponents into one number.
 *   2. Pending money is never inside a total. It's a separate field, so it
 *      cannot be added in by accident.
 *   3. A ratio's numerator and denominator come from the same scope. Both are
 *      returned alongside the ratio so a UI can always show its inputs.
 */

/** Money rounding. One definition — half-cent drift compounds across a week. */
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * `additional_pay.type` values that are mileage reimbursement rather than pay.
 * Mileage is a reimbursement (29 CFR 778.217 — excluded from the regular rate),
 * so it must never be lumped into tips/bonuses.
 */
export const MILEAGE_PAY_TYPES: readonly string[] = ["mileage", "mileage_reimbursement"];

/**
 * The four components of what a person earned. There is deliberately NO field
 * called "payroll" — `totalPay()` is the only way to get one number, so no
 * caller can quietly pick a different subset and still call it payroll.
 */
export type PayComponents = {
  /** Commission from the canonical engine (+ per-job final_pay overrides). */
  commission: number;
  /** Tips, bonuses, event pay, holiday — everything EXCEPT mileage. */
  additional: number;
  /** Mileage the office has APPLIED at the review gate. Real money. */
  mileage_applied: number;
  /**
   * Mileage earned but not yet approved. Deliberately OUTSIDE every total:
   * "no money until reviewed" is load-bearing (CLAUDE.md, Mileage/Drive Time).
   * Display it, never bank it.
   */
  mileage_pending: number;
};

export const EMPTY_PAY: PayComponents = Object.freeze({
  commission: 0, additional: 0, mileage_applied: 0, mileage_pending: 0,
});

/**
 * The ONLY definition of "payroll" / "total pay". Pending mileage is excluded
 * by construction — it is not a term in this sum.
 */
export function totalPay(p: PayComponents): number {
  return round2(p.commission + p.additional + p.mileage_applied);
}

export function addPay(a: PayComponents, b: PayComponents): PayComponents {
  return {
    commission: round2(a.commission + b.commission),
    additional: round2(a.additional + b.additional),
    mileage_applied: round2(a.mileage_applied + b.mileage_applied),
    mileage_pending: round2(a.mileage_pending + b.mileage_pending),
  };
}

export function sumPay(items: readonly PayComponents[]): PayComponents {
  return items.reduce(addPay, EMPTY_PAY);
}

/**
 * Split an `additional_pay`-style `{ type → amount }` map into the pay half and
 * the mileage half. Both the tech earnings panel and the payroll page were
 * hand-rolling this filter with their own copy of the mileage key list.
 */
export function splitAdditionalPay(byType: Record<string, number> | null | undefined): {
  additional: number; mileage: number;
} {
  let additional = 0, mileage = 0;
  for (const [type, raw] of Object.entries(byType || {})) {
    const amt = Number(raw) || 0;
    if (MILEAGE_PAY_TYPES.includes(type)) mileage += amt;
    else additional += amt;
  }
  return { additional: round2(additional), mileage: round2(mileage) };
}

/**
 * Revenue, split by whether any payroll actually stood behind it.
 *
 * `attributed` = revenue from jobs that produced at least one commission row.
 * `unattributed` = everything else: jobs with no assigned tech, jobs whose
 * computed commission rounded to $0, and charged-cancels. Each contributes
 * 100% of its revenue and $0 of pay, so folding them into a labor-cost ratio
 * makes labor look cheaper than it is. Suspected dominant cause for Phes:
 * pre-cutover MaidCentral history imported as completed jobs with no Qleno
 * tech on them.
 */
export type RevenueComponents = {
  billed: number;
  attributed: number;
  unattributed: number;
};

export const EMPTY_REVENUE: RevenueComponents = Object.freeze({
  billed: 0, attributed: 0, unattributed: 0,
});

/** Build revenue components so `unattributed` can never disagree with the parts. */
export function makeRevenue(billed: number, attributed: number): RevenueComponents {
  const b = round2(billed), a = round2(attributed);
  return { billed: b, attributed: a, unattributed: round2(b - a) };
}

export function addRevenue(x: RevenueComponents, y: RevenueComponents): RevenueComponents {
  return {
    billed: round2(x.billed + y.billed),
    attributed: round2(x.attributed + y.attributed),
    unattributed: round2(x.unattributed + y.unattributed),
  };
}

export function sumRevenue(items: readonly RevenueComponents[]): RevenueComponents {
  return items.reduce(addRevenue, EMPTY_REVENUE);
}

/**
 * Which denominator a labor ratio used. Always reported next to the ratio —
 * "28.7%" means nothing without it.
 */
export type LaborBasis = "attributed" | "billed";

export type LaborRatio = {
  /** Percent, one decimal. `null` when the denominator is 0 — never 0%. */
  pct: number | null;
  basis: LaborBasis;
  /** The exact numerator and denominator used, so a UI can show its inputs. */
  numerator: number;
  denominator: number;
};

/**
 * Labor cost as a percent of revenue.
 *
 * Defaults to the `attributed` basis: pay ÷ the revenue that actually had pay
 * behind it. That is the apples-to-apples number and the one worth acting on.
 * `billed` is available for the headline business figure, but a caller asking
 * for it should also surface `unattributedPct` — otherwise the number quietly
 * flatters itself by exactly the share of revenue that had no labor recorded.
 */
export function laborRatio(
  pay: PayComponents,
  revenue: RevenueComponents,
  basis: LaborBasis = "attributed",
): LaborRatio {
  const numerator = totalPay(pay);
  const denominator = basis === "billed" ? revenue.billed : revenue.attributed;
  const pct = denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
  return { pct, basis, numerator, denominator };
}

/** Share of revenue with no payroll behind it. 0 when there's no revenue. */
export function unattributedPct(revenue: RevenueComponents): number {
  if (revenue.billed <= 0) return 0;
  return Math.round((revenue.unattributed / revenue.billed) * 1000) / 10;
}

/**
 * Above this share of unattributed revenue, a labor ratio on the `billed`
 * basis is misleading enough that the UI must disclose it rather than print a
 * bare percentage.
 */
export const MATERIAL_UNATTRIBUTED_PCT = 5;

export function isUnattributedMaterial(revenue: RevenueComponents): boolean {
  return unattributedPct(revenue) >= MATERIAL_UNATTRIBUTED_PCT;
}

/**
 * Fraction of weeks in a window that must carry prior-year revenue before a
 * year-over-year overlay means anything.
 *
 * Phes tripped the old `some(prior > 0)` test on a couple of stray backdated
 * rows — one week showed $220 of "last year" revenue against $15,038 this
 * year, which drew a full dashed baseline pinned at ~$0 and read as 68× growth
 * where the truth was "we weren't on the system yet".
 */
export const MIN_PRIOR_YEAR_COVERAGE = 0.5;

export function hasMeaningfulPriorYear(
  weeks: readonly { prior_revenue: number }[],
): boolean {
  if (weeks.length === 0) return false;
  const covered = weeks.filter(w => (w.prior_revenue || 0) > 0).length;
  return covered / weeks.length >= MIN_PRIOR_YEAR_COVERAGE;
}
