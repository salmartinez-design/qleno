/**
 * Per-tech commission by PAY TYPE — the MaidCentral-parity model.
 *
 * The June 1 MC↔Qleno audit (tests/june1-mc-audit.ts) showed Qleno's
 * single-basis-per-job model (commercial_hourly vs residential_pool) can't
 * reproduce MaidCentral, where pay is set PER TIMESHEET and two techs on the
 * SAME job can be paid differently (e.g. Cusimano: Norma=Fee Split,
 * Jose=Hourly). This module is the parity engine: it computes each tech's
 * pay from THEIR pay type, so a job's payout is the sum of independent
 * per-tech computations — not one pool split.
 *
 * Three pay types (verbatim from MC's timesheet "Pay type" column):
 *
 *   fee_split     pay = baseFee × scopePct × (techHours / totalTechHours)
 *                 The tech's hour-weighted share of the job's commission.
 *                 baseFee is the GROSS service base (pre customer credits /
 *                 breakage) — a goodwill/breakage credit to the client does
 *                 NOT dock the cleaner (audit decision 2026-06-05).
 *
 *   allowed_hours pay = allowedShare × hourlyRate  (HARD CAP at budget)
 *                 allowedShare = allowedHours × (techHours / totalTechHours).
 *                 Single tech → allowedHours × rate. The budget is paid whether
 *                 the tech is faster OR slower — going over does NOT increase
 *                 pay (the efficiency incentive). To pay actual on an overage,
 *                 use Hourly. (Phes policy 2026-06-06 — diverges from MC, which
 *                 paid actual when over.)
 *
 *   hourly        pay = techHours × hourlyRate
 *                 Flat wage on actual clocked time, independent of the job's
 *                 price or budget. Never a default — an explicit override.
 *
 * scopePct resolves PER SERVICE TYPE (configurable), falling back to the
 * company residential tiers. Hundt's "Hourly Deep Clean" pays 35% even
 * though the global deep-clean tier is 32% — the service set carries its
 * own rate (audit decision 2026-06-05).
 *
 * Pure functions only. The route/DB layer resolves the inputs (job_technicians
 * pay_type/hourly_rate/commission_pct, service-type config, company defaults)
 * and persists the result.
 */

import {
  computeCommissionRows,
  type CommissionInputJob,
  type CommissionRow,
} from "./commission-compute.js";
import { resolveResidentialPayPct, type CompanyResRates } from "./commission-rates.js";

export type PayType = "fee_split" | "allowed_hours" | "hourly";

export const PAY_TYPES: readonly PayType[] = ["fee_split", "allowed_hours", "hourly"];

// A job is commercial when it's tied to an account OR its service type reads
// commercial. Match by KEYWORD (substring) so every variant counts —
// "ppm_common_areas", "office_cleaning", "commercial_cleaning",
// "ppm_turnover", "post_construction", etc. — not just an exact slug list
// (which #340 under-covered). Residential slugs (standard_clean, deep_clean,
// move_in_out, recurring, carpet) contain none of these, so they stay
// residential. Without this, a commercial job with no account link defaults
// to a residential fee split and pays the wrong way (Common Areas $68.25 vs
// the correct Allowed-Hours $60).
const COMMERCIAL_KEYWORDS = [
  "commercial", "ppm", "common_area", "office", "janitor", "facility",
  "post_construction", "turnover", "build_out", "buildout",
];
export function isCommercialJob(
  account_id: number | string | null | undefined,
  service_type: string | null | undefined,
  client_type?: string | null | undefined,
): boolean {
  if (account_id != null) return true;
  if ((client_type ?? "").toLowerCase() === "commercial") return true;
  const s = (service_type ?? "").toLowerCase();
  return COMMERCIAL_KEYWORDS.some(k => s.includes(k));
}

export interface JobPayContext {
  /** GROSS service base before customer credits/breakage (jobs.base_fee). */
  baseFee: number;
  /** Job's allowed (budgeted) hours. */
  allowedHours: number;
  /** Sum of every assigned tech's clocked hours (the split denominator). */
  totalTechHours: number;
}

export interface TechPayInput {
  user_id: number;
  /** This tech's clocked hours on the job. */
  techHours: number;
  payType: PayType;
  /** $/hr for allowed_hours + hourly. Ignored for fee_split. */
  hourlyRate: number;
  /** Decimal share (0.32 = 32%) for fee_split. Ignored otherwise. */
  scopePct: number;
  /**
   * Optional breakage/damage deduction the office applies to THIS tech's
   * pay. Default OFF — a customer breakage credit does NOT dock the cleaner
   * (audit decision 2026-06-05). When the office decides the tech shares the
   * cost, they set a percent (0.10 = 10% of computed pay) and/or a flat $.
   * Applied after the pay-type computation; final pay floored at $0.
   */
  deductionPct?: number;
  deductionFlat?: number;
}

export interface TechPayRow {
  user_id: number;
  payType: PayType;
  /** Final pay after any deduction (what actually pays). */
  amount: number;
  /** Pay before the breakage deduction (the earned commission). */
  grossAmount: number;
  /** Dollars removed by the deduction (0 when none). */
  deduction: number;
  /** The effective inputs, for audit/UI display ("Fee Split: 16%"). */
  effectivePct: number; // hour-weighted fee-split %, else 0
  effectiveHours: number; // hours the rate was applied to (allowed/hourly)
}

function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Split a dollar pool into `parts` even shares that sum EXACTLY to the pool.
 * Works in integer cents and hands the leftover cents to the first shares
 * (largest-remainder), so e.g. $56.00 / 3 → [18.67, 18.67, 18.66] (sum 56.00),
 * never 3 × 18.67 = 56.01. Used for the pre-clock even-by-headcount split so a
 * job's per-cleaner commission always reconciles to the job's total.
 */
function splitPoolEvenly(pool: number, parts: number): number[] {
  if (parts <= 0) return [];
  const cents = Math.round(pool * 100);
  const base = Math.trunc(cents / parts);
  let remainder = cents - base * parts; // 0..parts-1, sign follows `cents`
  const step = remainder >= 0 ? 1 : -1;
  remainder = Math.abs(remainder);
  return Array.from({ length: parts }, (_, i) => (base + (i < remainder ? step : 0)) / 100);
}

/**
 * Compute one tech's pay from their pay type. Pure — all inputs resolved
 * by the caller. Returns the dollar amount plus the effective rate/hours
 * used (so the UI can render MC-style "Fee Split: 16%" or "3 hrs × $20").
 */
export function computeTechPay(ctx: JobPayContext, tech: TechPayInput): TechPayRow {
  const total = ctx.totalTechHours > 0 ? ctx.totalTechHours : tech.techHours;
  const share = total > 0 ? tech.techHours / total : 1;

  let grossAmount: number;
  let effectivePct = 0;
  let effectiveHours = round2(tech.techHours);

  if (tech.payType === "hourly") {
    grossAmount = round2(tech.techHours * tech.hourlyRate);
  } else if (tech.payType === "allowed_hours") {
    // HARD CAP at the budget (Phes policy 2026-06-06): a commission job on
    // Allowed Hours pays the allowed hours whether the tech is faster OR
    // slower than the budget. Going over does NOT increase pay — that's the
    // efficiency incentive. To pay actual time on an overage, use the Hourly
    // pay type (or an hourly job). NOTE: this intentionally diverges from
    // MaidCentral, which paid actual when over.
    //
    // [allowed-hours-no-budget 2026-07-01] BUT if the job has NO allowed-hours
    // budget set (allowedHours <= 0 — common on commercial/office jobs that
    // weren't given a budget yet), "budget × rate" is $0 and the tech's row
    // shows a blank "—" — silently unpaid (Maribel: "Jennifer Joy is not
    // populating the pay"). In that case there is no budget to cap against, so
    // fall back to ACTUAL clocked hours × rate (same as Hourly) — time worked
    // is always paid. The office can still set a real budget later to re-engage
    // the efficiency cap.
    const payHours = ctx.allowedHours > 0 ? ctx.allowedHours * share : tech.techHours;
    grossAmount = round2(payHours * tech.hourlyRate);
    effectiveHours = round2(payHours);
  } else {
    // fee_split — gross base × scope% × hour-weighted share.
    // MC rounds the effective % to 2 decimals (e.g. 17.53%) and multiplies
    // that, so we round the rate to 4 dp BEFORE applying it to match the
    // displayed paycheck to the penny.
    effectivePct = Math.round(tech.scopePct * share * 10000) / 10000;
    grossAmount = round2(ctx.baseFee * effectivePct);
  }

  // Optional breakage deduction (default off). Percent applies to the
  // computed pay; flat is dollars. Final pay never goes negative.
  const deduction = round2(grossAmount * num(tech.deductionPct) + num(tech.deductionFlat));
  const amount = Math.max(0, round2(grossAmount - deduction));

  return { user_id: tech.user_id, payType: tech.payType, amount, grossAmount, deduction, effectivePct, effectiveHours };
}

/** Compute every tech's pay for one job. Sum of independent per-tech rows. */
export function computeJobTechPays(ctx: JobPayContext, techs: ReadonlyArray<TechPayInput>): TechPayRow[] {
  return techs.map((t) => computeTechPay(ctx, t));
}

// ── Smart defaults ────────────────────────────────────────────────────────

export interface PayDefaultsConfig {
  /** account_id != null → commercial. */
  isCommercial: boolean;
  /** jobs.service_type slug, for the residential scope tier. */
  serviceType: string | null;
  /** Company commercial $/hr (companies.commercial_hourly_rate). */
  commercialHourlyRate: number;
  /** Resolved fee-split % for this service type (caller resolves the tier). */
  scopePct: number;
}

/**
 * The pay type Qleno picks when the office hasn't set a per-tech override:
 *   commercial  → allowed_hours @ company $/hr
 *   residential → fee_split @ the service-type %
 * Hourly is NEVER a default — it's an explicit office choice per timesheet.
 */
export function defaultPayForJob(cfg: PayDefaultsConfig): {
  payType: PayType;
  hourlyRate: number;
  scopePct: number;
} {
  if (cfg.isCommercial) {
    return { payType: "allowed_hours", hourlyRate: cfg.commercialHourlyRate, scopePct: 0 };
  }
  return { payType: "fee_split", hourlyRate: 0, scopePct: cfg.scopePct };
}

/**
 * Resolve a single tech's effective pay inputs: explicit override on the
 * job_technicians row when present, else the job's smart default. Keeps the
 * "smart default + per-job override" contract in one place.
 */
export function resolveTechPayInput(args: {
  user_id: number;
  techHours: number;
  /** job_technicians.pay_type — null = inherit default. */
  overridePayType: PayType | null;
  /** job_technicians.hourly_rate — null = inherit. */
  overrideHourlyRate: number | null;
  /** job_technicians.commission_pct — null = inherit. */
  overridePct: number | null;
  defaults: { payType: PayType; hourlyRate: number; scopePct: number };
}): TechPayInput {
  const payType = args.overridePayType ?? args.defaults.payType;
  const hourlyRate = args.overrideHourlyRate ?? args.defaults.hourlyRate;
  const scopePct = num(args.overridePct, NaN);
  return {
    user_id: args.user_id,
    techHours: args.techHours,
    payType,
    hourlyRate,
    scopePct: Number.isFinite(scopePct) ? scopePct : args.defaults.scopePct,
  };
}

// ── DB bridge: per-tech commission rows for the period-lock payroll path ────

/** A job_technicians row carrying the optional per-tech pay overrides. */
export interface JobTechRow {
  job_id: number;
  user_id: number;
  is_primary: boolean;
  pay_type: string | null;
  hourly_rate: string | number | null;
  commission_pct: string | number | null;
  pay_deduction_pct: string | number | null;
  pay_deduction_flat: string | number | null;
}

function n(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const x = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(x) ? x : null;
}

function asPayType(v: string | null): PayType | null {
  return v === "fee_split" || v === "allowed_hours" || v === "hourly" ? v : null;
}

/**
 * Turn (completed jobs, their job_technicians rows, per-tech clocked hours)
 * into per-tech commission rows using the pay-type parity engine.
 *
 * SAFETY GUARD — a job with NO per-tech clocked hours falls back to the
 * legacy single-basis computeCommissionRows (primary tech gets the job
 * commission). This guarantees we never zero out a real paycheck just
 * because the clocks aren't entered yet — un-clocked jobs behave exactly
 * as they do today; only clocked jobs get the MC-exact per-tech split.
 *
 * Fee-split runs on the GROSS base (jobs.base_fee, falling back to
 * billed_amount) so a breakage credit doesn't dock the cleaner. scopePct
 * resolves per service type (serviceTypePctBySlug) before the company tier.
 * A per-tech final_pay override (hand-set in the editor) always wins.
 */
export function computePerTechCommissionRows(input: {
  jobs: ReadonlyArray<CommissionInputJob>;
  jobTechs: ReadonlyArray<JobTechRow>;
  /** "job_id:user_id" → clocked hours. */
  techHoursByKey: ReadonlyMap<string, number>;
  /** service_type slug → per-service fee-split % (0.35), if configured. */
  serviceTypePctBySlug: ReadonlyMap<string, number>;
  resRates: CompanyResRates;
  commercial: { commercial_hourly_rate: number; commercial_comp_mode: "allowed_hours" | "actual_hours" };
  /** "user_id:job_id" → final_pay override (dollars). */
  overrides?: ReadonlyMap<string, number>;
}): CommissionRow[] {
  const overrides = input.overrides ?? new Map();
  const techsByJob = new Map<number, JobTechRow[]>();
  for (const t of input.jobTechs) {
    const arr = techsByJob.get(t.job_id) ?? [];
    arr.push(t);
    techsByJob.set(t.job_id, arr);
  }

  const out: CommissionRow[] = [];
  for (const j of input.jobs) {
    const isCommercial = isCommercialJob(j.account_id, j.service_type, j.client_type);
    let techs = techsByJob.get(j.id) ?? [];
    if (techs.length === 0 && j.assigned_user_id != null) {
      techs = [{ job_id: j.id, user_id: j.assigned_user_id, is_primary: true,
        pay_type: null, hourly_rate: null, commission_pct: null, pay_deduction_pct: null, pay_deduction_flat: null }];
    }
    // MaidCentral rounds each timesheet's clocked hours to 2 decimals BEFORE
    // multiplying by the rate (3h10m → 3.17 → ×$20 = $63.40, not 3.1667 →
    // $63.33). Round per-tech hours here so hourly pay, allowed-actual, and the
    // fee-split hour-shares all tie to MC to the penny.
    const hoursOf = (uid: number) => round2(input.techHoursByKey.get(`${j.id}:${uid}`) ?? 0);
    const totalTechHours = techs.reduce((s, t) => s + hoursOf(t.user_id), 0);

    const servicePct = input.serviceTypePctBySlug.get((j.service_type ?? "").toLowerCase());
    const scopePct = servicePct ?? resolveResidentialPayPct(j.service_type, input.resRates);
    const defaults = defaultPayForJob({
      isCommercial,
      serviceType: j.service_type,
      commercialHourlyRate: input.commercial.commercial_hourly_rate,
      scopePct,
    });
    // Commission base = max(base_fee, billed_amount). billed_amount =
    // base_fee + SUM(job mods), so add-ons RAISE it (they're commissionable —
    // MC pays on the add-on-inclusive total) while a customer credit/discount
    // LOWERS billed below base, and max() ignores it so the credit never docks
    // the tech (locked rule). For a plain job base==billed → unchanged, so
    // every job that already matched stays matched.
    // [commission-optin 2026-07-01] Prefer commission_base (base or hrs×rate +
    // only the flagged add-ons/mods) over the billed total, so an add-on or
    // adjustment feeds the fee split only when the office opted it in. NULL →
    // legacy max(base_fee, billed_amount).
    const commissionBase = n(j.commission_base);
    // Residential fee-split uses commission_base as its gross base when set
    // (commission-optin add-ons). Commercial pay does NOT — it is strictly
    // allowed_hours × commercial rate (Phes comp model; Sal 2026-07-04). The old
    // "feed commission_base back as effective allowed-hours" override paid the
    // job's REVENUE: a commercial commission_base is populated with base_fee, so
    // an 8-allowed-hour National Able job (should be 8 × $20 = $160) paid $400
    // (400 ÷ $20 = 20 "hours"). Overpaid commercial ~$1.6k over 3 days. Commercial
    // now always uses the real allowed_hours budget.
    const baseFee = commissionBase ?? Math.max(n(j.base_fee) ?? 0, n(j.billed_amount) ?? 0);
    const allowedHours = n(j.allowed_hours) ?? 0;

    const pushRow = (user_id: number, amount: number) => {
      if (amount === 0) return;
      out.push({
        user_id,
        job_id: j.id,
        amount,
        basis: isCommercial ? "commercial_hourly" : "residential_pool",
        branch_id: j.branch_id,
        scheduled_date: j.scheduled_date,
      });
    };
    // Emit one tech's commission row from the time-weighted pay engine. `ctx`
    // carries the split denominator (totalTechHours) and `techHours` this tech's
    // weight in it; the per-tech pay type, rate/%, deductions and any hand-set
    // final_pay override all apply.
    const emitTech = (t: JobTechRow, ctx: JobPayContext, techHours: number) => {
      const overrideKey = `${t.user_id}:${j.id}`;
      let amount: number;
      if (overrides.has(overrideKey)) {
        amount = Math.round((overrides.get(overrideKey) as number) * 100) / 100;
      } else {
        const payInput = resolveTechPayInput({
          user_id: t.user_id,
          techHours,
          overridePayType: asPayType(t.pay_type),
          overrideHourlyRate: n(t.hourly_rate),
          overridePct: n(t.commission_pct),
          defaults,
        });
        payInput.deductionPct = n(t.pay_deduction_pct) ?? 0;
        payInput.deductionFlat = n(t.pay_deduction_flat) ?? 0;
        amount = computeTechPay(ctx, payInput).amount;
      }
      pushRow(t.user_id, amount);
    };

    // GUARD: no clocked hours yet — can't weight by time.
    if (totalTechHours <= 0) {
      // Single assigned tech → legacy single-basis fallback (byte-identical,
      // no regression: the lone tech gets the whole job commission).
      if (techs.length <= 1) {
        for (const r of computeCommissionRows({ jobs: [j], resRates: input.resRates, commercial: input.commercial, overrides })) {
          out.push(r);
        }
        continue;
      }
      // Two or more cleaners assigned but none clocked → split the job's
      // commission EVENLY by headcount (CLAUDE.md: "pre-clock-in: equal split
      // among assigned techs"). The old fallback paid only the primary, leaving
      // the other cleaners at $0 on the Time Clocks grid — the reported "fee
      // split doesn't match the assigned splits" bug. We split the whole-job
      // commission pool (penny-exact via splitPoolEvenly) so the per-cleaner
      // amounts always reconcile to the job total. Once real punches are entered
      // the proportional-by-minutes path below takes over.
      // Whole-job commission at the job's default basis: residential fee split
      // → base × scope%; commercial allowed-hours → allowed × $/hr.
      const pool = defaults.payType === "allowed_hours"
        ? round2(allowedHours * defaults.hourlyRate)
        : round2(baseFee * defaults.scopePct);
      // Every assigned cleaner holds one equal slot in the split denominator —
      // exactly how their clocked hours will weight it once punches arrive. So:
      //   - a fee-split / allowed-hours cleaner is paid their 1/N slice now;
      //   - an HOURLY cleaner's slot is unpaid until they clock (hourly pays
      //     actual time, and it dilutes the others' shares just as it will
      //     post-clock — so the fee-split cleaner gets 1/N, not the whole pool);
      //   - a hand-set final_pay override is paid verbatim (independent).
      // Penny-exact: the emitted slices sum to the pool minus any hourly/override
      // slots (which pay on their own basis).
      // [trainee-split 2026-07-23] Split the pool by the NON-hourly cleaners only,
      // so an hourly trainee's slot isn't carved out and then left unpaid — the
      // veterans divide the whole pool between them. Mirrors the post-clock
      // fee-split denominator. An override tech is paid verbatim and doesn't
      // consume a pool slot.
      const poolTechs = techs.filter(t =>
        !overrides.has(`${t.user_id}:${j.id}`) &&
        (asPayType(t.pay_type) ?? defaults.payType) !== "hourly");
      const shares = splitPoolEvenly(pool, poolTechs.length || 1);
      let si = 0;
      techs.forEach((t) => {
        const overrideKey = `${t.user_id}:${j.id}`;
        if (overrides.has(overrideKey)) {
          pushRow(t.user_id, Math.round((overrides.get(overrideKey) as number) * 100) / 100);
          return;
        }
        const payType = asPayType(t.pay_type) ?? defaults.payType;
        if (payType === "hourly") return;
        pushRow(t.user_id, shares[si++] ?? 0);
      });
      continue;
    }

    // [trainee-split 2026-07-23] The fee-split POOL divides only among the
    // fee-split cleaners' hours — an hourly cleaner (a trainee paid $X/hr) is NOT
    // in the denominator, so the veterans split the WHOLE commission pool between
    // them and the trainee is paid hourly on top (Sal: "send a trainee ... pay
    // them by the hour ... the 32% ... distributed among the veteran employees").
    // Before, an hourly tech's hours ddiluted the veterans' shares and that slice
    // of the pool simply evaporated — paid to no one. Only fee-split techs get a
    // fee-split denominator; allowed_hours/hourly techs are unchanged (their pay
    // doesn't come from this pool).
    const effPayType = (t: JobTechRow) => asPayType(t.pay_type) ?? defaults.payType;
    const feeSplitHours = techs.reduce(
      (s, t) => s + (effPayType(t) === "fee_split" ? hoursOf(t.user_id) : 0), 0);
    for (const t of techs) {
      const denom = effPayType(t) === "fee_split" ? feeSplitHours : totalTechHours;
      const ctx: JobPayContext = { baseFee, allowedHours, totalTechHours: denom };
      emitTech(t, ctx, hoursOf(t.user_id));
    }
  }
  return out;
}

// ── Rich per-tech rows for the Payroll Detail SCREEN ───────────────────────
/**
 * A display row carrying the SAME pay math as computePerTechCommissionRows
 * (both go through computeTechPay, so the screen and the paycheck never
 * disagree) PLUS the per-line metadata the /payroll/detail UI renders:
 * the pay type, an explain-the-math label, and the hours actually paid.
 */
export interface PerTechPayDetailRow {
  user_id: number;
  job_id: number;
  /** Final pay for this tech on this job (after any deduction / override). */
  amount: number;
  payType: PayType;
  /** "manual_override" when a final_pay dollar override won; else the routing. */
  basis: "manual_override" | "commercial_pool" | "residential_pool";
  isCommercial: boolean;
  /** This tech's actual clocked hours on the job. */
  clockedHours: number;
  /** Hours the wage was paid on — hourly / hours-override lines only, else 0. */
  paidHours: number;
  /** True when a payroll_hours_overrides row drove paidHours. */
  hoursOverridden: boolean;
  /** Hour-weighted fee-split % (e.g. 0.16), else 0. */
  effectivePct: number;
  /** Dollars removed by a breakage/damage deduction (0 when none). */
  deduction: number;
  /** MC-style explain-the-math string for the UI's "Pay basis" column. */
  payBasisLabel: string;
  branch_id: number | null;
  scheduled_date: string;
}

/**
 * Compute rich per-tech pay rows for the Payroll Detail screen. Emits one row
 * per tech who CLOCKED the job (helpers included) — un-clocked jobs produce no
 * line, matching the screen's long-standing "only what was clocked shows"
 * behavior. The dollar amounts are byte-identical to the period-lock paycheck
 * engine because both route through computeTechPay with the same inputs.
 *
 * Honors, in priority order: (1) job_technicians.final_pay dollar override →
 * "Manual $ override"; (2) payroll_hours_overrides → pay this line HOURLY on
 * the override hours (the office's "pay this overage job hourly" lever);
 * (3) the tech's pay type (fee_split / allowed_hours / hourly).
 */
export function computePerTechPayRowsDetailed(input: {
  jobs: ReadonlyArray<CommissionInputJob>;
  jobTechs: ReadonlyArray<JobTechRow>;
  techHoursByKey: ReadonlyMap<string, number>;
  serviceTypePctBySlug: ReadonlyMap<string, number>;
  resRates: CompanyResRates;
  commercial: { commercial_hourly_rate: number; commercial_comp_mode: "allowed_hours" | "actual_hours" };
  /** "user_id:job_id" → final_pay dollar override. */
  overrides?: ReadonlyMap<string, number>;
  /** "user_id:job_id" → paid_hours override (pay this line hourly on these hrs). */
  paidHoursOverride?: ReadonlyMap<string, number>;
}): PerTechPayDetailRow[] {
  const overrides = input.overrides ?? new Map();
  const hoursOv = input.paidHoursOverride ?? new Map();
  const techsByJob = new Map<number, JobTechRow[]>();
  for (const t of input.jobTechs) {
    const arr = techsByJob.get(t.job_id) ?? [];
    arr.push(t);
    techsByJob.set(t.job_id, arr);
  }

  const out: PerTechPayDetailRow[] = [];
  for (const j of input.jobs) {
    const isCommercial = isCommercialJob(j.account_id, j.service_type, j.client_type);
    let techs = techsByJob.get(j.id) ?? [];
    if (techs.length === 0 && j.assigned_user_id != null) {
      techs = [{ job_id: j.id, user_id: j.assigned_user_id, is_primary: true,
        pay_type: null, hourly_rate: null, commission_pct: null, pay_deduction_pct: null, pay_deduction_flat: null }];
    }
    const hoursOf = (uid: number) => round2(input.techHoursByKey.get(`${j.id}:${uid}`) ?? 0);
    const totalTechHours = techs.reduce((s, t) => s + hoursOf(t.user_id), 0);
    if (totalTechHours <= 0) continue; // display: only clocked lines

    const servicePct = input.serviceTypePctBySlug.get((j.service_type ?? "").toLowerCase());
    const scopePct = servicePct ?? resolveResidentialPayPct(j.service_type, input.resRates);
    const defaults = defaultPayForJob({
      isCommercial,
      serviceType: j.service_type,
      commercialHourlyRate: input.commercial.commercial_hourly_rate,
      scopePct,
    });
    // Residential fee-split uses commission_base as its gross base when set
    // (commission-optin add-ons). Commercial pay is strictly allowed_hours ×
    // rate — NOT commission_base (which holds the job's revenue and overpaid
    // commercial to the full billed amount). Mirror of the main path fix
    // (Sal 2026-07-04).
    const commissionBase = n(j.commission_base);
    const baseCtx = {
      baseFee: commissionBase ?? Math.max(n(j.base_fee) ?? 0, n(j.billed_amount) ?? 0),
      allowedHours: n(j.allowed_hours) ?? 0,
    };
    // [trainee-split 2026-07-23] Fee-split denominator excludes hourly (trainee)
    // techs, so the SCREEN matches the paycheck engine (both must agree). See the
    // matching block in computePerTechCommissionRows.
    const effPayType = (t: JobTechRow) => asPayType(t.pay_type) ?? defaults.payType;
    const feeSplitHours = techs.reduce(
      (s, t) => s + (effPayType(t) === "fee_split" ? hoursOf(t.user_id) : 0), 0);
    const ctxFor = (t: JobTechRow): JobPayContext => ({
      ...baseCtx,
      totalTechHours: effPayType(t) === "fee_split" ? feeSplitHours : totalTechHours,
    });

    for (const t of techs) {
      const key = `${t.user_id}:${j.id}`;
      const clockedHours = hoursOf(t.user_id);
      const base = { user_id: t.user_id, job_id: j.id, isCommercial,
        clockedHours, branch_id: j.branch_id, scheduled_date: j.scheduled_date };

      // (1) Manual dollar override always wins.
      if (overrides.has(key)) {
        out.push({ ...base, amount: round2(overrides.get(key) as number), payType: "hourly",
          basis: "manual_override", paidHours: 0, hoursOverridden: false, effectivePct: 0,
          deduction: 0, payBasisLabel: "Manual $ override" });
        continue;
      }

      const resolved = resolveTechPayInput({
        user_id: t.user_id, techHours: clockedHours,
        overridePayType: asPayType(t.pay_type), overrideHourlyRate: n(t.hourly_rate),
        overridePct: n(t.commission_pct), defaults,
      });

      // (2) Paid-hours override → pay this line HOURLY on the override hours.
      if (hoursOv.has(key)) {
        const oh = round2(hoursOv.get(key) as number);
        const rate = resolved.hourlyRate > 0 ? resolved.hourlyRate : input.commercial.commercial_hourly_rate;
        out.push({ ...base, amount: round2(oh * rate), payType: "hourly", basis: isCommercial ? "commercial_pool" : "residential_pool",
          paidHours: oh, hoursOverridden: true, effectivePct: 0, deduction: 0,
          payBasisLabel: `$${rate.toFixed(2)}/hr × ${oh}h (override)` });
        continue;
      }

      // (3) Normal per-tech pay type.
      resolved.deductionPct = n(t.pay_deduction_pct) ?? 0;
      resolved.deductionFlat = n(t.pay_deduction_flat) ?? 0;
      const row = computeTechPay(ctxFor(t), resolved);
      let label: string;
      let paidHours = 0;
      // [payroll-label-trim 2026-07-16] This label feeds ONLY the columnar
      // payroll /detail screen, which already has BILLED, DONE/ALLOWED and PAY
      // columns. The old verbose form ("35.00% of $150.00", "$20/hr × 1.5h
      // (allowed)") re-printed the billed amount and the allowed hours that are
      // already in those columns. Trim to just the pay BASIS + rate — the one
      // datum with no column of its own. (The standalone paycheck label in
      // payroll-compute.ts stays verbose on purpose: a paycheck has no columns,
      // so "35% of $150" is the explanation there.)
      if (resolved.payType === "hourly") {
        paidHours = round2(clockedHours);
        label = `$${resolved.hourlyRate.toFixed(2).replace(/\.00$/, "")}/hr`;
      } else if (resolved.payType === "allowed_hours") {
        label = `$${resolved.hourlyRate.toFixed(2).replace(/\.00$/, "")}/hr allowed`;
      } else {
        label = `Fee split ${(row.effectivePct * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
      }
      out.push({ ...base, amount: row.amount, payType: resolved.payType,
        basis: isCommercial ? "commercial_pool" : "residential_pool",
        paidHours, hoursOverridden: false, effectivePct: row.effectivePct,
        deduction: row.deduction, payBasisLabel: label });
    }
  }
  return out;
}
