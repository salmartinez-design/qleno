/**
 * P0 payroll engine — per-tech-clocked attribution + per-employee pay type.
 *
 * Pure, DB-free so it is unit-/harness-testable and so /payroll/detail and any
 * future period-lock flow share ONE source of truth for how a tech is paid.
 *
 * Model (confirmed design, 2026-06):
 *  A) ATTRIBUTION is per-tech-CLOCKED, not whole-job-to-primary. Every tech who
 *     personally clocked a job earns from that job (helpers included). A job's
 *     commission is a POOL split among the job's clocked COMMISSION techs,
 *     weighted by their clocked minutes; clocked HOURLY techs are paid hourly
 *     and are excluded from the pool (their minutes don't dilute the split and
 *     they draw no commission).
 *  B) PAY TYPE comes from the per-employee 4-cell matrix
 *     (residential_pay_type/_rate, commercial_pay_type/_rate) — the single
 *     source of truth. Job-type routing: account_id (or client_type
 *     'commercial') => commercial cell, else residential cell. The legacy
 *     users.pay_type enum is NOT read here (retired as a pay source).
 *  C) HOURLY pay = paid_hours × rate.
 *       paid_hours = per-job manual override (HOURS, never dollars) when set,
 *                    else the company hours-basis:
 *                      'actual_clocked' | 'allowed_hours' | 'greater_of'
 *                    (company default = 'greater_of').
 *  D) The EXISTING per-job final_pay DOLLAR override (job_technicians.final_pay)
 *     still wins verbatim where present — it is an existing office feature, not
 *     new hardcoding — and is tagged so the writer can audit it.
 *
 * Commission dollar amounts match the legacy /payroll/detail formula so a
 * commission tech working alone (clocked the job, no hourly co-techs) earns
 * exactly what they earned before the attribution change.
 */
import { resolveResidentialPayPct, type CompanyResRates } from "./commission-rates.js";

export type PayType = "commission" | "hourly";
export type HoursBasis = "actual_clocked" | "allowed_hours" | "greater_of";

export interface PayrollJob {
  id: number;
  account_id: number | null;
  client_type?: string | null;
  service_type: string | null;
  base_fee: string | number | null;
  billed_amount: string | number | null;
  allowed_hours: string | number | null;
  actual_hours: string | number | null;
  scheduled_date: string;
  branch_id: number | null;
}

/** Per-employee 4-cell pay matrix (the single source of truth for pay type). */
export interface TechCell {
  residential_pay_type: PayType;
  residential_pay_rate: number; // decimal pct for commission (0.35), $/hr for hourly
  commercial_pay_type: PayType;
  commercial_pay_rate: number;
}

/** One row per (tech, job) the tech personally clocked, hours summed. */
export interface ClockEntry {
  job_id: number;
  user_id: number;
  clocked_hours: number;
}

export interface CompanyPayConfig {
  resRates: CompanyResRates;
  commercial_hourly_rate: number;
  commercial_comp_mode: "allowed_hours" | "actual_hours";
  hours_basis: HoursBasis; // company default paid-hours basis for hourly techs
}

export interface PayLine {
  user_id: number;
  job_id: number;
  scheduled_date: string;
  branch_id: number | null;
  is_commercial: boolean;
  pay_type: PayType;
  basis: "hourly" | "residential_pool" | "commercial_pool" | "hourly_floor" | "manual_override";
  clocked_hours: number;
  paid_hours: number;       // hourly lines only (else 0)
  rate: number | null;      // $/hr for hourly, pct for commission
  pool_total: number | null;// the job pool (commission lines only)
  pool_share: number | null;// this tech's share fraction (commission lines only)
  hours_overridden: boolean;
  amount: number;
  pay_basis_label: string;
}

function num(v: string | number | null | undefined, fb = 0): number {
  if (v === null || v === undefined) return fb;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fb;
}
function round2(n: number): number { return Math.round(n * 100) / 100; }
const key = (u: number, j: number) => `${u}:${j}`;

/** paid_hours for an hourly line given the company basis. */
export function basisHours(basis: HoursBasis, actualClocked: number, allowedHours: number): number {
  switch (basis) {
    case "actual_clocked": return actualClocked;
    case "allowed_hours": return allowedHours;
    case "greater_of":
    default: return Math.max(actualClocked, allowedHours);
  }
}

function jobIsCommercial(j: PayrollJob): boolean {
  return j.account_id != null || j.client_type === "commercial";
}

/** The job-level pool a commission tech draws a weighted share of. */
function jobPool(j: PayrollJob, cfg: CompanyPayConfig): { total: number; basisLabel: string; isCommercial: boolean } {
  const isCommercial = jobIsCommercial(j);
  if (isCommercial) {
    const allowed = num(j.allowed_hours);
    const actual = num(j.actual_hours);
    const hrs = cfg.commercial_comp_mode === "actual_hours" && actual > 0 ? actual : allowed;
    return { total: round2(cfg.commercial_hourly_rate * hrs), basisLabel: `$${cfg.commercial_hourly_rate.toFixed(0)}/hr × ${hrs.toFixed(1)}h pool`, isCommercial };
  }
  const jobTotal = num(j.billed_amount) || num(j.base_fee);
  const pct = resolveResidentialPayPct(j.service_type, cfg.resRates);
  return { total: round2(jobTotal * pct), basisLabel: `${Math.round(pct * 100)}% of $${Math.round(jobTotal)} pool`, isCommercial };
}

/**
 * Compute every (tech, job) pay line under per-tech-clocked attribution.
 * Returns one line per clocked (tech, job). Grand totals are the caller's job.
 */
export function computePayLines(input: {
  jobs: ReadonlyArray<PayrollJob>;
  clocks: ReadonlyArray<ClockEntry>;
  cellByUser: ReadonlyMap<number, TechCell>;
  config: CompanyPayConfig;
  paidHoursOverride?: ReadonlyMap<string, number>; // "user:job" -> hours
  finalPayOverride?: ReadonlyMap<string, number>;  // "user:job" -> dollars (existing feature)
}): PayLine[] {
  const { jobs, clocks, cellByUser, config } = input;
  const paidOv = input.paidHoursOverride ?? new Map<string, number>();
  const finalOv = input.finalPayOverride ?? new Map<string, number>();
  const jobById = new Map(jobs.map(j => [j.id, j]));

  // clocks grouped by job
  const clocksByJob = new Map<number, ClockEntry[]>();
  for (const c of clocks) {
    if (!jobById.has(c.job_id)) continue; // only jobs in scope (complete, in window)
    if (!clocksByJob.has(c.job_id)) clocksByJob.set(c.job_id, []);
    clocksByJob.get(c.job_id)!.push(c);
  }

  const cellFor = (uid: number): TechCell => cellByUser.get(uid) ?? {
    // sane default if a tech has no matrix row: residential commission @ pool default, commercial hourly
    residential_pay_type: "commission", residential_pay_rate: config.resRates.res_tech_pay_pct,
    commercial_pay_type: "hourly", commercial_pay_rate: config.commercial_hourly_rate,
  };
  const payTypeFor = (cell: TechCell, isComm: boolean): PayType => isComm ? cell.commercial_pay_type : cell.residential_pay_type;
  const rateFor = (cell: TechCell, isComm: boolean): number => isComm ? cell.commercial_pay_rate : cell.residential_pay_rate;

  const lines: PayLine[] = [];
  for (const [jobId, jobClocks] of clocksByJob) {
    const job = jobById.get(jobId)!;
    const isComm = jobIsCommercial(job);
    const pool = jobPool(job, config);
    // [MC-parity] universal hourly/floor rate ($20). Enhancement B: the
    // commission pool is split across ALL clocked techs by ACTUAL clocked hours
    // (hourly techs occupy the denominator and take hourly — their pool share is
    // forgone, matching MaidCentral on mixed crews).
    const floorRate = config.commercial_hourly_rate;
    const totalAllHours = jobClocks.reduce((s, c) => s + c.clocked_hours, 0);

    for (const c of jobClocks) {
      const cell = cellFor(c.user_id);
      const pt = payTypeFor(cell, isComm);
      const rate = rateFor(cell, isComm);
      const allowed = num(job.allowed_hours);
      const k = key(c.user_id, c.job_id);

      // (D) existing dollar override wins verbatim
      if (finalOv.has(k)) {
        lines.push({
          user_id: c.user_id, job_id: jobId, scheduled_date: job.scheduled_date, branch_id: job.branch_id,
          is_commercial: isComm, pay_type: pt, basis: "manual_override",
          clocked_hours: round2(c.clocked_hours), paid_hours: 0, rate: null,
          pool_total: null, pool_share: null, hours_overridden: false,
          amount: round2(finalOv.get(k)!), pay_basis_label: "Manual $ override",
        });
        continue;
      }

      // Per-job HOURS override pays this line HOURLY at the company rate,
      // regardless of the job's commission routing. It's an hours lever (not a
      // dollar one): the office marks "this job was paid $/hr × N hours" — which
      // is how MaidCentral hand-assigns certain jobs to hourly (incl. jobs a
      // commission tech would otherwise pool). Commission-pool jobs carry no
      // override and flow through the pool logic below.
      if (paidOv.has(k)) {
        const oh = paidOv.get(k)!;
        const ovRate = config.commercial_hourly_rate;
        lines.push({
          user_id: c.user_id, job_id: jobId, scheduled_date: job.scheduled_date, branch_id: job.branch_id,
          is_commercial: isComm, pay_type: "hourly", basis: "hourly",
          clocked_hours: round2(c.clocked_hours), paid_hours: round2(oh), rate: ovRate,
          pool_total: null, pool_share: null, hours_overridden: true,
          amount: round2(oh * ovRate),
          pay_basis_label: `$${ovRate.toFixed(2)}/hr × ${round2(oh)}h (override)`,
        });
        continue;
      }

      if (pt === "hourly") {
        const hasOv = paidOv.has(k);
        const paidHours = hasOv ? paidOv.get(k)! : basisHours(config.hours_basis, c.clocked_hours, allowed);
        lines.push({
          user_id: c.user_id, job_id: jobId, scheduled_date: job.scheduled_date, branch_id: job.branch_id,
          is_commercial: isComm, pay_type: "hourly", basis: "hourly",
          clocked_hours: round2(c.clocked_hours), paid_hours: round2(paidHours), rate,
          pool_total: null, pool_share: null, hours_overridden: hasOv,
          amount: round2(paidHours * rate),
          pay_basis_label: `$${rate.toFixed(2)}/hr × ${round2(paidHours)}h${hasOv ? " (override)" : ` (${config.hours_basis})`}`,
        });
      } else {
        // residential commission tech: GREATER-OF(pool share, hourly floor).
        // Enhancement A: floor = clocked actual hrs × $20 (long low-fee job still
        // clears minimum wage). Enhancement B: pool share weighted by clocked
        // hours across ALL techs on the job.
        const shareFrac = totalAllHours > 0 ? c.clocked_hours / totalAllHours : 1;
        const shareAmt = round2(pool.total * shareFrac);
        const floorAmt = round2(c.clocked_hours * floorRate);
        const useFloor = floorAmt > shareAmt;
        lines.push({
          user_id: c.user_id, job_id: jobId, scheduled_date: job.scheduled_date, branch_id: job.branch_id,
          is_commercial: isComm, pay_type: "commission",
          basis: useFloor ? "hourly_floor" : (isComm ? "commercial_pool" : "residential_pool"),
          clocked_hours: round2(c.clocked_hours), paid_hours: useFloor ? round2(c.clocked_hours) : 0,
          rate: useFloor ? floorRate : rate,
          pool_total: pool.total, pool_share: round2(shareFrac),
          hours_overridden: false,
          amount: Math.max(shareAmt, floorAmt),
          pay_basis_label: useFloor
            ? `$${floorRate.toFixed(2)}/hr × ${round2(c.clocked_hours)}h (floor)`
            : `${Math.round(shareFrac * 100)}% of ${pool.basisLabel}`,
        });
      }
    }
  }
  return lines;
}
