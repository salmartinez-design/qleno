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
 *   allowed_hours pay = max(allowedShare, techHours) × hourlyRate
 *                 allowedShare = allowedHours × (techHours / totalTechHours).
 *                 Single tech → max(allowedHours, techHours) × rate, i.e. the
 *                 budget protects the tech on a fast job but pays actual when
 *                 they run over (MC: Alma 8.18 actual > 8 allowed → 8.18).
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

export type PayType = "fee_split" | "allowed_hours" | "hourly";

export const PAY_TYPES: readonly PayType[] = ["fee_split", "allowed_hours", "hourly"];

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
}

export interface TechPayRow {
  user_id: number;
  payType: PayType;
  amount: number;
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
 * Compute one tech's pay from their pay type. Pure — all inputs resolved
 * by the caller. Returns the dollar amount plus the effective rate/hours
 * used (so the UI can render MC-style "Fee Split: 16%" or "3 hrs × $20").
 */
export function computeTechPay(ctx: JobPayContext, tech: TechPayInput): TechPayRow {
  const total = ctx.totalTechHours > 0 ? ctx.totalTechHours : tech.techHours;
  const share = total > 0 ? tech.techHours / total : 1;

  if (tech.payType === "hourly") {
    const amount = round2(tech.techHours * tech.hourlyRate);
    return { user_id: tech.user_id, payType: "hourly", amount, effectivePct: 0, effectiveHours: round2(tech.techHours) };
  }

  if (tech.payType === "allowed_hours") {
    const allowedShare = ctx.allowedHours * share;
    const payHours = Math.max(allowedShare, tech.techHours);
    const amount = round2(payHours * tech.hourlyRate);
    return { user_id: tech.user_id, payType: "allowed_hours", amount, effectivePct: 0, effectiveHours: round2(payHours) };
  }

  // fee_split — gross base × scope% × hour-weighted share.
  // MC rounds the effective % to 2 decimals (e.g. 17.53%) and multiplies
  // that, so we round the rate to 4 dp BEFORE applying it to match the
  // displayed paycheck to the penny.
  const effectivePct = Math.round(tech.scopePct * share * 10000) / 10000;
  const amount = round2(ctx.baseFee * effectivePct);
  return { user_id: tech.user_id, payType: "fee_split", amount, effectivePct, effectiveHours: round2(tech.techHours) };
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
