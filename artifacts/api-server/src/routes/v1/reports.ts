import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireApiKey } from "../../lib/api-auth.js";
import { computePeriodPayLines } from "../../lib/period-pay.js";
import { parseDateParam, countFor, fail, companyOf, money } from "./_shared.js";

// [ai-access 2026-08-15] Reporting reads for Qleno Connect.
//
// Revenue counts a job at the price the office billed — billed_amount when it
// exists, else base_fee — and never counts a cancelled job. Cancelled work has a
// price on the row but produced no money, so including it would overstate every
// figure an assistant quotes. Labor comes from the paycheck engine, not a
// percentage: see the note at the top of payroll.ts.
const router = Router();

/** The revenue expression, defined once. */
const REVENUE = sql`COALESCE(j.billed_amount, j.base_fee, 0)`;

function window(req: any, res: any, maxDays = 400): { from: string; to: string } | null {
  const from = parseDateParam(req.query.from);
  const to = parseDateParam(req.query.to);
  if (!from || !to) { fail(res, 400, "invalid_parameter", "from and to are required, as YYYY-MM-DD"); return null; }
  if (from > to) { fail(res, 400, "invalid_parameter", "from is after to"); return null; }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > maxDays) { fail(res, 400, "invalid_parameter", `The window cannot exceed ${maxDays} days`); return null; }
  return { from, to };
}

/** GET /api/v1/reports/revenue?from&to&group_by=day|week|month */
router.get("/reports/revenue", requireApiKey("rest", "reports:read"), async (req, res) => {
  const companyId = companyOf(req);
  const w = window(req, res);
  if (!w) return;

  const groupBy = typeof req.query.group_by === "string" ? req.query.group_by : "day";
  if (!["day", "week", "month"].includes(groupBy)) {
    fail(res, 400, "invalid_parameter", "group_by must be day, week, or month", { valid: ["day", "week", "month"] });
    return;
  }
  // date_trunc's unit cannot be a bound parameter, so it is selected from a
  // fixed map after validation — never interpolated from the request.
  const unit = ({ day: sql`'day'`, week: sql`'week'`, month: sql`'month'` } as const)[groupBy as "day" | "week" | "month"];

  const rows = await db.execute(sql`
    SELECT
      to_char(date_trunc(${unit}, j.scheduled_date), 'YYYY-MM-DD') AS period,
      COUNT(*)::int                                                 AS job_count,
      SUM(${REVENUE})                                               AS revenue,
      COUNT(*) FILTER (WHERE j.account_id IS NOT NULL)::int          AS commercial_jobs,
      SUM(${REVENUE}) FILTER (WHERE j.account_id IS NOT NULL)        AS commercial_revenue
    FROM jobs j
    WHERE j.company_id = ${companyId}
      AND j.scheduled_date BETWEEN ${w.from}::date AND ${w.to}::date
      AND j.status <> 'cancelled'
    GROUP BY 1
    ORDER BY 1
  `);

  const periods = (rows.rows as any[]).map((r) => ({
    period: String(r.period),
    job_count: Number(r.job_count),
    revenue: money(r.revenue) ?? 0,
    commercial_jobs: Number(r.commercial_jobs),
    commercial_revenue: money(r.commercial_revenue) ?? 0,
    residential_revenue: Number(((money(r.revenue) ?? 0) - (money(r.commercial_revenue) ?? 0)).toFixed(2)),
  }));

  countFor(res, periods.length);
  res.json({
    from: w.from,
    to: w.to,
    group_by: groupBy,
    totals: {
      job_count: periods.reduce((s, p) => s + p.job_count, 0),
      revenue: Number(periods.reduce((s, p) => s + p.revenue, 0).toFixed(2)),
    },
    // Stated rather than assumed, because "revenue" means different things in
    // different systems and an assistant cannot ask which one this is.
    basis: "Scheduled date, cancelled jobs excluded, billed_amount where set otherwise base_fee.",
    periods,
  });
});

/** GET /api/v1/reports/kpis?from&to — the numbers the dispatch strip shows. */
router.get("/reports/kpis", requireApiKey("rest", "reports:read"), async (req, res) => {
  const companyId = companyOf(req);
  const w = window(req, res);
  if (!w) return;

  const rows = await db.execute(sql`
    SELECT
      COUNT(*)::int                                                        AS total_jobs,
      COUNT(*) FILTER (WHERE j.status = 'complete')::int                   AS completed,
      COUNT(*) FILTER (WHERE j.status = 'cancelled')::int                  AS cancelled,
      COUNT(*) FILTER (WHERE j.status <> 'cancelled'
                         AND j.assigned_user_id IS NULL
                         AND NOT EXISTS (SELECT 1 FROM job_technicians jt
                                         WHERE jt.job_id = j.id))::int      AS unassigned,
      SUM(${REVENUE}) FILTER (WHERE j.status <> 'cancelled')               AS revenue,
      COUNT(DISTINCT j.client_id) FILTER (WHERE j.status <> 'cancelled')::int AS clients_served
    FROM jobs j
    WHERE j.company_id = ${companyId}
      AND j.scheduled_date BETWEEN ${w.from}::date AND ${w.to}::date
  `);
  const k = (rows.rows as any[])[0] ?? {};

  // Labor comes from the engine, so labor % ties to the actual paychecks rather
  // than to an assumed 35%. Commercial jobs pay hourly and would break any flat
  // percentage applied across the mix.
  const { lines } = await computePeriodPayLines(companyId, w.from, w.to);
  const labor = Number(lines.reduce((s, l) => s + l.amount, 0).toFixed(2));

  const revenue = money(k.revenue) ?? 0;
  const totalJobs = Number(k.total_jobs ?? 0);
  const nonCancelled = totalJobs - Number(k.cancelled ?? 0);

  countFor(res, 1);
  res.json({
    from: w.from,
    to: w.to,
    total_jobs: totalJobs,
    completed: Number(k.completed ?? 0),
    cancelled: Number(k.cancelled ?? 0),
    unassigned: Number(k.unassigned ?? 0),
    clients_served: Number(k.clients_served ?? 0),
    revenue,
    average_ticket: nonCancelled > 0 ? Number((revenue / nonCancelled).toFixed(2)) : null,
    labor_cost: labor,
    // Null rather than 0 when there is no revenue: a labor percentage of a zero
    // denominator is undefined, and reporting 0% would read as "no labor cost".
    labor_pct: revenue > 0 ? Number(((labor / revenue) * 100).toFixed(1)) : null,
    // No cancellation RATE is published, deliberately. `cancelled` counts rows
    // whose status is 'cancelled', and most of those are not a customer
    // cancelling a visit: when a recurring client ends service, the occurrences
    // the engine already generated are tombstoned as 'cancelled' out to a year
    // ahead. On real Phes data that makes the naive rate 48% for Aug 2026 and
    // 52% for a month that has not happened yet. cancellation_log could tell the
    // two apart via cancel_action, but it covers 39 of those 150 rows, so the
    // honest split cannot be computed. Publishing the number anyway would put
    // "you cancel half your jobs" in an assistant's answer. The raw count stays,
    // labelled; the interpretation is not v1's to invent.
    cancelled_note: "Counts jobs with status 'cancelled', which includes future occurrences voided when a recurring client ended service. Not a customer cancellation rate.",
    labor_basis: "Commission from the paycheck engine. Excludes mileage reimbursement, which is not wages.",
  });
});

/**
 * GET /api/v1/reports/efficiency?from&to&tech_id
 *
 * Efficiency = allowed hours ÷ actual clocked hours, over 100% meaning the job
 * came in under budget. This is the ONLY thing called efficiency anywhere in
 * Qleno; a day-level ratio is called Utilization and is a different endpoint's
 * problem. Jobs with no clock data are excluded from the ratio and reported
 * separately, because dividing by zero hours would either crash or silently
 * inflate the number.
 */
router.get("/reports/efficiency", requireApiKey("rest", "reports:read"), async (req, res) => {
  const companyId = companyOf(req);
  const w = window(req, res);
  if (!w) return;

  const techId = req.query.tech_id === undefined ? null : Number(req.query.tech_id);
  if (techId !== null && !Number.isFinite(techId)) { fail(res, 400, "invalid_parameter", "tech_id must be a number"); return; }

  const rows = await db.execute(sql`
    SELECT
      u.id, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS name,
      COUNT(DISTINCT j.id)::int AS job_count,
      SUM(j.allowed_hours)      AS allowed_hours,
      SUM(EXTRACT(EPOCH FROM (t.clock_out_at - t.clock_in_at)) / 3600.0) AS clocked_hours,
      COUNT(DISTINCT j.id) FILTER (WHERE t.clock_out_at IS NULL)::int    AS jobs_without_clock
    FROM jobs j
    JOIN job_technicians jt ON jt.job_id = j.id
    JOIN users u ON u.id = jt.user_id
    LEFT JOIN timeclock t
      ON t.job_id = j.id AND t.user_id = u.id AND t.clock_out_at IS NOT NULL
    WHERE j.company_id = ${companyId}
      AND j.scheduled_date BETWEEN ${w.from}::date AND ${w.to}::date
      AND j.status = 'complete'
      ${techId !== null ? sql`AND u.id = ${techId}` : sql``}
    GROUP BY u.id, name
    ORDER BY name
  `);

  const data = (rows.rows as any[]).map((r) => {
    const allowed = money(r.allowed_hours) ?? 0;
    const clocked = money(r.clocked_hours) ?? 0;
    return {
      user_id: Number(r.id),
      name: String(r.name),
      job_count: Number(r.job_count),
      allowed_hours: Number(allowed.toFixed(2)),
      clocked_hours: Number(clocked.toFixed(2)),
      efficiency_pct: clocked > 0 ? Number(((allowed / clocked) * 100).toFixed(1)) : null,
      jobs_without_clock: Number(r.jobs_without_clock ?? 0),
    };
  });

  countFor(res, data.length);
  res.json({
    from: w.from,
    to: w.to,
    definition: "Allowed hours divided by actual clocked hours. Above 100% means under budget.",
    data,
  });
});

export default router;
