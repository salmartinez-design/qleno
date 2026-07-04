// ── Shared period pay engine bridge ─────────────────────────────────────────
// ONE place that turns (company, date range) into per-tech, per-job pay lines
// using the SAME pay-type engine (computePerTechPayRowsDetailed) that cuts the
// paychecks in routes/payroll.ts /detail. Company REPORTING (routes/reports.ts)
// calls this so the reporting screen can never diverge from the paycheck again.
//
// Why this exists: reports.ts used to hand-roll pay with a per-EMPLOYEE pay_type
// CASE (hourly / per_job / fee_split) that had NO allowed_hours branch and only
// credited the primary tech. Commercial/PPM jobs (paid allowed_hours × rate) and
// helper splits scored $0 or wrong. This helper feeds the real engine — per-JOB
// per-TECH pay type from job_technicians, clocked-hour splits, final_pay + paid-
// hours overrides — identical to /detail. See CLAUDE.md "Commission engine
// routing": never inline × 0.35 / × 20 again — delegate to the engine.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  computePerTechPayRowsDetailed,
  type JobTechRow,
  type PerTechPayDetailRow,
} from "./commission-paytype.js";
import { parseResRatesRow } from "./commission-rates.js";

const intList = (a: number[]) => a.map(Number).filter(Number.isFinite).join(",");

/** One completed job in the pay window, with the fields reporting needs to
 * roll up allowed/actual hours alongside the engine's pay lines. */
export interface PeriodPayJob {
  id: number;
  allowed_hours: string | number | null;
  actual_hours: string | number | null;
  branch_id: number | null;
}

export interface PeriodPayResult {
  /** Per-tech, per-job pay lines — sum `amount` by `user_id` for earned pay. */
  lines: PerTechPayDetailRow[];
  /** The completed jobs the lines were computed from (for count/hours rollups). */
  jobs: PeriodPayJob[];
}

/**
 * Per-tech, per-job pay for one company over [from, to] (YYYY-MM-DD, inclusive),
 * computed by the paycheck engine. Sum `amount` by `user_id` for a tech's earned
 * pay; filter by `branch_id` for a per-branch rollup. Only completed jobs count;
 * only PUNCHED clocks split pay (matches /detail exactly).
 */
export async function computePeriodPayLines(
  companyId: number,
  from: string,
  to: string,
): Promise<PeriodPayResult> {
  // Company comp settings — resilient SELECT (tiered columns may be absent).
  let compSettings: any = {
    res_tech_pay_pct: 0.35, deep_clean_pay_pct: 0.32, move_in_out_pay_pct: 0.32,
    commercial_hourly_rate: 20.0, commercial_comp_mode: "allowed_hours",
  };
  try {
    const r = await db.execute(sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
    if (r.rows[0]) compSettings = r.rows[0];
  } catch {
    try {
      const r = await db.execute(sql`SELECT res_tech_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
      if (r.rows[0]) compSettings = { ...compSettings, ...(r.rows[0] as any) };
    } catch {
      try {
        const r = await db.execute(sql`SELECT res_tech_pay_pct FROM companies WHERE id = ${companyId} LIMIT 1`);
        if (r.rows[0]) compSettings = { ...compSettings, res_tech_pay_pct: (r.rows[0] as any).res_tech_pay_pct };
      } catch { /* keep defaults */ }
    }
  }
  const resRates = parseResRatesRow(compSettings);
  const commercialHourlyRate = parseFloat(String(compSettings.commercial_hourly_rate ?? 20));
  const commercialCompMode = String(compSettings.commercial_comp_mode ?? "allowed_hours") === "actual_hours" ? "actual_hours" : "allowed_hours";

  // Completed jobs in range (client_type via the clients join for commercial
  // routing; account_name not needed here).
  const jobsRes = await db.execute(sql`
    SELECT j.id, j.scheduled_date, j.service_type, j.base_fee, j.billed_amount,
           j.allowed_hours, j.actual_hours, j.assigned_user_id, j.account_id, j.branch_id,
           c.client_type
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = ${companyId} AND j.status = 'complete'
       AND j.scheduled_date BETWEEN ${from} AND ${to}
     ORDER BY j.scheduled_date`);
  const jobs = (jobsRes.rows as any[]).map(j => ({
    id: Number(j.id), assigned_user_id: j.assigned_user_id ?? null,
    account_id: j.account_id ?? null, client_type: j.client_type ?? null,
    service_type: j.service_type, base_fee: j.base_fee, billed_amount: j.billed_amount,
    allowed_hours: j.allowed_hours, actual_hours: j.actual_hours,
    branch_id: j.branch_id ?? null, scheduled_date: String(j.scheduled_date),
  }));
  const inScopeJobIds = jobs.map(j => j.id);
  const jobsOut: PeriodPayJob[] = jobs.map(j => ({ id: j.id, allowed_hours: j.allowed_hours, actual_hours: j.actual_hours, branch_id: j.branch_id }));
  if (!inScopeJobIds.length) return { lines: [], jobs: jobsOut };
  const idArr = intList(inScopeJobIds);

  // Per-tech pay-type rows (job_technicians).
  let jobTechs: JobTechRow[] = [];
  try {
    const tr = await db.execute(sql`
      SELECT job_id, user_id, is_primary, pay_type, hourly_rate, commission_pct,
             pay_deduction_pct, pay_deduction_flat
        FROM job_technicians
       WHERE company_id = ${companyId} AND job_id = ANY(ARRAY[${sql.raw(idArr)}]::int[])`);
    jobTechs = (tr.rows as any[]).map(r => ({
      job_id: Number(r.job_id), user_id: Number(r.user_id), is_primary: r.is_primary === true,
      pay_type: r.pay_type ?? null, hourly_rate: r.hourly_rate ?? null, commission_pct: r.commission_pct ?? null,
      pay_deduction_pct: r.pay_deduction_pct ?? null, pay_deduction_flat: r.pay_deduction_flat ?? null,
    }));
  } catch { /* pay-type columns absent — engine falls back to job defaults */ }

  // Per-(tech, job) clocked hours — PUNCHED only, matching the paycheck path.
  const techHoursByKey = new Map<string, number>();
  try {
    const cr = await db.execute(sql`
      SELECT user_id, job_id, ROUND(SUM(EXTRACT(EPOCH FROM (clock_out_at - clock_in_at)) / 3600.0)::numeric, 2) AS hrs
        FROM timeclock
       WHERE company_id = ${companyId} AND job_id = ANY(ARRAY[${sql.raw(idArr)}]::int[])
         AND clock_out_at IS NOT NULL AND source = 'punched'
       GROUP BY user_id, job_id`);
    for (const r of cr.rows as any[]) {
      const h = parseFloat(String(r.hrs || 0));
      if (h > 0) techHoursByKey.set(`${Number(r.job_id)}:${Number(r.user_id)}`, h);
    }
  } catch { /* timeclock query failed — no clocked split */ }

  // Per-service fee-split % (service_types.commission_pct); NULL → company tier.
  const serviceTypePctBySlug = new Map<string, number>();
  try {
    const svc = await db.execute(sql`SELECT slug, commission_pct FROM service_types WHERE company_id = ${companyId} AND commission_pct IS NOT NULL`);
    for (const r of svc.rows as any[]) {
      const pct = parseFloat(String(r.commission_pct));
      if (Number.isFinite(pct)) serviceTypePctBySlug.set(String(r.slug).toLowerCase(), pct);
    }
  } catch { /* absent — fall back to tiers */ }

  // Per-job final_pay DOLLAR overrides + paid_hours HOURS overrides.
  const finalPayOverride = new Map<string, number>();
  try {
    const fp = await db.execute(sql`SELECT user_id, job_id, final_pay FROM job_technicians WHERE job_id = ANY(ARRAY[${sql.raw(idArr)}]::int[]) AND final_pay IS NOT NULL`);
    for (const r of fp.rows as any[]) if (r.final_pay != null) finalPayOverride.set(`${r.user_id}:${r.job_id}`, parseFloat(String(r.final_pay)));
  } catch { /* none */ }
  const paidHoursOverride = new Map<string, number>();
  try {
    const po = await db.execute(sql`SELECT user_id, job_id, paid_hours FROM payroll_hours_overrides WHERE company_id = ${companyId} AND job_id = ANY(ARRAY[${sql.raw(idArr)}]::int[])`);
    for (const r of po.rows as any[]) if (r.paid_hours != null) paidHoursOverride.set(`${r.user_id}:${r.job_id}`, parseFloat(String(r.paid_hours)));
  } catch { /* table absent pre-migration — none */ }

  const lines = computePerTechPayRowsDetailed({
    jobs, jobTechs, techHoursByKey, serviceTypePctBySlug, resRates,
    commercial: { commercial_hourly_rate: commercialHourlyRate, commercial_comp_mode: commercialCompMode },
    overrides: finalPayOverride, paidHoursOverride,
  });
  return { lines, jobs: jobsOut };
}
