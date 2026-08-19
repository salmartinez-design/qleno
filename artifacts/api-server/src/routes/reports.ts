import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable, jobsTable, timeclockTable,
  clientsTable, clientRatingsTable, invoicesTable, additionalPayTable,
  contactTicketsTable,
} from "@workspace/db/schema";
import { eq, and, gte, lte, desc, count, avg, sum, sql, lt, inArray, isNull, ne } from "drizzle-orm";
import { requireAuth, requireRole, isTechnicianRole } from "../lib/auth.js";
import { computePeriodPayLines } from "../lib/period-pay.js";
// [pay-day 2026-08-17] Tips/mileage/leave rows are windowed on the day the
// money belongs to, never on created_at. See lib/pay-day.ts.
import { payDaySql } from "../lib/pay-day.js";
// [overtime-one-engine 2026-08-17] Overtime on the Payroll Summary report comes
// from the SAME engine as /payroll/overtime-check. This report used to compute
// its own: `(clock_hours - 40) * users.pay_rate * 0.5`, hardcoding the federal
// threshold at a call site and multiplying by an hourly rate nothing has ever
// paid. See lib/overtime-estimate.ts.
import { computeOvertimeEstimate } from "../lib/overtime-estimate.js";
// [revenue-forecast 2026-08-18] Canonical money-per-job expression (commercial
// hourly x allowed beats a stale billed_amount cache) and the tenant's own
// calendar date, so "still ahead" is measured in Chicago, not UTC.
import { jobRevenueExpr } from "../lib/job-revenue-sql.js";
import { companyDateStr } from "../lib/company-tz.js";
// Mileage is a reimbursement, not wages — keep it out of any pay column.
import { splitAdditionalPay } from "@workspace/payroll-metrics";
// [dashboard-parity 2026-08-17] The cutover floor and the MaidCentral merge
// used to live in this file. They moved to lib/ so routes/dashboard.ts can
// apply the identical rule — the front page and this report now answer "what
// did we make in <month>" with the same number. Behaviour here is unchanged.
import {
  reportingFloor, clampFrom, historicalRevenue,
  type RangeClamp, type HistoricalMonth, type HistoricalRevenue,
} from "../lib/reporting-floor.js";

export type { RangeClamp, HistoricalMonth, HistoricalRevenue };

const router = Router();
const ROLE = requireRole("owner", "admin", "office");

function dateStr(d: Date) { return d.toISOString().split("T")[0]; }
function parseF(v: any) { return parseFloat(v || "0"); }
function parseN(v: any) { return Number(v || 0); }

// [revenue-definition 2026-08-17] ONE definition of what a job earned.
// `billed_amount` when it is set — it carries rate mods and any amount stamped
// at completion — otherwise `base_fee`. /revenue has used this waterfall since
// 2026-06-02, but job-costing, payroll-to-revenue, employee-stats, week-review
// and insights each summed bare `base_fee`, so the same completed job was worth
// two different numbers depending on which report you opened. On co1's last
// twelve months that gap was 127 jobs of 1,866 and $5,947.44 — margin, labor
// ratio and per-employee revenue were all computed against the smaller figure.
// Any new revenue rollup uses this. Do not sum `base_fee` alone again.
//
// EFFECTIVE_AMOUNT_SQL is for raw `db.execute(sql...)` queries; pass a table
// alias ("j") when the query aliases jobs. effectiveAmountCol() is the Drizzle
// query-builder form for sum()/avg().
const EFFECTIVE_AMOUNT_SQL = (alias = "") => {
  const p = alias ? `${alias}.` : "";
  return sql.raw(`coalesce(${p}billed_amount, ${p}base_fee)`);
};
const effectiveAmountCol = () => sql<string>`coalesce(${jobsTable.billed_amount}, ${jobsTable.base_fee})`;

// Model A branch filter. Pass `col` to qualify when the query aliases the
// source table (e.g. "j.branch_id"). Returns an empty SQL fragment when the
// caller wants "all branches" (default), so it composes cleanly into any
// AND-chained WHERE clause: `WHERE company_id = X ${branchFilter(req)} ...`.
//
// Convention: callers pass `?branch_id=N` (integer) or `?branch_id=all` (or
// omit entirely) — anything non-numeric is treated as "all" defensively.
function branchFilter(req: any, col: string = "branch_id") {
  const raw = req.query.branch_id as string | undefined;
  if (!raw || raw === "all") return sql``;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return sql``;
  return sql`AND ${sql.raw(col)} = ${n}`;
}

// Drizzle query-builder variant. Returns a condition for `and(...)`, or
// undefined when no filter applies — Drizzle's `and()` skips undefined.
function branchCond(req: any, column: any) {
  const raw = req.query.branch_id as string | undefined;
  if (!raw || raw === "all") return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return undefined;
  return eq(column, n);
}

// ─── INSIGHTS (existing) ──────────────────────────────────────────────────────
router.get("/insights", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fortyFiveDaysAgo = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
    const dateStr30 = dateStr(thirtyDaysAgo);
    const dateStr7 = dateStr(sevenDaysAgo);
    const dateStr45 = dateStr(fortyFiveDaysAgo);
    const todayStr = dateStr(now);

    const branchCondJob   = branchCond(req, jobsTable.branch_id);
    const branchCondClock = branchCond(req, timeclockTable.branch_id);

    // [scorecard-dead-table 2026-08-08] `scorecards` is a LEGACY table that
    // nothing writes to any more. Customer ratings land in `scorecard_entries`
    // (captureJobScore → one row per tech per job). Averaging the old table
    // returned zero rows, so this page reported "0 concern flags / all employees
    // performing well" and Week in Review showed Quality 0.00/4 — while the
    // Scorecard report, which reads the right table, showed 87% off 24 real
    // responses. Sal, 2026-08-08: "all of this needs to be connected."
    //
    // Mapping: score → score_value/max_value (normalised back onto 0–4),
    // user_id → employee_id, created_at → entry_date, plus the dismissed_at
    // guard the entries table has and the old one didn't.
    const topScores = await db.execute(sql`
      SELECT employee_id, AVG(score_value / NULLIF(max_value, 0) * 4) AS avg_score
        FROM scorecard_entries
       WHERE company_id = ${companyId} AND excluded = false AND dismissed_at IS NULL
         AND entry_date >= ${dateStr7}
       GROUP BY employee_id`);
    const topScoreBy = new Map<number, number>(
      (topScores.rows as any[]).map(r => [Number(r.employee_id), Number(r.avg_score)]),
    );

    const topPerformersRaw = await db.select({
      id: usersTable.id, first_name: usersTable.first_name, last_name: usersTable.last_name,
      avatar_url: usersTable.avatar_url, jobs_completed: count(jobsTable.id),
    }).from(usersTable)
      .leftJoin(jobsTable, and(eq(jobsTable.assigned_user_id, usersTable.id), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, dateStr7), branchCondJob))
      .where(and(eq(usersTable.company_id, companyId), eq(usersTable.is_active, true)))
      .groupBy(usersTable.id).orderBy(desc(count(jobsTable.id))).limit(5);
    const topPerformers = topPerformersRaw.map(u => ({
      ...u,
      avg_score: topScoreBy.has(Number(u.id)) ? topScoreBy.get(Number(u.id))! : null,
    }));

    const lateClockins = await db.select({ user_id: timeclockTable.user_id, late_count: count(timeclockTable.id) })
      .from(timeclockTable)
      .where(and(eq(timeclockTable.company_id, companyId), eq(timeclockTable.flagged, true), gte(timeclockTable.clock_in_at, thirtyDaysAgo), branchCondClock))
      .groupBy(timeclockTable.user_id);

    // [scorecard-dead-table 2026-08-08] Same swap. Against the legacy table this
    // matched nothing, so nobody was ever flagged — Juan Salazar sits at 63%
    // satisfaction (2.5 of 4) and the page still said "all employees are
    // performing well". The < 3.0 threshold is unchanged.
    const lowRows = await db.execute(sql`
      SELECT employee_id AS user_id, AVG(score_value / NULLIF(max_value, 0) * 4) AS avg_score
        FROM scorecard_entries
       WHERE company_id = ${companyId} AND excluded = false AND dismissed_at IS NULL
         AND entry_date >= ${thirtyDaysAgo.toISOString().slice(0, 10)}
       GROUP BY employee_id
      HAVING AVG(score_value / NULLIF(max_value, 0) * 4) < 3.0`);
    const lowScorecards = (lowRows.rows as any[]).map(r => ({
      user_id: Number(r.user_id), avg_score: Number(r.avg_score),
    }));

    const concernUserIds = new Set([...lateClockins.map(l => l.user_id), ...lowScorecards.map(l => l.user_id)]);
    const concernUserIdList = [...concernUserIds];
    const concernEmployees = concernUserIdList.length > 0
      ? await db.select({ id: usersTable.id, first_name: usersTable.first_name, last_name: usersTable.last_name, avatar_url: usersTable.avatar_url })
          .from(usersTable).where(and(eq(usersTable.company_id, companyId), inArray(usersTable.id, concernUserIdList)))
      : [];

    const concerns = concernEmployees.map(u => {
      const flags: string[] = [];
      const lc = lateClockins.find(l => l.user_id === u.id);
      if (lc) flags.push(`${lc.late_count} flagged clock-in${lc.late_count > 1 ? "s" : ""} this month`);
      const ls = lowScorecards.find(l => l.user_id === u.id);
      if (ls) flags.push(`Score avg ${parseF(ls.avg_score).toFixed(1)}/4.0 (below 3.0)`);
      return { ...u, concerns: flags };
    });

    const lastJobPerClient = await db.select({ client_id: jobsTable.client_id, last_date: sql<string>`max(${jobsTable.scheduled_date})` })
      .from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), branchCondJob))
      .groupBy(jobsTable.client_id);

    const atRiskClients = lastJobPerClient.filter(j => j.last_date < dateStr45).slice(0, 5);
    const atRiskClientIds = atRiskClients.map(j => j.client_id);
    const atRiskClientDetails = atRiskClientIds.length > 0
      ? await db.select({ id: clientsTable.id, first_name: clientsTable.first_name, last_name: clientsTable.last_name, email: clientsTable.email })
          .from(clientsTable).where(inArray(clientsTable.id, atRiskClientIds as number[]))
      : [];

    const clientHealth = atRiskClientDetails.map(c => {
      const last = atRiskClients.find(j => j.client_id === c.id);
      const daysSince = last ? Math.floor((now.getTime() - new Date(last.last_date).getTime()) / (1000 * 60 * 60 * 24)) : 0;
      return { ...c, reason: `No booking in ${daysSince} days`, days_since: daysSince };
    });

    const revenueByService = await db.select({
      service_type: jobsTable.service_type, total_revenue: sum(effectiveAmountCol()), job_count: count(jobsTable.id),
    }).from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, dateStr30), branchCondJob))
      .groupBy(jobsTable.service_type).orderBy(desc(sum(effectiveAmountCol())));

    const avgJobValue = await db.select({ avg: avg(effectiveAmountCol()) }).from(jobsTable)
      .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, dateStr30), branchCondJob));

    const projectedRevenue = await db.select({ projected: sum(effectiveAmountCol()) }).from(jobsTable)
      .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "scheduled"), gte(jobsTable.scheduled_date, todayStr), branchCondJob));

    return res.json({
      top_performers: topPerformers.map(p => ({ ...p, avg_score: p.avg_score ? parseF(p.avg_score) : null, jobs_completed: parseN(p.jobs_completed) })),
      concerns, client_health: clientHealth,
      revenue_by_service: revenueByService.map(r => ({ service_type: r.service_type, total_revenue: parseF(r.total_revenue), job_count: parseN(r.job_count) })),
      avg_job_value: parseF(avgJobValue[0]?.avg), projected_revenue: parseF(projectedRevenue[0]?.projected),
    });
  } catch (err) {
    console.error("Reports insights error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── REVENUE SUMMARY ─────────────────────────────────────────────────────────
router.get("/revenue", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    let fromStr = (req.query.from as string) || dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
    const toStr   = (req.query.to   as string) || dateStr(now);
    // [reporting-floor 2026-08-17] Pre-cutover work is MaidCentral's record, not Qleno's.
    const { fromStr: floorFrom, clamp: rangeClamp } = await clampFrom(companyId, fromStr, toStr);
    fromStr = floorFrom;
    // [mc-revenue-history 2026-08-17] ...and where that record exists, fold it
    // in, so the operator gets the whole period they asked for instead of a
    // hole.
    //
    // Sal, 2026-08-17: "I don't want to keep them separate. There's really no
    // need... I still need it all to be in one place, not separated. It's the
    // same company." So `summary.total_revenue` and `trend` below span BOTH
    // systems. It is one company's revenue for one period, and splitting the
    // headline in two made the operator do the addition by hand.
    //
    // What does NOT merge, because it cannot: `job_count`, `avg_job_value` and
    // `allowed_hours`. MaidCentral handed over one number per month with no job
    // detail behind it, so there is nothing to count or divide by. Those stay
    // Qleno-only and say so via `counts_from`; the MaidCentral trend rows carry
    // null (not 0) in those columns so a table renders an em-dash rather than
    // implying a month with no work in it.
    const historical = rangeClamp
      ? await historicalRevenue(companyId, rangeClamp.requested_from, toStr, rangeClamp.floor)
      : null;
    const groupBy = (req.query.group_by as string) || "day";

    const groupExpr = groupBy === "month" ? sql`to_char(${jobsTable.scheduled_date}::date, 'YYYY-MM')`
      : groupBy === "week" ? sql`to_char(date_trunc('week', ${jobsTable.scheduled_date}::date), 'YYYY-MM-DD')`
      : sql`${jobsTable.scheduled_date}::text`;

    // [revenue] Pick the effective per-job amount via the canonical waterfall
    // used elsewhere in the codebase (clients.ts revenue rollups, payroll
    // commission, manual charge): billed_amount when set (covers job rate
    // mods + completion-time overrides), else base_fee. Summing base_fee
    // alone would miss rate-mod adjustments and ignore any billed_amount
    // stamped at completion.
    const effectiveAmount = sql`coalesce(billed_amount, base_fee)`;

    // [BUG-3F3 / 2026-06-02] Revenue rollup excludes cancelled jobs by
    // default — matches the dispatch board's "what counts as billable"
    // rule (`status != 'cancelled'`). Previously the default was "all
    // statuses" to mirror an earlier MaidCentral parity ask, but it
    // counted cancelled rows that still carry a (now-zeroed) base_fee
    // or a cancellation fee stamped on billed_amount. On 2026-06-01 the
    // page reported 63 jobs / $5,024.40 instead of 14 / $4,369.40, and
    // 2026-06-02 reported 2 jobs / $521.50 for a day that hasn't
    // happened yet. Default now: include scheduled + in_progress +
    // complete. Operators can still opt into specific views:
    //   ?status=complete     → cash-recognized only
    //   ?status=cancelled    → cancellation-fee revenue stream
    //   ?status=all          → everything incl. cancelled
    //   (no status param)    → the dispatch-board-equivalent default
    // The standalone cancel/lockout fee revenue still surfaces via the
    // cancelBreakdown query further down — that's a separate, clear
    // signal the dashboard cards already render.
    const statusFilter = (req.query.status as string) || "active";
    let statusCond;
    if (statusFilter === "active") {
      statusCond = sql`status IN ('scheduled','in_progress','complete')`;
    } else if (statusFilter === "all") {
      statusCond = sql`true`;
    } else {
      statusCond = sql`status = ${statusFilter}`;
    }

    const branchFrag = branchFilter(req);

    const trend = await db.execute(sql`
      SELECT
        ${groupExpr} AS period,
        count(*) AS job_count,
        coalesce(sum(${effectiveAmount}), 0) AS revenue,
        coalesce(avg(${effectiveAmount}), 0) AS avg_per_job,
        coalesce(sum(allowed_hours), 0) AS allowed_hours
      FROM jobs
      WHERE company_id = ${companyId}
        ${branchFrag}
        AND ${statusCond}
        AND scheduled_date BETWEEN ${fromStr} AND ${toStr}
      GROUP BY 1
      ORDER BY 1
    `);

    const summary = await db.execute(sql`
      SELECT
        count(*) AS job_count,
        coalesce(sum(${effectiveAmount}), 0) AS total_revenue,
        coalesce(avg(${effectiveAmount}), 0) AS avg_job_value,
        coalesce(sum(allowed_hours), 0) AS total_allowed_hours
      FROM jobs
      WHERE company_id = ${companyId}
        ${branchFrag}
        AND ${statusCond}
        AND scheduled_date BETWEEN ${fromStr} AND ${toStr}
    `);

    // Projected: sum of scheduled jobs this month
    const monthStart = dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
    const monthEnd   = dateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    const projected  = await db.execute(sql`
      SELECT coalesce(sum(${effectiveAmount}), 0) AS projected
      FROM jobs
      WHERE company_id = ${companyId} AND status IN ('scheduled','in_progress','complete')
        ${branchFrag}
        AND scheduled_date BETWEEN ${monthStart} AND ${monthEnd}
    `);

    // [cancellation-reporting 2026-06-01] Break down the window's total
    // revenue into visit revenue (real cleanings delivered) vs
    // cancellation-fee revenue (lockouts + cancel-with-charge). Sourced
    // from cancellation_log so we pick up exactly what was charged on
    // each event — not derived from job status which can blur the
    // two streams (charged cancellations live as status='complete').
    // Reschedule counts (move/bump) and cancel_service counts surface
    // so operators can see the full picture even though those events
    // don't produce revenue rows.
    const cancelBreakdown = await db.execute(sql`
      SELECT
        coalesce(sum(case when cl.cancel_action in ('cancel','lockout') then cl.customer_charge_amount else 0 end), 0) AS cancellation_fee_revenue,
        coalesce(sum(case when cl.cancel_action = 'lockout' then cl.customer_charge_amount else 0 end), 0) AS lockout_fee_revenue,
        coalesce(sum(case when cl.cancel_action = 'cancel' then cl.customer_charge_amount else 0 end), 0) AS cancel_fee_revenue,
        sum(case when cl.cancel_action = 'move' then 1 else 0 end)::int AS move_count,
        sum(case when cl.cancel_action = 'bump' then 1 else 0 end)::int AS bump_count,
        sum(case when cl.cancel_action = 'skip' then 1 else 0 end)::int AS skip_count,
        sum(case when cl.cancel_action = 'cancel' then 1 else 0 end)::int AS cancel_count,
        sum(case when cl.cancel_action = 'lockout' then 1 else 0 end)::int AS lockout_count,
        sum(case when cl.cancel_action = 'cancel_service' then 1 else 0 end)::int AS cancel_service_count
      FROM cancellation_log cl
      JOIN jobs j ON j.id = cl.job_id
      WHERE cl.company_id = ${companyId}
        ${branchFilter(req, "j.branch_id")}
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
    `);
    const cb = (cancelBreakdown.rows[0] as any) ?? {};

    const s = summary.rows[0] as any;
    const qlenoRev = parseF(s?.total_revenue);
    const histRev = historical?.total ?? 0;
    // The headline. One company, one period, one number.
    const totalRev = Math.round((qlenoRev + histRev) * 100) / 100;
    const cancelFeeRev = parseF(cb.cancellation_fee_revenue);
    return res.json({
      range_clamped: rangeClamp,
      // The month-by-month MaidCentral detail behind the figure above, so a
      // reader can see which months came from where. The split is available;
      // it is no longer the thing the page leads with.
      historical,
      from: historical ? historical.months[0].month + "-01" : fromStr,
      to: toStr, group_by: groupBy,
      // Where Qleno's own job-level data starts. Job counts, averages and hours
      // below cover this date onward and nothing earlier.
      counts_from: rangeClamp ? rangeClamp.floor : fromStr,
      summary: {
        total_revenue: totalRev,
        // The two halves of that total, for anyone who needs them.
        qleno_revenue: qlenoRev,
        historical_revenue: histRev,
        avg_job_value: parseF(s?.avg_job_value),
        job_count: parseN(s?.job_count),
        projected_month_end: parseF((projected.rows[0] as any)?.projected),
        // [cancellation-reporting 2026-06-01] Cancellation revenue
        // breakdown. visit_revenue = total minus the cancellation-fee
        // portion (so consumers can show "real visit revenue" without
        // the lockout/cancel fees folded in). cancellation_fee_revenue
        // is the sum of charged actions; lockout_fee + cancel_fee are
        // the further breakdown.
        cancellation_fee_revenue: cancelFeeRev,
        visit_revenue: Math.round((totalRev - cancelFeeRev) * 100) / 100,
        lockout_fee_revenue: parseF(cb.lockout_fee_revenue),
        cancel_fee_revenue: parseF(cb.cancel_fee_revenue),
        // Counts for awareness — reschedules + skips + service cancellations.
        move_count: cb.move_count ?? 0,
        bump_count: cb.bump_count ?? 0,
        skip_count: cb.skip_count ?? 0,
        cancel_count: cb.cancel_count ?? 0,
        lockout_count: cb.lockout_count ?? 0,
        cancel_service_count: cb.cancel_service_count ?? 0,
      },
      // One series, oldest first, MaidCentral's months leading into Qleno's own
      // periods. `source` lets a consumer label the earlier rows; the job/hours
      // columns are null there because those figures do not exist, and a null
      // renders as a dash instead of a false zero.
      trend: [
        ...(historical?.months ?? []).map(m => ({
          // Matched to the current grouping so the series still sorts as text:
          // 'YYYY-MM' when grouping by month, else the first of that month.
          period: groupBy === "month" ? m.month : `${m.month}-01`,
          job_count: null as number | null,
          revenue: m.revenue,
          avg_per_job: null as number | null,
          allowed_hours: null as number | null,
          source: m.source,
        })),
        ...(trend.rows as any[]).map(r => ({
          period: r.period as string, job_count: parseN(r.job_count), revenue: parseF(r.revenue),
          avg_per_job: parseF(r.avg_per_job), allowed_hours: parseF(r.allowed_hours),
          source: "qleno",
        })),
      ],
    });
  } catch (err) {
    console.error("Revenue report error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── REVENUE FORECAST (scheduled work, month by month) ───────────────────────
// [revenue-forecast 2026-08-18] The dashboard has carried a "Revenue forecast ·
// next 30 days" tile since it was built, reading `kpis.forecast_next_month`.
// No server route has ever produced that field, and the tile hides itself when
// the value is missing — so it silently rendered nothing for its whole life.
// This is the surface behind it, and it goes further than 30 days.
//
// It is deliberately NOT a predictive model. Every dollar here is a visit
// already written on the calendar: the recurring engine generates a rolling
// 365 days ahead, so the book of scheduled work genuinely runs a year out and
// there is nothing to guess at. That matters because the reporting spec says
// not to present speculative forecasts as guaranteed outcomes — the honest
// answer is to report what is booked and label the edges where the calendar
// runs out, which is exactly what `state` and `generated_through` do.
//
// Three month states, and the difference is load-bearing:
//   in_progress — the current month. Part earned, part still ahead.
//   scheduled   — fully inside the generation horizon. The book is complete.
//   partial     — past the horizon. The engine has not written these visits
//                 yet, so the figure is an undercount and MUST NOT be summed
//                 into a headline. The page dims it and says so.
router.get("/revenue-forecast", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const today = companyDateStr(companyId);

    const monthsRaw = parseInt((req.query.months as string) || "12", 10);
    const months = Number.isFinite(monthsRaw) ? Math.min(24, Math.max(1, monthsRaw)) : 12;

    // Cancelled work is never booked revenue. Everything else on the calendar
    // from the first of the current month forward is in scope.
    const rev = jobRevenueExpr(sql`COALESCE(j.billed_amount, j.base_fee, 0)`);

    const [monthRows, horizonRow, next30Row, unpricedRows] = await Promise.all([
      db.execute(sql`
        SELECT to_char(date_trunc('month', t.scheduled_date), 'YYYY-MM') AS month,
               COUNT(*)::int AS jobs,
               COUNT(*) FILTER (WHERE t.scheduled_date >= ${today}::date)::int AS remaining_jobs,
               COUNT(*) FILTER (WHERE COALESCE(t.rev, 0) <= 0)::int AS unpriced_jobs,
               ROUND(COALESCE(SUM(t.rev), 0), 2)::numeric AS booked,
               ROUND(COALESCE(SUM(t.rev) FILTER (WHERE t.scheduled_date >= ${today}::date), 0), 2)::numeric AS remaining,
               ROUND(COALESCE(SUM(t.rev) FILTER (WHERE t.recurring_schedule_id IS NOT NULL), 0), 2)::numeric AS recurring,
               ROUND(COALESCE(SUM(t.rev) FILTER (WHERE t.recurring_schedule_id IS NULL), 0), 2)::numeric AS one_time
        FROM (
          SELECT j.scheduled_date, j.recurring_schedule_id, ${rev} AS rev
          FROM jobs j
          LEFT JOIN clients c ON c.id = j.client_id
          WHERE j.company_id = ${companyId}
            AND j.status != 'cancelled'
            AND j.scheduled_date >= date_trunc('month', ${today}::date)
            AND j.scheduled_date <  date_trunc('month', ${today}::date) + (${months} || ' months')::interval
            ${branchFilter(req, "j.branch_id")}
        ) t
        GROUP BY 1
        ORDER BY 1
      `),
      // How far the recurring engine has actually written. One-time jobs can be
      // booked past it, so only engine-generated rows define the horizon.
      db.execute(sql`
        SELECT to_char(MAX(j.scheduled_date), 'YYYY-MM-DD') AS d
        FROM jobs j
        WHERE j.company_id = ${companyId}
          AND j.status != 'cancelled'
          AND j.recurring_schedule_id IS NOT NULL
          ${branchFilter(req, "j.branch_id")}
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS jobs, ROUND(COALESCE(SUM(t.rev), 0), 2)::numeric AS revenue
        FROM (
          SELECT ${rev} AS rev
          FROM jobs j
          LEFT JOIN clients c ON c.id = j.client_id
          WHERE j.company_id = ${companyId}
            AND j.status != 'cancelled'
            AND j.scheduled_date >= ${today}::date
            AND j.scheduled_date <  ${today}::date + INTERVAL '30 days'
            ${branchFilter(req, "j.branch_id")}
        ) t
      `),
      // [unpriced-sources 2026-08-18] A count of unpriced visits is an alarm
      // with no address on it. Every one of these traces back to a template
      // whose price is blank, so the report names the templates instead — the
      // office fixes four schedules, not a hundred jobs one at a time. Only
      // visits still ahead are listed; a $0 job already in the past is history
      // and re-pricing it would rewrite what was billed.
      db.execute(sql`
        SELECT t.recurring_schedule_id AS schedule_id,
               COUNT(*)::int AS jobs,
               to_char(MIN(t.scheduled_date), 'YYYY-MM-DD') AS first_date,
               to_char(MAX(t.scheduled_date), 'YYYY-MM-DD') AS last_date,
               COALESCE(MAX(t.account_name), MAX(t.client_name)) AS name
        FROM (
          SELECT j.scheduled_date, j.recurring_schedule_id,
                 a.account_name,
                 NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS client_name,
                 ${rev} AS rev
          FROM jobs j
          LEFT JOIN clients c ON c.id = j.client_id
          LEFT JOIN accounts a ON a.id = j.account_id
          WHERE j.company_id = ${companyId}
            AND j.status != 'cancelled'
            AND j.scheduled_date >= ${today}::date
            AND j.scheduled_date <  date_trunc('month', ${today}::date) + (${months} || ' months')::interval
            ${branchFilter(req, "j.branch_id")}
        ) t
        WHERE COALESCE(t.rev, 0) <= 0
        GROUP BY 1
        ORDER BY jobs DESC
        LIMIT 20
      `),
    ]);

    const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
    const generatedThrough = (horizonRow.rows[0] as any)?.d as string | null ?? null;
    const currentMonth = today.slice(0, 7);

    // A month is fully written only when its LAST day is on or before the
    // horizon. 2027-08-18 as a horizon means July is the last complete month.
    const monthEnd = (m: string) => {
      const [y, mo] = m.split("-").map(Number);
      return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    };

    // The month series is built as an unbroken run from the current month, then
    // the aggregate rows are laid onto it. Building it straight off GROUP BY
    // instead would silently drop any month with nothing on the calendar, and a
    // bar chart of non-adjacent months reads as if they were consecutive — one
    // stray job booked far ahead would sit next to the horizon tail looking like
    // the very next month. An empty month past the horizon is not "$0 of work";
    // it is work the engine has not written yet, which is exactly what `partial`
    // already says, so it carries that state and stays out of every total.
    const byMonth = new Map((monthRows.rows as any[]).map(r => [String(r.month), r]));
    const [cy, cm] = currentMonth.split("-").map(Number);

    const rows = Array.from({ length: months }, (_, i) => {
      const d = new Date(Date.UTC(cy, cm - 1 + i, 1));
      const month = d.toISOString().slice(0, 7);
      const r = byMonth.get(month);

      let state: "in_progress" | "scheduled" | "partial";
      if (month === currentMonth) state = "in_progress";
      else if (!generatedThrough || monthEnd(month) <= generatedThrough) state = "scheduled";
      else state = "partial";

      return {
        month,
        state,
        jobs: num(r?.jobs),
        remaining_jobs: num(r?.remaining_jobs),
        unpriced_jobs: num(r?.unpriced_jobs),
        booked: num(r?.booked),
        remaining: num(r?.remaining),
        recurring: num(r?.recurring),
        one_time: num(r?.one_time),
      };
    });

    // The headline counts only what is still ahead AND fully written. A partial
    // month's number is real but incomplete, so adding it in would understate
    // the total while looking like a total.
    const countable = rows.filter(r => r.state !== "partial");
    const n30 = next30Row.rows[0] as any;

    return res.json({
      today,
      current_month: currentMonth,
      generated_through: generatedThrough,
      months_requested: months,
      next_30_days: { jobs: num(n30?.jobs), revenue: num(n30?.revenue) },
      scheduled_ahead: {
        revenue: countable.reduce((s, r) => s + r.remaining, 0),
        jobs: countable.reduce((s, r) => s + r.remaining_jobs, 0),
        through: countable.length ? countable[countable.length - 1].month : null,
      },
      unpriced_jobs: rows.reduce((s, r) => s + r.unpriced_jobs, 0),
      unpriced_sources: (unpricedRows.rows as any[]).map(r => ({
        schedule_id: r.schedule_id == null ? null : Number(r.schedule_id),
        name: (r.name as string) || "Unnamed",
        jobs: num(r.jobs),
        first_date: r.first_date as string,
        last_date: r.last_date as string,
      })),
      months_data: rows,
    });
  } catch (err) {
    console.error("Revenue forecast report error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── REVENUE HISTORY (pre-Qleno, from MaidCentral) ───────────────────────────
// [mc-revenue-history 2026-08-17] Was a hardcoded array in the page component.
// Moved to the database so it is one source of truth with the revenue report,
// and so a figure can be corrected without a deploy.
router.get("/revenue-history", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const floor = await reportingFloor(companyId);
    const rows = await db.execute(sql`
      SELECT to_char(month, 'MM/YYYY') AS month,
             to_char(month, 'YYYY-MM') AS month_key,
             phes_revenue, schaumburg_revenue, total_revenue,
             revenue_type, source, to_char(captured_at, 'YYYY-MM-DD') AS captured_at
        FROM mc_revenue_history
       WHERE company_id = ${companyId}
       ORDER BY month`);

    const data = (rows.rows as any[]).map(r => ({
      month: r.month as string,
      month_key: r.month_key as string,
      phes: parseF(r.phes_revenue),
      schaumburg: parseF(r.schaumburg_revenue),
      total: parseF(r.total_revenue),
      type: r.revenue_type as string,
      source: r.source as string,
    }));

    const sumOf = (t: string) => Math.round(
      data.filter(d => d.type === t).reduce((s, d) => s + d.total, 0) * 100) / 100;
    const actual = sumOf("actual");
    const full = Math.round(data.reduce((s, d) => s + d.total, 0) * 100) / 100;

    return res.json({
      data,
      summary: {
        actual_total: actual,
        // Everything MaidCentral had not yet delivered when the figures were
        // captured — its own forecast, never collected. Reported separately so
        // it can never be mistaken for revenue.
        projected_total: Math.round((full - actual) * 100) / 100,
        full_total: full,
        actual_months: data.filter(d => d.type === "actual").length,
        first_month: data[0]?.month ?? null,
        last_actual_month: [...data].reverse().find(d => d.type === "actual")?.month ?? null,
      },
      captured_at: (rows.rows[0] as any)?.captured_at ?? null,
      // Where Qleno's own records take over.
      cutover_date: floor,
    });
  } catch (err) {
    console.error("Revenue history report error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── ACCOUNTS RECEIVABLE ─────────────────────────────────────────────────────
router.get("/receivables", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const filter = (req.query.filter as string) || "all";

    const rows = await db.execute(sql`
      SELECT
        i.id, i.invoice_number, i.status, i.total, i.created_at, i.paid_at,
        c.first_name, c.last_name, c.email,
        (i.created_at + interval '30 days') AS due_date,
        GREATEST(0, EXTRACT(EPOCH FROM (NOW() - (i.created_at + interval '30 days'))) / 86400)::int AS days_overdue
      FROM invoices i
      JOIN clients c ON c.id = i.client_id
      WHERE i.company_id = ${companyId}
        ${branchFilter(req, "i.branch_id")}
        AND i.status IN ('sent','overdue')
      ORDER BY days_overdue DESC
    `);

    const data = (rows.rows as any[]).map(r => ({
      id: r.id, invoice_number: r.invoice_number, status: r.status, total: parseF(r.total),
      client_name: `${r.first_name} ${r.last_name}`, client_email: r.email,
      invoice_date: r.created_at, due_date: r.due_date,
      days_overdue: Math.max(0, r.days_overdue),
    }));

    const buckets = {
      current:   data.filter(r => r.days_overdue <= 0),
      late:      data.filter(r => r.days_overdue > 0  && r.days_overdue <= 30),
      very_late: data.filter(r => r.days_overdue > 30 && r.days_overdue <= 60),
      critical:  data.filter(r => r.days_overdue > 60),
    };

    const filtered = filter === "overdue"  ? data.filter(r => r.days_overdue > 0)
      : filter === "0-30"   ? buckets.late
      : filter === "31-60"  ? buckets.very_late
      : filter === "90+"    ? buckets.critical
      : data;

    const total = (arr: any[]) => arr.reduce((s, r) => s + r.total, 0);
    return res.json({
      summary: {
        current: total(buckets.current), late: total(buckets.late),
        very_late: total(buckets.very_late), critical: total(buckets.critical),
        total_outstanding: total(data),
      },
      data: filtered,
    });
  } catch (err) {
    console.error("Receivables error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── JOB COSTING ─────────────────────────────────────────────────────────────
router.get("/job-costing", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    let fromStr = (req.query.from as string) || dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
    const toStr   = (req.query.to   as string) || dateStr(now);
    // [reporting-floor 2026-08-17] Pre-cutover work is MaidCentral's record, not Qleno's.
    const { fromStr: floorFrom, clamp: rangeClamp } = await clampFrom(companyId, fromStr, toStr);
    fromStr = floorFrom;

    // [pay-model-parity 2026-07-04] Labor cost per job = SUM of the paycheck
    // engine's per-tech amounts on that job (computePeriodPayLines), NOT the old
    // per-EMPLOYEE pay_type CASE (no allowed_hours branch, primary tech only).
    const { lines: costLines } = await computePeriodPayLines(companyId, fromStr, toStr);
    const laborByJob = new Map<number, number>();
    for (const l of costLines) laborByJob.set(l.job_id, (laborByJob.get(l.job_id) ?? 0) + (l.amount || 0));

    // [job-costing-truncation 2026-08-17] This query used to end in `LIMIT 500`
    // and the summary totals were then summed over whatever survived the cut.
    // Phes completes roughly 260-320 jobs a month, so a month fit and looked
    // right; a quarter (~800) or a year (~1,900) silently dropped the oldest
    // rows AND under-reported total revenue, total labor and total profit, with
    // nothing on screen to say so. Totals are now computed over every job in the
    // range. Only the detail list is capped, and when it is, the response says
    // so and the page prints it.
    const rows = await db.execute(sql`
      SELECT
        j.id, j.scheduled_date, j.service_type,
        ${EFFECTIVE_AMOUNT_SQL("j")} AS effective_amount,
        j.allowed_hours, j.actual_hours,
        c.first_name AS client_first, c.last_name AS client_last,
        c.company_name AS client_company, a.account_name,
        u.first_name AS emp_first, u.last_name AS emp_last
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
      LEFT JOIN users u ON u.id = j.assigned_user_id
      WHERE j.company_id = ${companyId}
        ${branchFilter(req, "j.branch_id")}
        AND j.status = 'complete'
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      ORDER BY j.scheduled_date DESC
    `);

    const all = (rows.rows as any[]).map(r => {
      const revenue = parseF(r.effective_amount);
      const labor   = Math.round((laborByJob.get(Number(r.id)) ?? 0) * 100) / 100;
      const profit  = revenue - labor;
      const margin  = revenue > 0 ? (profit / revenue) * 100 : 0;
      return {
        id: r.id, date: r.scheduled_date, service_type: r.service_type,
        // [job-costing-commercial 2026-08-17] This was `JOIN clients`, an inner
        // join, so every job booked to an account instead of a client vanished
        // from the report — 703 of co1's 1,866 completed jobs over the last
        // twelve months, carrying $135,678.29 of revenue. Job Costing looked
        // complete while showing only the residential book. LEFT JOIN both
        // sides and name the customer from whichever one the job actually has.
        client_name: r.account_name
          || r.client_company
          || (r.client_first ? `${r.client_first} ${r.client_last}` : "No customer on the job"),
        employee_name: r.emp_first ? `${r.emp_first} ${r.emp_last}` : "Unassigned",
        revenue, labor_cost: parseF(labor), gross_profit: profit, margin_pct: margin,
        allowed_hours: parseF(r.allowed_hours), actual_hours: parseF(r.actual_hours),
      };
    });

    const totalRevenue = all.reduce((s, r) => s + r.revenue, 0);
    const totalLabor   = all.reduce((s, r) => s + r.labor_cost, 0);
    const totalProfit  = all.reduce((s, r) => s + r.gross_profit, 0);

    // Portfolio margin, not the mean of per-job margin percentages. The old
    // unweighted mean let a $60 job swing the headline as hard as a $600 one,
    // so `avg_margin` could disagree with total_profit / total_revenue on the
    // same screen. One definition: profit over revenue for the whole range.
    const avgMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

    // Best/worst service types — weighted the same way, for the same reason.
    const byService: Record<string, { revenue: number; profit: number }> = {};
    all.forEach(r => {
      if (!byService[r.service_type]) byService[r.service_type] = { revenue: 0, profit: 0 };
      byService[r.service_type].revenue += r.revenue;
      byService[r.service_type].profit  += r.gross_profit;
    });
    const serviceAvgs = Object.entries(byService)
      .filter(([, v]) => v.revenue > 0)
      .map(([st, v]) => ({ service_type: st, avg_margin: (v.profit / v.revenue) * 100 }))
      .sort((a, b) => b.avg_margin - a.avg_margin);

    const DETAIL_ROW_CAP = 2000;
    const data = all.slice(0, DETAIL_ROW_CAP);

    return res.json({
      range_clamped: rangeClamp,
      from: fromStr, to: toStr, data,
      row_count: all.length,
      rows_shown: data.length,
      truncated: all.length > data.length,
      summary: {
        avg_margin: avgMargin,
        best_service: serviceAvgs[0]?.service_type || null,
        worst_service: serviceAvgs[serviceAvgs.length - 1]?.service_type || null,
        total_revenue: totalRevenue,
        total_labor: totalLabor,
        total_profit: totalProfit,
      },
    });
  } catch (err) {
    console.error("Job costing error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── CLIENT PROFITABILITY ────────────────────────────────────────────────────
// Job Costing answers "which JOBS earn"; this answers "which CUSTOMERS earn".
//
// A customer here is a client OR an account. Routing is on `!!jobs.account_id`,
// the same test the commission engine uses to decide residential vs commercial —
// so a job belongs to exactly one customer and the two reports can never
// disagree about which side of the book it sits on.
//
// GROSS margin only. Qleno knows what a job billed and what it paid in labor;
// it does not carry supplies, vehicle, or overhead cost per job. So this reports
// revenue − labor and says "gross" everywhere. No net margin is manufactured out
// of expenses that do not exist in the data.
router.get("/client-profitability", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    let fromStr = (req.query.from as string) || dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
    const toStr   = (req.query.to   as string) || dateStr(now);
    // [reporting-floor 2026-08-17] Pre-cutover work is MaidCentral's record, not Qleno's.
    const { fromStr: floorFrom, clamp: rangeClamp } = await clampFrom(companyId, fromStr, toStr);
    fromStr = floorFrom;

    const typeFilter = (req.query.type as string) || "all";        // all | residential | commercial
    const sortKey    = (req.query.sort as string) || "revenue";
    const sortDir    = (req.query.dir  as string) === "asc" ? "asc" : "desc";
    const page       = Math.max(1, parseInt((req.query.page as string) || "1", 10) || 1);
    const pageSize   = Math.min(200, Math.max(10, parseInt((req.query.page_size as string) || "50", 10) || 50));

    // Labor from the paycheck engine — the same source Job Costing uses, so the
    // two reports cannot report different labor for the same job.
    //
    // [labor-coverage 2026-08-17] The engine returns nothing for a job it cannot
    // cost, and "nothing" is NOT "zero". Jobs imported from MaidCentral carry
    // revenue but no clock punches, so the engine emits no line for them. On
    // co1's trailing twelve months that is 1,258 of 1,866 completed jobs and 74%
    // of revenue — reading those as $0 labor produced a 90.4% gross margin for a
    // business that actually runs near 37%. Post-cutover the same range costs
    // 37.3% of revenue, which is right for a 35% commission shop. So track WHICH
    // jobs are costed and report margin only over those, rather than averaging a
    // real margin together with a fabricated one.
    const { lines: costLines } = await computePeriodPayLines(companyId, fromStr, toStr);
    const laborByJob = new Map<number, number>();
    for (const l of costLines) laborByJob.set(l.job_id, (laborByJob.get(l.job_id) ?? 0) + (l.amount || 0));

    // LEFT JOIN clients, not JOIN. Job Costing's inner join silently dropped
    // every account job — on co1's last twelve months that was 703 of 1,866
    // completed jobs and $135,678.29 of revenue that no costing screen showed.
    //
    // Zone follows the documented resolution chain as far as this report can:
    // jobs.zone_id, then the job's own zip, then the client's, then the
    // property's. A job that still resolves to nothing lands in an explicit
    // "No zone" bucket rather than being quietly folded into a real zone.
    const rows = await db.execute(sql`
      SELECT
        j.id, j.scheduled_date, j.service_type, j.frequency,
        ${EFFECTIVE_AMOUNT_SQL("j")} AS effective_amount,
        j.client_id, j.account_id,
        cl.first_name AS client_first, cl.last_name AS client_last,
        cl.company_name AS client_company, cl.client_type,
        a.account_name,
        coalesce(zd.name, zj.name, zc.name, zp.name) AS zone_name
      FROM jobs j
      LEFT JOIN clients cl ON cl.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
      LEFT JOIN account_properties p ON p.id = j.account_property_id
      LEFT JOIN service_zones zd ON zd.id = j.zone_id
      LEFT JOIN service_zones zj ON zj.company_id = j.company_id AND j.address_zip = ANY(zj.zip_codes)
      LEFT JOIN service_zones zc ON zc.company_id = j.company_id AND cl.zip       = ANY(zc.zip_codes)
      LEFT JOIN service_zones zp ON zp.company_id = j.company_id AND p.zip        = ANY(zp.zip_codes)
      WHERE j.company_id = ${companyId}
        ${branchFilter(req, "j.branch_id")}
        AND j.status = 'complete'
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
    `);

    type Cust = {
      key: string; kind: "client" | "account"; id: number | null; name: string;
      client_type: string; jobs: number; revenue: number; labor: number;
      jobs_costed: number; revenue_costed: number;
      first_visit: string | null; last_visit: string | null;
      freqs: Record<string, number>; zones: Record<string, number>;
    };
    type Bag = { jobs: number; revenue: number; labor: number; jobs_costed: number; revenue_costed: number };
    const custs = new Map<string, Cust>();
    const cut = (bag: Map<string, Bag>, label: string, rev: number, lab: number, costed: boolean) => {
      const e = bag.get(label) ?? { jobs: 0, revenue: 0, labor: 0, jobs_costed: 0, revenue_costed: 0 };
      e.jobs += 1; e.revenue += rev;
      if (costed) { e.jobs_costed += 1; e.revenue_costed += rev; e.labor += lab; }
      bag.set(label, e);
    };
    const byService = new Map<string, Bag>();
    const byZone    = new Map<string, Bag>();
    const byFreq    = new Map<string, Bag>();

    for (const r of rows.rows as any[]) {
      const revenue = parseF(r.effective_amount);
      // Costed = the pay engine produced a line for this job. A job it skipped
      // has UNKNOWN labor, not zero, and never contributes to a margin.
      const costed  = laborByJob.has(Number(r.id));
      const labor   = Math.round((laborByJob.get(Number(r.id)) ?? 0) * 100) / 100;

      const isAccount = r.account_id != null;
      const key  = isAccount ? `a:${r.account_id}` : r.client_id != null ? `c:${r.client_id}` : "unassigned";
      const name = isAccount
        ? (r.account_name || `Account ${r.account_id}`)
        : r.client_id != null
          ? (r.client_company || `${r.client_first ?? ""} ${r.client_last ?? ""}`.trim() || `Client ${r.client_id}`)
          : "No customer on the job";

      let c = custs.get(key);
      if (!c) {
        c = {
          key, kind: isAccount ? "account" : "client",
          id: isAccount ? Number(r.account_id) : r.client_id != null ? Number(r.client_id) : null,
          name,
          // An account is commercial by definition — that is what account_id
          // means to the commission engine, so it means the same here.
          client_type: isAccount ? "commercial" : (r.client_type || "residential"),
          jobs: 0, revenue: 0, labor: 0, jobs_costed: 0, revenue_costed: 0,
          first_visit: null, last_visit: null,
          freqs: {}, zones: {},
        };
        custs.set(key, c);
      }
      c.jobs += 1; c.revenue += revenue;
      if (costed) { c.jobs_costed += 1; c.revenue_costed += revenue; c.labor += labor; }
      const d = String(r.scheduled_date).slice(0, 10);
      if (!c.first_visit || d < c.first_visit) c.first_visit = d;
      if (!c.last_visit  || d > c.last_visit)  c.last_visit  = d;
      if (r.frequency) c.freqs[r.frequency] = (c.freqs[r.frequency] ?? 0) + 1;
      const zn = r.zone_name || "No zone";
      c.zones[zn] = (c.zones[zn] ?? 0) + 1;

      cut(byService, r.service_type || "unspecified", revenue, labor, costed);
      cut(byZone, zn, revenue, labor, costed);
      cut(byFreq, r.frequency || "on_demand", revenue, labor, costed);
    }

    const topOf = (bag: Record<string, number>) => {
      const e = Object.entries(bag).sort((a, b) => b[1] - a[1])[0];
      return e ? e[0] : null;
    };
    const r2 = (n: number) => Math.round(n * 100) / 100;
    // Margin is always profit ÷ the revenue of the COSTED jobs. Dividing by
    // total revenue would quietly dilute a real margin with uncosted work and
    // report a number that is true of no set of jobs at all.
    const marginOf = (revCosted: number, profit: number) => (revCosted > 0 ? (profit / revCosted) * 100 : 0);

    let all = [...custs.values()].map(c => {
      const known  = c.jobs_costed > 0;
      const profit = c.revenue_costed - c.labor;
      return {
        key: c.key, kind: c.kind, id: c.id, name: c.name, client_type: c.client_type,
        jobs: c.jobs,
        revenue: r2(c.revenue),
        // null, not 0 — the difference between "cost nothing" and "cost unknown".
        labor:      known ? r2(c.labor) : null,
        profit:     known ? r2(profit) : null,
        margin_pct: known ? marginOf(c.revenue_costed, profit) : null,
        jobs_costed: c.jobs_costed,
        revenue_costed: r2(c.revenue_costed),
        rev_per_visit: c.jobs > 0 ? r2(c.revenue / c.jobs) : 0,
        first_visit: c.first_visit, last_visit: c.last_visit,
        frequency: topOf(c.freqs), zone: topOf(c.zones),
      };
    });

    if (typeFilter === "residential" || typeFilter === "commercial") {
      all = all.filter(c => c.client_type === typeFilter);
    }

    // Summary is computed over the FILTERED set but BEFORE pagination — the
    // headline always describes the whole list underneath it, never one page.
    const totalRevenue = all.reduce((s, c) => s + c.revenue, 0);
    const totalLabor   = all.reduce((s, c) => s + (c.labor ?? 0), 0);
    const totalJobs    = all.reduce((s, c) => s + c.jobs, 0);
    const costedJobs   = all.reduce((s, c) => s + c.jobs_costed, 0);
    const costedRev    = all.reduce((s, c) => s + c.revenue_costed, 0);
    const totalProfit  = costedRev - totalLabor;

    const SORTS: Record<string, (c: typeof all[number]) => number | string | null> = {
      revenue: c => c.revenue, profit: c => c.profit, margin: c => c.margin_pct,
      jobs: c => c.jobs, rev_per_visit: c => c.rev_per_visit,
      last_visit: c => c.last_visit || "", name: c => c.name.toLowerCase(),
    };
    const pick = SORTS[sortKey] || SORTS.revenue;
    all.sort((a, b) => {
      const x = pick(a), y = pick(b);
      // Unknowns sink to the bottom in BOTH directions. Sorting by worst margin
      // should surface the genuinely thin customers, not the uncosted ones.
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const cmp = typeof x === "string" || typeof y === "string"
        ? String(x).localeCompare(String(y))
        : (x as number) - (y as number);
      return sortDir === "asc" ? cmp : -cmp;
    });

    const start = (page - 1) * pageSize;
    const data  = all.slice(start, start + pageSize);

    const cutOut = (bag: Map<string, Bag>) =>
      [...bag.entries()]
        .map(([label, v]) => {
          const known = v.jobs_costed > 0;
          const profit = v.revenue_costed - v.labor;
          return {
            label, jobs: v.jobs,
            revenue: r2(v.revenue),
            labor:      known ? r2(v.labor) : null,
            profit:     known ? r2(profit) : null,
            margin_pct: known ? marginOf(v.revenue_costed, profit) : null,
            jobs_costed: v.jobs_costed,
          };
        })
        .sort((a, b) => b.revenue - a.revenue);

    return res.json({
      range_clamped: rangeClamp,
      from: fromStr, to: toStr,
      summary: {
        customers: all.length, jobs: totalJobs,
        total_revenue: r2(totalRevenue),
        total_labor: costedJobs > 0 ? r2(totalLabor) : null,
        total_profit: costedJobs > 0 ? r2(totalProfit) : null,
        margin_pct: costedJobs > 0 ? marginOf(costedRev, totalProfit) : null,
        rev_per_visit: totalJobs > 0 ? r2(totalRevenue / totalJobs) : 0,
        // Coverage drives the on-screen caveat. When it is short of every job,
        // the margin above describes a subset and the page has to say so.
        jobs_costed: costedJobs,
        revenue_costed: r2(costedRev),
        coverage_pct: totalJobs > 0 ? (costedJobs / totalJobs) * 100 : 0,
      },
      data,
      page, page_size: pageSize, total_rows: all.length,
      total_pages: Math.max(1, Math.ceil(all.length / pageSize)),
      by_service: cutOut(byService),
      by_zone: cutOut(byZone),
      by_frequency: cutOut(byFreq),
    });
  } catch (err) {
    console.error("Client profitability error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── COMMERCIAL ACCOUNTS ─────────────────────────────────────────────────────
// [commercial-accounts 2026-08-17] Every commercial account ranked side by side.
// Client Profitability already lists accounts and can filter to commercial, but
// it is a customer report and carries customer columns — it has no view of the
// two numbers a commercial book actually turns on: the HOURS a job was budgeted
// and the hours it took. On a commission-per-allowed-hour shop that gap IS the
// margin, and nothing in Reports showed it per account.
//
// Definitions, all borrowed rather than invented, so this report cannot disagree
// with the ones beside it:
//   • Commercial = `jobs.account_id IS NOT NULL`. That is what the commission
//     engine routes on, so it means the same thing here.
//   • Revenue = coalesce(billed_amount, base_fee), the one waterfall.
//   • Completed work only, as Client Profitability and Job Costing do. Booked-
//     but-not-yet-worked visits belong to the revenue reports, not to a margin.
//   • Labor = computePeriodPayLines, the paycheck engine. Same source as Job
//     Costing, so the same job cannot cost two different amounts.
//
// Three separate kinds of "we do not know", each tracked and never rounded to
// zero: a job with no allowed_hours has no BUDGET, a job with no clock-out has
// no ACTUAL, and a job the pay engine skipped has no LABOR. An account is only
// given an efficiency, or a margin, over the jobs where that figure exists.
//
// Efficiency is the canonical one: allowed ÷ actual, over 100% meaning the crew
// came in under budget. Actual counts EVERY cleaner clocked on the job, not just
// the one on `assigned_user_id` — allowed_hours budgets the whole crew, so the
// denominator has to be the whole crew. (Note: /efficiency joins the assigned
// cleaner only, which reads high on multi-cleaner commercial work.)
router.get("/commercial-accounts", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    let fromStr = (req.query.from as string) || dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
    const toStr   = (req.query.to   as string) || dateStr(now);
    // [reporting-floor 2026-08-17] Pre-cutover work is MaidCentral's record, not Qleno's.
    const { fromStr: floorFrom, clamp: rangeClamp } = await clampFrom(companyId, fromStr, toStr);
    fromStr = floorFrom;

    const sortKey = (req.query.sort as string) || "revenue";
    const sortDir = (req.query.dir  as string) === "asc" ? "asc" : "desc";

    // One row per job, with the whole crew's clocked hours folded in. A single
    // GROUP BY rather than a correlated subquery per job — this has to stay one
    // query no matter how many accounts a tenant grows into.
    const jobRows = await db.execute(sql`
      SELECT
        j.id, j.account_id, j.account_property_id,
        -- pg hands a DATE back as a JS Date, so format it here. Slicing the
        -- stringified Date yields "Wed Jul 29" and breaks date comparison.
        to_char(j.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
        j.allowed_hours,
        ${EFFECTIVE_AMOUNT_SQL("j")} AS effective_amount,
        coalesce(sum(EXTRACT(EPOCH FROM (t.clock_out_at - t.clock_in_at))/3600)
                 FILTER (WHERE t.clock_out_at IS NOT NULL), 0) AS crew_hours,
        count(t.id) FILTER (WHERE t.clock_out_at IS NOT NULL)  AS clock_rows
      FROM jobs j
      LEFT JOIN timeclock t ON t.job_id = j.id
      WHERE j.company_id = ${companyId}
        ${branchFilter(req, "j.branch_id")}
        AND j.account_id IS NOT NULL
        AND j.status = 'complete'
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      GROUP BY j.id
    `);

    // Every account on the books, not only the ones that worked. An active
    // account with no completed visit in the window is the single most useful
    // row on this screen — a customer that quietly stopped calling — and it can
    // only appear if the list starts from `accounts` rather than from `jobs`.
    const accountRows = await db.execute(sql`
      SELECT a.id, a.account_name, a.is_active, a.account_type,
             a.invoice_frequency, a.payment_terms_days, a.payment_method
        FROM accounts a
       WHERE a.company_id = ${companyId}
       ORDER BY a.account_name
    `);

    // For the dormant list: when did this account last actually get work? Inside
    // the window it has none by definition, so the useful date is the last one
    // BEFORE it — that is what turns "no visits" into "stopped calling in May".
    const lastBefore = await db.execute(sql`
      SELECT j.account_id, to_char(max(j.scheduled_date), 'YYYY-MM-DD') AS last_visit
        FROM jobs j
       WHERE j.company_id = ${companyId}
         AND j.account_id IS NOT NULL
         AND j.status = 'complete'
         AND j.scheduled_date < ${fromStr}
       GROUP BY j.account_id
    `);
    const lastBeforeByAccount = new Map<number, string>(
      (lastBefore.rows as any[]).map(r => [Number(r.account_id), String(r.last_visit).slice(0, 10)]),
    );

    const { lines: costLines } = await computePeriodPayLines(companyId, fromStr, toStr);
    const laborByJob = new Map<number, number>();
    for (const l of costLines) laborByJob.set(l.job_id, (laborByJob.get(l.job_id) ?? 0) + (l.amount || 0));

    type Acc = {
      visits: number; revenue: number;
      properties: Set<number>;
      budget_hours: number; jobs_budgeted: number;
      actual_hours: number; jobs_clocked: number;
      // [efficiency-matched-pair 2026-08-17] The two halves of the ratio, over
      // the jobs that carry BOTH. See the accumulator below.
      measured_budget: number; measured_actual: number; jobs_measured: number;
      labor: number; jobs_costed: number; revenue_costed: number;
      first_visit: string | null; last_visit: string | null;
    };
    const blank = (): Acc => ({
      visits: 0, revenue: 0, properties: new Set(),
      budget_hours: 0, jobs_budgeted: 0,
      actual_hours: 0, jobs_clocked: 0,
      measured_budget: 0, measured_actual: 0, jobs_measured: 0,
      labor: 0, jobs_costed: 0, revenue_costed: 0,
      first_visit: null, last_visit: null,
    });

    const byAccount = new Map<number, Acc>();
    for (const r of jobRows.rows as any[]) {
      const id = Number(r.account_id);
      let a = byAccount.get(id);
      if (!a) { a = blank(); byAccount.set(id, a); }

      a.visits += 1;
      a.revenue += parseF(r.effective_amount);
      if (r.account_property_id != null) a.properties.add(Number(r.account_property_id));

      // Budget present or absent — never defaulted. A blank allowed_hours on a
      // commercial job has already cost this business real money once (it paid
      // $20 × 0), so it is surfaced here rather than absorbed.
      const hasBudget = r.allowed_hours != null;
      const hasClock  = parseN(r.clock_rows) > 0;
      if (hasBudget) { a.budget_hours += parseF(r.allowed_hours); a.jobs_budgeted += 1; }
      if (hasClock)  { a.actual_hours += parseF(r.crew_hours);    a.jobs_clocked  += 1; }

      // [efficiency-matched-pair 2026-08-17] Efficiency is a RATIO, so both
      // halves have to describe the same visits. A visit missing either one
      // cannot be in it: no clock puts its budget over no hours (inflates), no
      // budget puts its hours under no budget (deflates). Both were happening.
      // This is the same rule /reports/efficiency scores on, so the two reports
      // cannot disagree about the same jobs. Budget and hours are still totalled
      // in full above; they just aren't what the percentage is made of.
      if (hasBudget && hasClock) {
        a.measured_budget += parseF(r.allowed_hours);
        a.measured_actual += parseF(r.crew_hours);
        a.jobs_measured   += 1;
      }

      if (laborByJob.has(Number(r.id))) {
        a.jobs_costed += 1;
        a.revenue_costed += parseF(r.effective_amount);
        a.labor += laborByJob.get(Number(r.id))!;
      }

      const d = String(r.scheduled_date).slice(0, 10);
      if (!a.first_visit || d < a.first_visit) a.first_visit = d;
      if (!a.last_visit  || d > a.last_visit)  a.last_visit  = d;
    }

    const r2 = (n: number) => Math.round(n * 100) / 100;

    let data = (accountRows.rows as any[]).map(row => {
      const id = Number(row.id);
      const a  = byAccount.get(id) ?? blank();
      const costed    = a.jobs_costed > 0;
      const profit    = a.revenue_costed - a.labor;
      const budgeted  = a.jobs_budgeted > 0;
      const clocked   = a.jobs_clocked  > 0;

      return {
        id, name: row.account_name || `Account ${id}`,
        is_active: row.is_active !== false,
        account_type: row.account_type ?? null,
        invoice_frequency: row.invoice_frequency ?? null,
        payment_terms_days: row.payment_terms_days ?? null,
        payment_method: row.payment_method ?? null,

        visits: a.visits,
        properties: a.properties.size,
        revenue: r2(a.revenue),
        rev_per_visit: a.visits > 0 ? r2(a.revenue / a.visits) : null,

        budget_hours: budgeted ? r2(a.budget_hours) : null,
        actual_hours: clocked  ? r2(a.actual_hours) : null,
        // Over 100% = came in under budget. Built only from visits carrying a
        // budget AND a clock; null when no visit here can be scored, because
        // "nothing measurable" is not 0% efficient.
        efficiency_pct: a.jobs_measured > 0 && a.measured_actual > 0
          ? (a.measured_budget / a.measured_actual) * 100 : null,
        measured_budget_hours: a.jobs_measured > 0 ? r2(a.measured_budget) : null,
        measured_actual_hours: a.jobs_measured > 0 ? r2(a.measured_actual) : null,
        jobs_measured: a.jobs_measured,
        // What an hour of budgeted time actually bills at — the number to
        // compare one commercial contract against another.
        rev_per_budget_hour: budgeted && a.budget_hours > 0 ? r2(a.revenue / a.budget_hours) : null,

        labor:      costed ? r2(a.labor) : null,
        profit:     costed ? r2(profit) : null,
        margin_pct: costed && a.revenue_costed > 0 ? (profit / a.revenue_costed) * 100 : null,

        // Coverage, so the page can caveat any row whose figures cover only
        // part of its work rather than presenting them as the whole picture.
        jobs_budgeted: a.jobs_budgeted,
        jobs_clocked:  a.jobs_clocked,
        jobs_costed:   a.jobs_costed,
        revenue_costed: r2(a.revenue_costed),

        first_visit: a.first_visit, last_visit: a.last_visit,
      };
    });

    // Accounts with no completed visit in the window are kept, but they are not
    // part of the ranking — they are the dormant list, reported separately so a
    // page of zeros never sits between two real rows.
    const dormant = data.filter(d => d.visits === 0 && d.is_active);
    data = data.filter(d => d.visits > 0);

    const sum_ = (f: (d: typeof data[number]) => number | null) =>
      data.reduce((s, d) => s + (f(d) ?? 0), 0);
    const totalRevenue  = sum_(d => d.revenue);
    const totalVisits   = data.reduce((s, d) => s + d.visits, 0);
    // Summed from the raw accumulators, not from the per-row rounded figures —
    // rounding each account to two decimals first and then adding would land a
    // few cents away from the same total computed anywhere else.
    const raw = (f: (a: Acc) => number) =>
      data.reduce((s, d) => s + (byAccount.has(d.id) ? f(byAccount.get(d.id)!) : 0), 0);
    const totalBudget   = raw(a => a.budget_hours);
    const totalActual   = raw(a => a.actual_hours);
    const totalLabor    = sum_(d => d.labor);
    const costedRev     = sum_(d => d.revenue_costed);
    const jobsBudgeted  = data.reduce((s, d) => s + d.jobs_budgeted, 0);
    const jobsClocked   = data.reduce((s, d) => s + d.jobs_clocked, 0);
    const jobsMeasured  = data.reduce((s, d) => s + d.jobs_measured, 0);
    const measBudget    = raw(a => a.measured_budget);
    const measActual    = raw(a => a.measured_actual);
    const jobsCosted    = data.reduce((s, d) => s + d.jobs_costed, 0);
    const totalProfit   = costedRev - totalLabor;

    const SORTS: Record<string, (d: typeof data[number]) => number | string | null> = {
      revenue: d => d.revenue, visits: d => d.visits, profit: d => d.profit,
      margin: d => d.margin_pct, efficiency: d => d.efficiency_pct,
      rev_per_visit: d => d.rev_per_visit, rev_per_budget_hour: d => d.rev_per_budget_hour,
      hours: d => d.actual_hours, last_visit: d => d.last_visit || "",
      name: d => d.name.toLowerCase(),
    };
    const pick = SORTS[sortKey] || SORTS.revenue;
    data.sort((a, b) => {
      const x = pick(a), y = pick(b);
      // Unknowns sink in both directions — sorting by worst margin should
      // surface the genuinely thin accounts, not the uncosted ones.
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const cmp = typeof x === "string" || typeof y === "string"
        ? String(x).localeCompare(String(y))
        : (x as number) - (y as number);
      return sortDir === "asc" ? cmp : -cmp;
    });

    // Concentration: how much of the commercial book rides on the top account.
    const top = data.length ? data.reduce((m, d) => (d.revenue > m.revenue ? d : m), data[0]!) : null;

    return res.json({
      range_clamped: rangeClamp,
      from: fromStr, to: toStr,
      summary: {
        accounts: data.length,
        dormant_accounts: dormant.length,
        visits: totalVisits,
        total_revenue: r2(totalRevenue),
        rev_per_visit: totalVisits > 0 ? r2(totalRevenue / totalVisits) : null,
        budget_hours: jobsBudgeted > 0 ? r2(totalBudget) : null,
        actual_hours: jobsClocked  > 0 ? r2(totalActual) : null,
        efficiency_pct: jobsMeasured > 0 && measActual > 0
          ? (measBudget / measActual) * 100 : null,
        measured_budget_hours: jobsMeasured > 0 ? r2(measBudget) : null,
        measured_actual_hours: jobsMeasured > 0 ? r2(measActual) : null,
        jobs_measured: jobsMeasured,
        total_labor:  jobsCosted > 0 ? r2(totalLabor) : null,
        total_profit: jobsCosted > 0 ? r2(totalProfit) : null,
        margin_pct:   jobsCosted > 0 && costedRev > 0 ? (totalProfit / costedRev) * 100 : null,
        jobs_budgeted: jobsBudgeted, jobs_clocked: jobsClocked, jobs_costed: jobsCosted,
        coverage_pct: totalVisits > 0 ? (jobsCosted / totalVisits) * 100 : 0,
        top_account: top ? top.name : null,
        top_account_share_pct: top && totalRevenue > 0 ? (top.revenue / totalRevenue) * 100 : null,
      },
      data,
      dormant: dormant.map(d => ({
        id: d.id, name: d.name,
        last_visit: lastBeforeByAccount.get(d.id) ?? null,
        invoice_frequency: d.invoice_frequency,
      })),
    });
  } catch (err) {
    console.error("Commercial accounts error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── PAYROLL % TO REVENUE ────────────────────────────────────────────────────
router.get("/payroll-to-revenue", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();

    // Last 12 weeks
    const allWeeks = [];
    for (let i = 11; i >= 0; i--) {
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay() - i * 7);
      weekStart.setHours(0,0,0,0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      allWeeks.push({ start: dateStr(weekStart), end: dateStr(weekEnd) });
    }
    // [reporting-floor 2026-08-17] A twelve-week window reaches back past the
    // cutover, and a pre-cutover week has Qleno revenue near zero against real
    // payroll — which renders as a labor ratio of several hundred percent and
    // reads as a payroll crisis that never happened. Drop any week that starts
    // before the floor rather than charting a ratio built from two different
    // systems. A week straddling the boundary is kept: its start is on or after
    // the floor, so both halves of the ratio come from Qleno.
    const p2rFloor = await reportingFloor(companyId);
    const weeks = p2rFloor ? allWeeks.filter(w => w.start >= p2rFloor) : allWeeks;
    const weeksDropped = allWeeks.length - weeks.length;
    if (weeks.length === 0) {
      return res.json({
        weeks: [], current: null, status: "low",
        range_clamped: { requested_from: allWeeks[0].start, effective_from: p2rFloor!, floor: p2rFloor!, entire_range_before: true },
      });
    }

    // [pay-model-parity 2026-07-04] Payroll comes from the paycheck engine
    // (computePeriodPayLines) over the whole 12-week span, bucketed per week by
    // the job's scheduled_date — NOT the old per-EMPLOYEE pay_type CASE (no
    // allowed_hours branch, primary tech only). One engine pass; filter lines by
    // the requested branch so a per-branch labor % still ties out.
    const p2rBranchRaw = req.query.branch_id as string | undefined;
    const p2rBranch = p2rBranchRaw && p2rBranchRaw !== "all" && Number.isFinite(parseInt(p2rBranchRaw, 10)) ? parseInt(p2rBranchRaw, 10) : null;
    const spanStart = weeks[0].start;
    const spanEnd = weeks[weeks.length - 1].end;
    const { lines: p2rLines } = await computePeriodPayLines(companyId, spanStart, spanEnd);
    const payrollByWeek = new Map<string, number>();
    for (const l of p2rLines) {
      if (p2rBranch != null && l.branch_id !== p2rBranch) continue;
      const d = String(l.scheduled_date).slice(0, 10);
      const w = weeks.find(w => d >= w.start && d <= w.end);
      if (w) payrollByWeek.set(w.start, (payrollByWeek.get(w.start) ?? 0) + (l.amount || 0));
    }

    const weekData = await Promise.all(weeks.map(async w => {
      const revRow = await db.execute(sql`
        SELECT coalesce(sum(${EFFECTIVE_AMOUNT_SQL()}), 0) AS revenue, count(*) AS jobs
        FROM jobs WHERE company_id=${companyId} AND status='complete'
          ${branchFilter(req)}
          AND scheduled_date BETWEEN ${w.start} AND ${w.end}
      `);
      // additional_pay has no branch_id today (per Step 4 punch list). It's
      // tied to user_id + date, and adding a branch column would need its own
      // backfill — out of scope for this pass. So per-branch payroll % excludes
      // tips/bonuses for now; non-branch view is unchanged.
      const addPayRow = await db.execute(sql`
        SELECT coalesce(sum(amount), 0) AS add_pay FROM additional_pay
        WHERE company_id=${companyId} AND status <> 'voided'
          AND ${payDaySql("additional_pay")} BETWEEN ${w.start} AND ${w.end}
      `);

      const revenue = parseF((revRow.rows[0] as any)?.revenue);
      const payroll = (payrollByWeek.get(w.start) ?? 0) + parseF((addPayRow.rows[0] as any)?.add_pay);
      const pct     = revenue > 0 ? (payroll / revenue) * 100 : 0;
      return { week: w.start, revenue, payroll, pct, jobs: parseN((revRow.rows[0] as any)?.jobs) };
    }));

    const currentWeek = weekData[weekData.length - 1];
    const status = currentWeek.pct > 45 ? "critical" : currentWeek.pct > 40 ? "high" : currentWeek.pct >= 30 ? "healthy" : "low";

    return res.json({
      weeks: weekData, current: currentWeek, status,
      range_clamped: weeksDropped > 0
        ? { requested_from: allWeeks[0].start, effective_from: weeks[0].start, floor: p2rFloor!, entire_range_before: false }
        : null,
    });
  } catch (err) {
    console.error("Payroll-to-revenue error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── PAYROLL SUMMARY ─────────────────────────────────────────────────────────
router.get("/payroll", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - now.getDay() + 1);
    let fromStr = (req.query.from as string) || dateStr(monday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const toStr = (req.query.to as string) || dateStr(sunday);
    // [reporting-floor 2026-08-17] Pre-cutover work is MaidCentral's record, not Qleno's.
    const { fromStr: floorFrom, clamp: rangeClamp } = await clampFrom(companyId, fromStr, toStr);
    fromStr = floorFrom;

    // Filter the employee list by home_branch_id when a specific branch is
    // requested. Techs without a home_branch (legacy NULLs) are still surfaced
    // when "all" is selected; the per-employee job query below also branch-
    // filters so an Oak Lawn tech who did Schaumburg jobs won't double-count.
    // `users.pay_rate` / `pay_type` are deliberately NOT selected. Every active
    // cleaner carries a stale `pay_type='hourly'` label with a $15–$20 rate
    // beside it, left over from an early schema; Phes pays commission. Nothing
    // on this report may compute from those two columns.
    const employees = await db.select({ id: usersTable.id, first_name: usersTable.first_name, last_name: usersTable.last_name })
      .from(usersTable).where(and(eq(usersTable.company_id, companyId), eq(usersTable.is_active, true), ne(usersTable.role, "owner"), branchCond(req, usersTable.home_branch_id)));

    // [pay-model-parity 2026-07-04] Pay comes from the SAME engine that cuts the
    // paychecks (routes/payroll.ts /detail), via computePeriodPayLines — NOT the
    // old per-EMPLOYEE pay_type CASE, which had no allowed_hours branch and only
    // credited the primary tech, so commercial/PPM jobs and helper splits scored
    // $0 (Hilda 7/1–3: report $0 vs actual $430). Sum engine `amount` per user;
    // filter lines by the requested branch so a per-branch view still ties out.
    const branchRaw = req.query.branch_id as string | undefined;
    const branchNum = branchRaw && branchRaw !== "all" && Number.isFinite(parseInt(branchRaw, 10)) ? parseInt(branchRaw, 10) : null;
    const { lines: payLines, jobs: payJobs } = await computePeriodPayLines(companyId, fromStr, toStr);
    const allowedHoursByJob = new Map<number, number>(payJobs.map(j => [j.id, parseF(j.allowed_hours ?? j.actual_hours ?? 0)]));
    const basePayByUser = new Map<number, number>();
    const jobIdsByUser = new Map<number, Set<number>>();
    const basesByUser = new Map<number, Set<string>>();
    for (const l of payLines) {
      if (branchNum != null && l.branch_id !== branchNum) continue;
      basePayByUser.set(l.user_id, (basePayByUser.get(l.user_id) ?? 0) + (l.amount || 0));
      if (!jobIdsByUser.has(l.user_id)) jobIdsByUser.set(l.user_id, new Set());
      jobIdsByUser.get(l.user_id)!.add(l.job_id);
      if (!basesByUser.has(l.user_id)) basesByUser.set(l.user_id, new Set());
      basesByUser.get(l.user_id)!.add(l.isCommercial ? "commercial_hourly" : "residential_commission");
    }
    // How each person earned, read off the pay lines instead of asserted from a
    // stale column. Commission is never hourly pay.
    const payBasisOf = (uid: number): string => {
      const b = basesByUser.get(uid);
      if (!b || b.size === 0) return "none";
      return b.size > 1 ? "mixed" : [...b][0];
    };

    // [overtime-one-engine 2026-08-17] Overtime premium from the shared engine:
    // jurisdiction-aware thresholds, hours worked = clocked job time PLUS the
    // between-jobs drive that counts under 29 CFR 785.38, and a regular rate
    // derived from what the week actually paid. An ESTIMATE for office review —
    // Qleno does not run payroll and this moves no money.
    let premiumByUser = new Map<number, number>();
    let overtimeAvailable = true;
    try {
      premiumByUser = (await computeOvertimeEstimate(companyId, fromStr, toStr)).premiumByUser;
    } catch (err) {
      // Never guess a premium. Report it as unavailable instead.
      console.error("Payroll summary: overtime estimate failed:", err);
      overtimeAvailable = false;
    }

    const rows = await Promise.all(employees.map(async emp => {
      const clockRes = await db.execute(sql`
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (clock_out_at - clock_in_at))/3600), 0) AS clock_hours,
          COUNT(*) FILTER (WHERE clock_out_at IS NULL) AS missing_outs,
          COUNT(DISTINCT scheduled_date::date) AS days_worked
        FROM timeclock t JOIN jobs j ON j.id = t.job_id
        WHERE t.company_id=${companyId} AND t.user_id=${emp.id}
          ${branchFilter(req, "t.branch_id")}
          AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      `);

      const addPayRes = await db.execute(sql`
        SELECT type, coalesce(sum(amount), 0) AS total FROM additional_pay
        WHERE company_id=${companyId} AND user_id=${emp.id}
          AND status <> 'voided'
          AND ${payDaySql("additional_pay")} BETWEEN ${fromStr} AND ${toStr}
        GROUP BY type
      `);

      const clk  = clockRes.rows[0] as any;
      const addPay = addPayRes.rows as any[];
      // Pay + job attribution now come from the engine (per-tech clocked split),
      // not a primary-only assigned_user_id join.
      const myJobIds = jobIdsByUser.get(emp.id) ?? new Set<number>();
      const base_pay = Math.round((basePayByUser.get(emp.id) ?? 0) * 100) / 100;
      const tips     = addPay.filter(p => p.type === "tips").reduce((s, p) => s + parseF(p.total), 0);
      // Mileage is a reimbursement, not wages (29 CFR 778.217) — it gets its own
      // column and never lands in a pay figure or an hourly rate.
      const byType: Record<string, number> = {};
      for (const p of addPay) if (p.type !== "tips") byType[p.type] = (byType[p.type] ?? 0) + parseF(p.total);
      const { additional: add_pay, mileage } = splitAdditionalPay(byType);
      const job_hrs  = [...myJobIds].reduce((s, id) => s + (allowedHoursByJob.get(id) ?? 0), 0);
      const clk_hrs  = parseF(clk?.clock_hours);
      // null, not 0, when the estimate could not run — an unavailable number is
      // not the same claim as "no overtime is owed".
      const overtime = overtimeAvailable ? (premiumByUser.get(emp.id) ?? 0) : null;
      const gross_pay = base_pay + tips + add_pay + (overtime ?? 0);

      return {
        id: emp.id, name: `${emp.first_name} ${emp.last_name}`,
        // Replaces `pay_type`, which reported the stale schema label.
        pay_basis: payBasisOf(emp.id),
        days_worked: parseN(clk?.days_worked), job_hours: job_hrs, clock_hours: clk_hrs,
        base_pay, tips, additional_pay: add_pay, mileage, overtime, deductions: 0,
        // Wages only. Mileage is paid on top and is reported beside it.
        gross_pay,
        total_payout: Math.round((gross_pay + mileage) * 100) / 100,
        // The spec's required label for this figure is "Effective earnings per
        // recorded job hour" — it is what the commission worked out to, NOT an
        // hourly wage. Unavailable rather than 0 when nothing was clocked.
        effective_per_job_hour: clk_hrs > 0 ? Math.round((base_pay / clk_hrs) * 100) / 100 : null,
        missing_clk_outs: parseN(clk?.missing_outs), jobs_count: myJobIds.size,
      };
    }));

    // Flags
    const missingClocks = await db.execute(sql`
      SELECT j.id, c.first_name, c.last_name, j.scheduled_date, j.service_type
      FROM jobs j JOIN clients c ON c.id=j.client_id
      LEFT JOIN timeclock t ON t.job_id=j.id
      WHERE j.company_id=${companyId} AND j.status='complete'
        ${branchFilter(req, "j.branch_id")}
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr} AND t.id IS NULL LIMIT 20
    `);
    const unclockedOut = await db.execute(sql`
      SELECT u.first_name, u.last_name, t.clock_in_at FROM timeclock t JOIN users u ON u.id=t.user_id
      WHERE t.company_id=${companyId} AND t.clock_out_at IS NULL
        ${branchFilter(req, "t.branch_id")}
        AND t.clock_in_at::date BETWEEN ${fromStr} AND ${toStr} LIMIT 20
    `);

    return res.json({
      range_clamped: rangeClamp,
      from: fromStr, to: toStr, employees: rows,
      // An estimate the office reviews, not a payroll run. Qleno cuts no checks.
      overtime_available: overtimeAvailable,
      totals: {
        base_pay: rows.reduce((s, r) => s + r.base_pay, 0),
        tips: rows.reduce((s, r) => s + r.tips, 0),
        additional_pay: rows.reduce((s, r) => s + r.additional_pay, 0),
        mileage: rows.reduce((s, r) => s + r.mileage, 0),
        overtime: overtimeAvailable ? rows.reduce((s, r) => s + (r.overtime ?? 0), 0) : null,
        gross_pay: rows.reduce((s, r) => s + r.gross_pay, 0),
        total_payout: rows.reduce((s, r) => s + r.total_payout, 0),
      },
      flags: {
        missing_clocks: missingClocks.rows,
        unclocked_out: unclockedOut.rows,
      },
    });
  } catch (err) {
    console.error("Payroll summary error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── SCHEDULE EFFICIENCY ──────────────────────────────────────────────────────
router.get("/efficiency", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    let fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);
    // [reporting-floor 2026-08-17] Pre-cutover work is MaidCentral's record, not Qleno's.
    const { fromStr: floorFrom, clamp: rangeClamp } = await clampFrom(companyId, fromStr, toStr);
    fromStr = floorFrom;

    // [efficiency-whole-crew 2026-08-17] This used to join
    // `t.user_id = j.assigned_user_id`, counting ONE cleaner's clock per job.
    // allowed_hours budgets the whole crew, so on a two- or three-cleaner job
    // the denominator was missing most of the hours actually worked and the
    // ratio came out far too high — the report read "under budget" on jobs that
    // ran over it. It also double-counted a job's allowed hours whenever that
    // one cleaner had two clock entries on it (a split shift fans the join out).
    //
    // Both are fixed by aggregating the clock per job FIRST, then joining one
    // row to one job. `jc` is per person per job; `crew` collapses that to the
    // job. Nothing else in the query changes shape.
    const CLOCK_CTE = sql`
      jc AS (
        SELECT t.job_id, t.user_id,
               sum(EXTRACT(EPOCH FROM (t.clock_out_at - t.clock_in_at))/3600) AS hours
          FROM timeclock t
         WHERE t.clock_out_at IS NOT NULL
         GROUP BY t.job_id, t.user_id
      ),
      crew AS (
        SELECT job_id, count(*)::int AS crew_size, sum(hours) AS crew_hours
          FROM jc GROUP BY job_id
      )`;

    // [efficiency-matched-pair 2026-08-17] Efficiency is a RATIO, so both halves
    // have to describe the same jobs. A job missing either half cannot be in it:
    //   - no clock  → its budget over no hours, which inflates the ratio
    //   - no budget → its hours under no budget, which deflates the ratio
    // Both were happening. `MEASURED` is the one definition of a job that can be
    // scored, and it is the only filter the ratio is ever built from — here and
    // in /reports/commercial-accounts, so the two reports cannot disagree.
    // Total budget and total hours are still reported in full; they just aren't
    // what the percentage is made of.
    const MEASURED = sql`(j.allowed_hours IS NOT NULL AND crew.job_id IS NOT NULL)`;

    const byDay = await db.execute(sql`
      WITH ${CLOCK_CTE}
      SELECT
        to_char(j.scheduled_date, 'YYYY-MM-DD') AS date,
        count(j.id) AS jobs,
        count(j.id) FILTER (WHERE ${MEASURED}) AS jobs_measured,
        coalesce(sum(j.allowed_hours), 0) AS allowed_hours,
        coalesce(sum(crew.crew_hours), 0) AS clock_hours,
        coalesce(sum(j.allowed_hours)  FILTER (WHERE ${MEASURED}), 0) AS measured_allowed,
        coalesce(sum(crew.crew_hours)  FILTER (WHERE ${MEASURED}), 0) AS measured_clock
      FROM jobs j
      LEFT JOIN crew ON crew.job_id = j.id
      WHERE j.company_id=${companyId} AND j.status='complete'
        ${branchFilter(req, "j.branch_id")}
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      GROUP BY j.scheduled_date ORDER BY j.scheduled_date
    `);

    // Per person, the budget is the job's allowed hours split EQUALLY across
    // everyone who clocked on it. Everyone was given the same share of the
    // budget, so who used more than their share is a real distinction between
    // cleaners. (Splitting proportionally by actual minutes instead would hand
    // every crew member the job's own ratio and tell you nothing about any of
    // them individually.)
    //
    // Only jobs a person actually clocked count here. Attributing a whole job's
    // budget to someone with no clock record produced a 0% efficiency row that
    // described missing data, not slow work. Their percentage is built from the
    // same MEASURED pair as everything else: budget share and hours, over the
    // jobs that carry both.
    const byEmployee = await db.execute(sql`
      WITH ${CLOCK_CTE}
      SELECT
        u.id, u.first_name, u.last_name,
        count(DISTINCT j.id) AS jobs,
        count(DISTINCT j.id) FILTER (WHERE ${MEASURED}) AS jobs_measured,
        coalesce(sum(j.allowed_hours / crew.crew_size), 0) AS allowed_hours,
        coalesce(sum(jc.hours), 0) AS clock_hours,
        coalesce(sum(j.allowed_hours / crew.crew_size) FILTER (WHERE ${MEASURED}), 0) AS measured_allowed,
        coalesce(sum(jc.hours) FILTER (WHERE ${MEASURED}), 0) AS measured_clock
      FROM jobs j
      JOIN jc   ON jc.job_id = j.id
      JOIN crew ON crew.job_id = j.id
      JOIN users u ON u.id = jc.user_id
      WHERE j.company_id=${companyId} AND j.status='complete'
        ${branchFilter(req, "j.branch_id")}
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      GROUP BY u.id, u.first_name, u.last_name ORDER BY clock_hours DESC
    `);

    const totals = (byDay.rows as any[]).reduce((acc, r) => ({
      jobs: acc.jobs + parseN(r.jobs),
      jobsMeasured: acc.jobsMeasured + parseN(r.jobs_measured),
      allowed: acc.allowed + parseF(r.allowed_hours),
      clock: acc.clock + parseF(r.clock_hours),
      mAllowed: acc.mAllowed + parseF(r.measured_allowed),
      mClock: acc.mClock + parseF(r.measured_clock),
    }), { jobs: 0, jobsMeasured: 0, allowed: 0, clock: 0, mAllowed: 0, mClock: 0 });

    // null, not 0 — "no job in this range can be scored" is not 0% efficient.
    const eff = (allowed: number, clock: number) => (clock > 0 ? (allowed / clock) * 100 : null);

    return res.json({
      range_clamped: rangeClamp,
      from: fromStr, to: toStr,
      overall_efficiency: eff(totals.mAllowed, totals.mClock),
      total_jobs: totals.jobs,
      total_jobs_measured: totals.jobsMeasured,
      total_allowed_hours: totals.allowed,
      total_clock_hours: totals.clock,
      measured_allowed_hours: totals.mAllowed,
      measured_clock_hours: totals.mClock,
      by_day: (byDay.rows as any[]).map(r => ({
        date: r.date, jobs: parseN(r.jobs), jobs_measured: parseN(r.jobs_measured),
        allowed_hours: parseF(r.allowed_hours), clock_hours: parseF(r.clock_hours),
        efficiency_pct: eff(parseF(r.measured_allowed), parseF(r.measured_clock)),
      })),
      by_employee: (byEmployee.rows as any[]).map(r => ({
        id: r.id, name: `${r.first_name} ${r.last_name}`,
        jobs: parseN(r.jobs), jobs_measured: parseN(r.jobs_measured),
        allowed_hours: parseF(r.allowed_hours), clock_hours: parseF(r.clock_hours),
        efficiency_pct: eff(parseF(r.measured_allowed), parseF(r.measured_clock)),
      })),
    });
  } catch (err) {
    console.error("Efficiency error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── EMPLOYEE STATS ──────────────────────────────────────────────────────────
router.get("/employee-stats", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    let fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);
    // [reporting-floor 2026-08-17] Pre-cutover work is MaidCentral's record, not Qleno's.
    const { fromStr: floorFrom, clamp: rangeClamp } = await clampFrom(companyId, fromStr, toStr);
    fromStr = floorFrom;
    const userId  = req.query.user_id ? Number(req.query.user_id) : null;

    const empFilter = userId ? sql`AND u.id = ${userId}` : sql``;

    const rows = await db.execute(sql`
      SELECT
        u.id, u.first_name, u.last_name, u.avatar_url,
        count(DISTINCT j.id) AS jobs_completed,
        count(DISTINCT j.scheduled_date) AS days_worked,
        coalesce(sum(j.allowed_hours), 0) AS job_hours,
        coalesce(sum(EXTRACT(EPOCH FROM (t.clock_out_at - t.clock_in_at))/3600) FILTER (WHERE t.clock_out_at IS NOT NULL), 0) AS clock_hours,
        coalesce(sum(${EFFECTIVE_AMOUNT_SQL("j")}), 0) AS revenue_generated,
        -- [scorecard-dead-table 2026-08-08] rescaled: scorecard_entries stores a
        -- ratio against max_value, the legacy table stored a bare 0-4.
        coalesce(avg(sc.score_value / NULLIF(sc.max_value, 0) * 4) FILTER (WHERE sc.excluded=false), 0) AS scorecard_avg,
        coalesce(sum(ap.amount) FILTER (WHERE ap.type='tips'), 0) AS tips_earned,
        count(tc.id) FILTER (WHERE tc.flagged=true) AS flagged_clocks
      FROM users u
      LEFT JOIN jobs j ON j.assigned_user_id=u.id AND j.status='complete'
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
        ${branchFilter(req, "j.branch_id")}
      LEFT JOIN timeclock t ON t.job_id=j.id AND t.user_id=u.id
      -- [scorecard-dead-table 2026-08-08] was scorecards (legacy, never written)
      LEFT JOIN scorecard_entries sc ON sc.employee_id=u.id AND sc.company_id=${companyId}
        AND sc.excluded=false AND sc.dismissed_at IS NULL
        AND sc.entry_date BETWEEN ${fromStr} AND ${toStr}
      LEFT JOIN additional_pay ap ON ap.user_id=u.id AND ap.status <> 'voided'
        AND ${payDaySql("ap")} BETWEEN ${fromStr} AND ${toStr}
      LEFT JOIN timeclock tc ON tc.user_id=u.id AND tc.clock_in_at::date BETWEEN ${fromStr} AND ${toStr}
      WHERE u.company_id=${companyId} AND u.is_active=true ${empFilter}
      GROUP BY u.id ORDER BY revenue_generated DESC
    `);

    return res.json({
      range_clamped: rangeClamp,
      from: fromStr, to: toStr,
      data: (rows.rows as any[]).map(r => {
        const jobHrs = parseF(r.job_hours);
        const clkHrs = parseF(r.clock_hours);
        const eff = clkHrs > 0 ? (jobHrs / clkHrs) * 100 : 0;
        const att = 100 - Math.min(100, parseN(r.flagged_clocks) * 10);
        return {
          id: r.id, name: `${r.first_name} ${r.last_name}`, avatar_url: r.avatar_url,
          days_worked: parseN(r.days_worked), jobs_completed: parseN(r.jobs_completed),
          job_hours: jobHrs, clock_hours: clkHrs, efficiency_pct: eff,
          revenue_generated: parseF(r.revenue_generated), scorecard_avg: parseF(r.scorecard_avg),
          tips_earned: parseF(r.tips_earned), attendance_score: att,
        };
      }),
    });
  } catch (err) {
    console.error("Employee stats error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── TIPS REPORT ─────────────────────────────────────────────────────────────
router.get("/tips", requireAuth, requireRole("owner", "admin", "office", "technician"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const authUserId = req.auth!.userId!;
    const authRole   = req.auth!.role!;
    const isTech     = isTechnicianRole(authRole); // [trainee-role] trainee scoped to own tips, like a technician
    const now = new Date();
    let fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);
    // [reporting-floor 2026-08-17] Pre-cutover work is MaidCentral's record, not Qleno's.
    const { fromStr: floorFrom, clamp: rangeClamp } = await clampFrom(companyId, fromStr, toStr);
    fromStr = floorFrom;
    const userId  = isTech ? authUserId : (req.query.user_id ? Number(req.query.user_id) : null);

    const userFilter = userId ? sql`AND ap.user_id = ${userId}` : sql``;

    const rows = await db.execute(sql`
      SELECT
        ap.id, ap.amount, ap.type, ap.notes,
        -- [pay-day 2026-08-17] The tip's date is the day it PAYS OUT, not the
        -- moment the office typed it in. Those differ by a day for anything
        -- recorded after 7pm Central.
        ${payDaySql("ap")}::text AS pay_day,
        u.first_name AS emp_first, u.last_name AS emp_last,
        c.first_name AS client_first, c.last_name AS client_last,
        j.service_type, j.scheduled_date
      FROM additional_pay ap
      JOIN users u ON u.id=ap.user_id
      LEFT JOIN jobs j ON j.id=ap.job_id
      LEFT JOIN clients c ON c.id=j.client_id
      WHERE ap.company_id=${companyId} AND ap.type='tips'
        AND ap.status <> 'voided'
        AND ${payDaySql("ap")} BETWEEN ${fromStr} AND ${toStr}
        ${branchFilter(req, "j.branch_id")}
        ${userFilter}
      ORDER BY ${payDaySql("ap")} DESC, ap.id DESC LIMIT 500
    `);

    const data = (rows.rows as any[]).map(r => ({
      id: r.id, date: r.pay_day, amount: parseF(r.amount), type: r.type, notes: r.notes,
      employee_name: `${r.emp_first} ${r.emp_last}`,
      client_name: r.client_first ? `${r.client_first} ${r.client_last}` : null,
      service_type: r.service_type, job_date: r.scheduled_date,
    }));

    const totalTips = data.reduce((s, r) => s + r.amount, 0);
    return res.json({ from: fromStr, to: toStr, range_clamped: rangeClamp, data, summary: { total_tips: totalTips, avg_per_tip: data.length > 0 ? totalTips / data.length : 0, count: data.length } });
  } catch (err) {
    console.error("Tips error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── DISCOUNTS ───────────────────────────────────────────────────────────────
// Every discount applied to a job in the window (from job_discounts), so the
// office can see what's being given away and to whom.
router.get("/discounts", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    let fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);
    // [reporting-floor 2026-08-17] Pre-cutover work is MaidCentral's record, not Qleno's.
    const { fromStr: floorFrom, clamp: rangeClamp } = await clampFrom(companyId, fromStr, toStr);
    fromStr = floorFrom;
    const rows = await db.execute(sql`
      SELECT
        jd.id, jd.code, jd.type, jd.value, jd.amount, jd.reason, jd.created_at,
        u.first_name AS by_first, u.last_name AS by_last,
        c.first_name AS client_first, c.last_name AS client_last, c.company_name AS client_company,
        j.id AS job_id, j.service_type, j.scheduled_date
      FROM job_discounts jd
      JOIN jobs j ON j.id = jd.job_id
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN users u ON u.id = jd.applied_by
      WHERE jd.company_id = ${companyId}
        AND jd.created_at::date BETWEEN ${fromStr} AND ${toStr}
        ${branchFilter(req, "j.branch_id")}
      ORDER BY jd.created_at DESC LIMIT 1000
    `);
    const data = (rows.rows as any[]).map(r => ({
      id: r.id, date: r.created_at,
      code: r.code, type: r.type, value: parseF(r.value), amount: parseF(r.amount), reason: r.reason,
      applied_by: r.by_first ? `${r.by_first} ${r.by_last}`.trim() : null,
      client_name: r.client_first ? `${r.client_first} ${r.client_last}`.trim() : (r.client_company || null),
      job_id: r.job_id, service_type: r.service_type, job_date: r.scheduled_date,
    }));
    const total = data.reduce((s, r) => s + r.amount, 0);
    return res.json({
      range_clamped: rangeClamp,
      from: fromStr, to: toStr, data,
      summary: {
        total_discount: total, count: data.length,
        percent_count: data.filter(d => d.type === "percent").length,
        flat_count: data.filter(d => d.type === "flat").length,
      },
    });
  } catch (err) {
    console.error("Discounts report error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── FEES COLLECTED (cancellation + lockout) ─────────────────────────────────
// Every charged Cancel/Lockout in the window (from cancellation_log), so the
// office can see how much was collected in fees — a labeled subset of revenue
// (the fee already sits in jobs.billed_amount and counts in the Revenue total).
router.get("/fees", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    let fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);
    // [reporting-floor 2026-08-17] Pre-cutover work is MaidCentral's record, not Qleno's.
    const { fromStr: floorFrom, clamp: rangeClamp } = await clampFrom(companyId, fromStr, toStr);
    fromStr = floorFrom;
    const rows = await db.execute(sql`
      SELECT
        cl.id, cl.cancel_action, cl.customer_charge_amount, cl.cancelled_at,
        u.first_name AS by_first, u.last_name AS by_last,
        c.first_name AS client_first, c.last_name AS client_last, c.company_name AS client_company,
        j.id AS job_id, j.service_type, j.scheduled_date
      FROM cancellation_log cl
      JOIN jobs j ON j.id = cl.job_id
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN users u ON u.id = cl.cancelled_by
      WHERE cl.company_id = ${companyId}
        AND cl.cancel_action IN ('cancel','lockout')
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
        ${branchFilter(req, "j.branch_id")}
      ORDER BY j.scheduled_date DESC LIMIT 1000
    `);
    const data = (rows.rows as any[]).map(r => ({
      id: r.id, action: String(r.cancel_action),
      amount: parseF(r.customer_charge_amount),
      recorded_at: r.cancelled_at, job_date: r.scheduled_date,
      recorded_by: r.by_first ? `${r.by_first} ${r.by_last}`.trim() : null,
      client_name: r.client_first ? `${r.client_first} ${r.client_last}`.trim() : (r.client_company || null),
      job_id: r.job_id, service_type: r.service_type,
    }));
    const lockoutTotal = data.filter(d => d.action === "lockout").reduce((s, r) => s + r.amount, 0);
    const cancelTotal  = data.filter(d => d.action === "cancel").reduce((s, r) => s + r.amount, 0);
    return res.json({
      range_clamped: rangeClamp,
      from: fromStr, to: toStr, data,
      summary: {
        total_fees: Math.round((lockoutTotal + cancelTotal) * 100) / 100,
        lockout_fees: Math.round(lockoutTotal * 100) / 100,
        cancel_fees: Math.round(cancelTotal * 100) / 100,
        count: data.length,
        lockout_count: data.filter(d => d.action === "lockout").length,
        cancel_count: data.filter(d => d.action === "cancel").length,
      },
    });
  } catch (err) {
    console.error("Fees report error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── WEEK IN REVIEW ──────────────────────────────────────────────────────────
router.get("/week-review", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - now.getDay() + 1);
    monday.setHours(0,0,0,0);
    const thisStart = (req.query.week_start as string) || dateStr(monday);
    const thisEnd   = dateStr(new Date(new Date(thisStart).getTime() + 6 * 86400000));
    const prevStart = dateStr(new Date(new Date(thisStart).getTime() - 7 * 86400000));
    const prevEnd   = dateStr(new Date(new Date(thisStart).getTime() - 86400000));

    async function weekMetrics(start: string, end: string) {
      const rev = await db.execute(sql`SELECT coalesce(sum(${EFFECTIVE_AMOUNT_SQL()}),0) AS revenue, count(*) AS jobs, coalesce(avg(${EFFECTIVE_AMOUNT_SQL()}),0) AS avg_bill FROM jobs WHERE company_id=${companyId} AND status='complete' ${branchFilter(req)} AND scheduled_date BETWEEN ${start} AND ${end}`);
      // [scorecard-dead-table 2026-08-08] Was FROM scorecards — a legacy table
      // nothing writes to, so this averaged zero rows and Week in Review showed
      // "Quality Score 0.00/4" every week while the Scorecard report showed
      // 3.75/4 off real responses. Live ratings live in scorecard_entries.
      const qual = await db.execute(sql`
        SELECT coalesce(avg(score_value / NULLIF(max_value, 0) * 4), 0) AS avg
          FROM scorecard_entries
         WHERE company_id = ${companyId} AND excluded = false AND dismissed_at IS NULL
           AND entry_date BETWEEN ${start} AND ${end}`);
      const newC = await db.execute(sql`SELECT count(*) AS cnt FROM clients WHERE company_id=${companyId} AND created_at::date BETWEEN ${start} AND ${end}`);
      const staff = await db.execute(sql`SELECT count(*) AS cnt FROM users WHERE company_id=${companyId} AND is_active=true`);
      const r = rev.rows[0] as any;
      return {
        revenue: parseF(r?.revenue), jobs: parseN(r?.jobs), avg_bill: parseF(r?.avg_bill),
        quality_score: parseF((qual.rows[0] as any)?.avg),
        new_clients: parseN((newC.rows[0] as any)?.cnt),
        staff_count: parseN((staff.rows[0] as any)?.cnt),
      };
    }

    const [thisWeek, prevWeek] = await Promise.all([weekMetrics(thisStart, thisEnd), weekMetrics(prevStart, prevEnd)]);

    // Last 8 weeks revenue trend
    const trend = [];
    for (let i = 7; i >= 0; i--) {
      const wStart = dateStr(new Date(new Date(thisStart).getTime() - i * 7 * 86400000));
      const wEnd   = dateStr(new Date(new Date(wStart).getTime() + 6 * 86400000));
      // [scorecard-dead-table 2026-08-08] Same legacy table — the 8-week quality
      // trend was flat zero. DISTINCT-safe: scorecard_entries holds one row per
      // TECH per job, so a two-tech job would otherwise double-count its revenue.
      const r = await db.execute(sql`
        SELECT coalesce(sum(${EFFECTIVE_AMOUNT_SQL("j")}), 0) AS revenue,
               (SELECT coalesce(avg(se.score_value / NULLIF(se.max_value, 0) * 4), 0)
                  FROM scorecard_entries se
                  JOIN jobs j2 ON j2.id = se.job_id
                 WHERE se.company_id = ${companyId} AND se.excluded = false AND se.dismissed_at IS NULL
                   AND j2.scheduled_date BETWEEN ${wStart} AND ${wEnd}) AS quality
          FROM jobs j
         WHERE j.company_id = ${companyId} AND j.status = 'complete'
           ${branchFilter(req, "j.branch_id")}
           AND j.scheduled_date BETWEEN ${wStart} AND ${wEnd}`);
      trend.push({ week: wStart, revenue: parseF((r.rows[0] as any)?.revenue), quality: parseF((r.rows[0] as any)?.quality) });
    }

    const delta = (curr: number, prev: number) => prev > 0 ? ((curr - prev) / prev) * 100 : 0;
    return res.json({
      this_week: thisStart, prev_week: prevStart, this: thisWeek, prev: prevWeek,
      deltas: { revenue: delta(thisWeek.revenue, prevWeek.revenue), jobs: delta(thisWeek.jobs, prevWeek.jobs), quality: delta(thisWeek.quality_score, prevWeek.quality_score), avg_bill: delta(thisWeek.avg_bill, prevWeek.avg_bill) },
      trend,
    });
  } catch (err) {
    console.error("Week review error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── SCORECARDS ──────────────────────────────────────────────────────────────
router.get("/scorecards", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);

    const rows = await db.execute(sql`
      -- Column map, legacy → live: score → score_value/max_value rescaled to a
      -- 0-4 INTEGER (the distribution buckets below compare with ===, so a
      -- numeric string or a 0-1 ratio would put every row in "none"),
      -- comments → notes.
      SELECT sc.id,
        ROUND(sc.score_value / NULLIF(sc.max_value, 0) * 4)::int AS score,
        sc.notes AS comments, sc.excluded, sc.created_at,
        c.first_name AS client_first, c.last_name AS client_last,
        u.first_name AS emp_first, u.last_name AS emp_last,
        j.service_type, j.scheduled_date
      -- [scorecard-dead-table 2026-08-08] Was scorecards, which nothing writes
      -- to — this report returned 0 records while 28 real responses sat in
      -- scorecard_entries. There is no client_id on entries; the client comes
      -- through the job. Score is rescaled onto 0-4 (entries store a ratio).
      FROM scorecard_entries sc
      JOIN jobs j ON j.id=sc.job_id
      JOIN clients c ON c.id=j.client_id
      JOIN users u ON u.id=sc.employee_id
      WHERE sc.company_id=${companyId}
        AND sc.dismissed_at IS NULL
        ${branchFilter(req, "j.branch_id")}
        AND sc.entry_date BETWEEN ${fromStr} AND ${toStr}
      ORDER BY sc.entry_date DESC, sc.id DESC LIMIT 200
    `);

    const data = (rows.rows as any[]).map(r => ({
      id: r.id, score: r.score, comments: r.comments, excluded: r.excluded, date: r.created_at,
      client_name: `${r.client_first} ${r.client_last}`,
      employee_name: `${r.emp_first} ${r.emp_last}`,
      service_type: r.service_type, job_date: r.scheduled_date,
    }));

    const dist = [4,3,2,1,0].map(s => ({ score: s, count: data.filter(r => r.score === s).length }));
    const total = data.length;
    const avgScore = total > 0 ? data.reduce((s, r) => s + r.score, 0) / total : 0;

    return res.json({ from: fromStr, to: toStr, data, summary: { total, avg_score: avgScore, distribution: dist } });
  } catch (err) {
    console.error("Scorecards error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── CANCELLATIONS ───────────────────────────────────────────────────────────
router.get("/cancellations", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 90 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);

    const rows = await db.execute(sql`
      SELECT DISTINCT ON (j.client_id)
        c.id, c.first_name, c.last_name, c.email, c.created_at AS client_since,
        j.scheduled_date AS cancelled_date, j.base_fee AS bill_rate, j.notes AS cancel_notes,
        sc.score AS last_score
      FROM jobs j
      JOIN clients c ON c.id=j.client_id
      -- [scorecard-dead-table 2026-08-08] scorecard_entries has no client_id —
      -- the client is reached through the job. One row per TECH per job, so take
      -- the newest single entry rather than joining (which would duplicate the
      -- cancelled-job row once per tech).
      LEFT JOIN LATERAL (
        SELECT ROUND(se.score_value / NULLIF(se.max_value, 0) * 4)::int AS score
          FROM scorecard_entries se
          JOIN jobs sj ON sj.id = se.job_id
         WHERE sj.client_id = c.id AND se.company_id = ${companyId}
           AND se.excluded = false AND se.dismissed_at IS NULL
         ORDER BY se.entry_date DESC, se.id DESC LIMIT 1
      ) sc ON true
      WHERE j.company_id=${companyId} AND j.status='cancelled'
        ${branchFilter(req, "j.branch_id")}
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      ORDER BY j.client_id, j.scheduled_date DESC
    `);

    const data = (rows.rows as any[]).map(r => {
      const tenureDays = Math.floor((new Date(r.cancelled_date).getTime() - new Date(r.client_since).getTime()) / 86400000);
      return {
        id: r.id, name: `${r.first_name} ${r.last_name}`, email: r.email,
        client_since: r.client_since, cancelled_date: r.cancelled_date,
        tenure_days: tenureDays, bill_rate: parseF(r.bill_rate), last_score: r.last_score, notes: r.cancel_notes,
      };
    });

    // By-action breakdown — sourced from cancellation_log so we pick up
    // the charging actions (status='complete') that the legacy
    // `WHERE status='cancelled'` query above misses. Groups by
    // cancel_action so the UI can render "Lockout fees" / "Cancel fees"
    // as separate KPIs.
    const byActionRows = await db.execute(sql`
      SELECT COALESCE(cl.cancel_action, 'legacy') AS action,
             COUNT(*)::int AS count,
             COALESCE(SUM(cl.customer_charge_amount), 0)::text AS total_charged
        FROM cancellation_log cl
        JOIN jobs j ON j.id = cl.job_id
       WHERE cl.company_id = ${companyId}
         ${branchFilter(req, "j.branch_id")}
         AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
       GROUP BY cl.cancel_action
       ORDER BY action
    `);
    const by_action = (byActionRows.rows as any[]).map(r => ({
      action: r.action,
      count: r.count,
      total_charged: parseF(r.total_charged),
    }));
    const lockout_total = by_action.find(a => a.action === "lockout")?.total_charged ?? 0;
    const lockout_count = by_action.find(a => a.action === "lockout")?.count ?? 0;
    const cancel_total = by_action.find(a => a.action === "cancel")?.total_charged ?? 0;
    const cancel_count = by_action.find(a => a.action === "cancel")?.count ?? 0;
    const cancellation_revenue = by_action.reduce((s, a) => s + a.total_charged, 0);

    return res.json({
      from: fromStr, to: toStr, data,
      summary: {
        total: data.length,
        avg_tenure_days: data.length > 0 ? data.reduce((s, r) => s + r.tenure_days, 0) / data.length : 0,
        revenue_lost: data.reduce((s, r) => s + r.bill_rate, 0),
        // Cancellation-fee revenue (the money we DID collect from charging
        // cancellations) — sits alongside revenue_lost (the money we'd
        // have collected if the visits had happened).
        cancellation_revenue,
        lockout_total,
        lockout_count,
        cancel_total,
        cancel_count,
      },
      by_action,
    });
  } catch (err) {
    console.error("Cancellations error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── CONTACT TICKETS ─────────────────────────────────────────────────────────
// [redo-service 2026-07-10] Redos & Quality report — three views: by cleaner
// (accountability + redo rate), by client (repeat complaints + not-valid abuse
// flag), and by reason (category + area aggregation). Company-scoped, ROLE-gated.
router.get("/redos", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? "30")) || 30, 1), 365);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const byCleaner = await db.execute(sql`
      SELECT u.id AS employee_id,
             NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS name,
             u.hr_status,
             COUNT(*) FILTER (WHERE qc.valid) AS valid_count,
             COUNT(*) AS total_count,
             (SELECT COUNT(DISTINCT jt.job_id) FROM job_technicians jt JOIN jobs j2 ON j2.id = jt.job_id
               WHERE jt.user_id = u.id AND j2.company_id = ${companyId} AND j2.status = 'complete'
                 AND j2.scheduled_date >= ${cutoff}) AS jobs_done
      FROM quality_complaints qc JOIN users u ON u.id = qc.employee_id
      WHERE qc.company_id = ${companyId} AND qc.complaint_date >= ${cutoff}
      GROUP BY u.id, name, u.hr_status
      ORDER BY valid_count DESC, total_count DESC`);

    const byClient = await db.execute(sql`
      SELECT COALESCE(cl.id, a.id) AS client_id,
             COALESCE(NULLIF(TRIM(CONCAT(cl.first_name, ' ', cl.last_name)), ''), a.account_name, 'Unknown') AS name,
             COUNT(*) FILTER (WHERE qc.valid) AS valid_count,
             COUNT(*) FILTER (WHERE NOT qc.valid) AS invalid_count
      FROM quality_complaints qc
      JOIN jobs j ON j.id = qc.job_id
      LEFT JOIN clients cl ON cl.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
      WHERE qc.company_id = ${companyId} AND qc.complaint_date >= ${cutoff}
      -- [redos-groupby 2026-08-17] Group by ordinal, NOT by the output aliases.
      -- Postgres resolves a bare name in GROUP BY to an INPUT column before an
      -- output alias, and jobs.client_id exists — so "GROUP BY client_id" bound
      -- to j.client_id, left COALESCE(cl.id, a.id) ungrouped, and the whole
      -- report 500'd with 'column "cl.id" must appear in the GROUP BY clause'.
      -- Broken since #1010 (2026-07-10). The sibling byEmployee query above is
      -- safe only because no input column there is called "name".
      GROUP BY 1, 2
      ORDER BY valid_count DESC, invalid_count DESC`);

    const byCategory = await db.execute(sql`
      SELECT COALESCE(NULLIF(TRIM(reason_category), ''), 'Uncategorized') AS category, COUNT(*) AS n
      FROM quality_complaints qc
      WHERE qc.company_id = ${companyId} AND qc.complaint_date >= ${cutoff} AND qc.valid
      GROUP BY category ORDER BY n DESC`);

    const byArea = await db.execute(sql`
      SELECT TRIM(area) AS area, COUNT(*) AS n
      FROM quality_complaints qc, unnest(string_to_array(COALESCE(qc.areas, ''), ',')) AS area
      WHERE qc.company_id = ${companyId} AND qc.complaint_date >= ${cutoff} AND qc.valid AND TRIM(area) <> ''
      GROUP BY TRIM(area) ORDER BY n DESC LIMIT 12`);

    return res.json({
      days,
      by_cleaner: byCleaner.rows,
      by_client: byClient.rows,
      by_category: byCategory.rows,
      by_area: byArea.rows,
    });
  } catch (err) {
    console.error("[reports/redos]", err);
    return res.status(500).json({ error: "Failed to load redos report" });
  }
});

router.get("/contact-tickets", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);
    const typeFilter = req.query.type as string | undefined;

    const typeWhere = typeFilter ? sql`AND ct.ticket_type=${typeFilter}` : sql``;

    const rows = await db.execute(sql`
      SELECT ct.id, ct.ticket_type, ct.notes, ct.created_at,
        c.first_name AS client_first, c.last_name AS client_last,
        u.first_name AS emp_first, u.last_name AS emp_last,
        cb.first_name AS cb_first, cb.last_name AS cb_last
      FROM contact_tickets ct
      JOIN users u ON u.id=ct.user_id
      LEFT JOIN clients c ON c.id=ct.client_id
      LEFT JOIN users cb ON cb.id=ct.created_by
      WHERE ct.company_id=${companyId}
        AND ct.created_at::date BETWEEN ${fromStr} AND ${toStr}
        ${typeWhere}
      ORDER BY ct.created_at DESC LIMIT 200
    `);

    const data = (rows.rows as any[]).map(r => ({
      id: r.id, type: r.ticket_type, notes: r.notes, date: r.created_at,
      client_name: r.client_first ? `${r.client_first} ${r.client_last}` : null,
      employee_name: `${r.emp_first} ${r.emp_last}`,
      created_by: r.cb_first ? `${r.cb_first} ${r.cb_last}` : null,
    }));

    const counts = {
      complaints: data.filter(r => r.type.startsWith("complaint")).length,
      breakages:  data.filter(r => r.type === "breakage").length,
      compliments: data.filter(r => r.type === "compliment").length,
      incidents:  data.filter(r => r.type === "incident").length,
      notes:      data.filter(r => r.type === "note").length,
    };

    return res.json({ from: fromStr, to: toStr, data, counts });
  } catch (err) {
    console.error("Contact tickets error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── HOT SHEET ────────────────────────────────────────────────────────────────
router.get("/hot-sheet", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const targetDate = (req.query.date as string) || dateStr(now);

    const rows = await db.execute(sql`
      SELECT
        j.id, j.scheduled_time, j.service_type, j.status, j.notes, j.base_fee, j.allowed_hours,
        c.first_name AS client_first, c.last_name AS client_last, c.address, c.city, c.state, c.zip, c.notes AS client_notes,
        u.first_name AS emp_first, u.last_name AS emp_last,
        sc_last.score AS last_score,
        (SELECT count(*) = 0 FROM jobs pj WHERE pj.client_id=c.id AND pj.status='complete' AND pj.id != j.id) AS is_first_time
      FROM jobs j
      JOIN clients c ON c.id=j.client_id
      LEFT JOIN users u ON u.id=j.assigned_user_id
      LEFT JOIN LATERAL (
        -- [scorecard-dead-table 2026-08-08] same swap; client reached via the job.
        SELECT ROUND(se.score_value / NULLIF(se.max_value, 0) * 4)::int AS score
          FROM scorecard_entries se
          JOIN jobs sj ON sj.id = se.job_id
         WHERE sj.client_id = c.id AND se.company_id = ${companyId}
           AND se.excluded = false AND se.dismissed_at IS NULL
         ORDER BY se.entry_date DESC, se.id DESC LIMIT 1
      ) sc_last ON true
      WHERE j.company_id=${companyId} AND j.scheduled_date=${targetDate}
        ${branchFilter(req, "j.branch_id")}
        AND j.status IN ('scheduled','in_progress')
      ORDER BY j.scheduled_time NULLS LAST
    `);

    const data = (rows.rows as any[]).map(r => ({
      id: r.id, time: r.scheduled_time, service_type: r.service_type, status: r.status,
      client_name: `${r.client_first} ${r.client_last}`,
      address: r.address, city: r.city, state: r.state, zip: r.zip,
      employee_name: r.emp_first ? `${r.emp_first} ${r.emp_last}` : "Unassigned",
      special_instructions: r.client_notes, notes: r.notes,
      last_score: r.last_score, is_first_time: r.is_first_time,
      base_fee: parseF(r.base_fee), allowed_hours: parseF(r.allowed_hours),
    }));

    return res.json({ date: targetDate, data });
  } catch (err) {
    console.error("Hot sheet error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── FIRST TIME IN ───────────────────────────────────────────────────────────
router.get("/first-time", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const fromStr = (req.query.from as string) || dateStr(now);
    const toStr   = (req.query.to   as string) || dateStr(new Date(now.getTime() + 30 * 86400000));

    const rows = await db.execute(sql`
      SELECT j.id, j.scheduled_date, j.scheduled_time, j.service_type, j.allowed_hours, j.base_fee,
        c.first_name AS client_first, c.last_name AS client_last, c.address, c.city, c.state,
        u.first_name AS emp_first, u.last_name AS emp_last
      FROM jobs j
      JOIN clients c ON c.id=j.client_id
      LEFT JOIN users u ON u.id=j.assigned_user_id
      WHERE j.company_id=${companyId}
        ${branchFilter(req, "j.branch_id")}
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
        AND j.status IN ('scheduled','complete')
        AND NOT EXISTS (
          SELECT 1 FROM jobs pj WHERE pj.client_id=j.client_id AND pj.status='complete' AND pj.id != j.id AND pj.scheduled_date < j.scheduled_date
        )
      ORDER BY j.scheduled_date, j.scheduled_time NULLS LAST
    `);

    const data = (rows.rows as any[]).map(r => ({
      id: r.id, date: r.scheduled_date, time: r.scheduled_time, service_type: r.service_type,
      client_name: `${r.client_first} ${r.client_last}`,
      address: `${r.address || ""}${r.city ? ", " + r.city : ""}${r.state ? ", " + r.state : ""}`.trim(),
      employee_name: r.emp_first ? `${r.emp_first} ${r.emp_last}` : "Unassigned",
      allowed_hours: parseF(r.allowed_hours), bill_rate: parseF(r.base_fee),
    }));

    return res.json({ from: fromStr, to: toStr, data });
  } catch (err) {
    console.error("First time error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/reports/upsell-conversion ──────────────────────────────────────
router.get("/upsell-conversion", requireAuth, ROLE, async (req, res) => {
  const { sql: dsql } = await import("drizzle-orm");
  // [tech-isolation 2026-07-10] Add the ROLE gate every sibling report has, and
  // fix the company scope: req.user is undefined (middleware sets req.auth), so
  // companyId was silently null here.
  const companyId = (req as any).auth?.companyId;
  const { from, to, status: statusFilter, cadence: cadenceFilter } = req.query as Record<string, string>;
  const fromStr = from || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const toStr = to || new Date().toISOString().split("T")[0];
  try {
    // KPI counts
    const kpiResult = await db.execute(dsql`
      SELECT
        COUNT(*) FILTER (WHERE upsell_shown = true) AS total_shown,
        COUNT(*) FILTER (WHERE upsell_accepted = true) AS total_accepted,
        COUNT(*) FILTER (WHERE upsell_declined = true AND upsell_accepted = false) AS total_declined,
        COUNT(*) FILTER (WHERE upsell_deferred = true AND upsell_accepted = false) AS total_deferred
      FROM jobs
      WHERE company_id = ${companyId}
        ${branchFilter(req)}
        AND upsell_shown = true
        AND created_at::date BETWEEN ${fromStr}::date AND ${toStr}::date
    `);
    const kpi = kpiResult.rows[0] as any;

    // Weekly trend (accepted rate % by week)
    const trendResult = await db.execute(dsql`
      SELECT
        TO_CHAR(DATE_TRUNC('week', created_at), 'Mon DD') AS week_label,
        DATE_TRUNC('week', created_at) AS week_start,
        COUNT(*) FILTER (WHERE upsell_shown = true) AS shown,
        COUNT(*) FILTER (WHERE upsell_accepted = true) AS accepted
      FROM jobs
      WHERE company_id = ${companyId}
        ${branchFilter(req)}
        AND upsell_shown = true
        AND created_at::date BETWEEN ${fromStr}::date AND ${toStr}::date
      GROUP BY DATE_TRUNC('week', created_at)
      ORDER BY week_start ASC
    `);

    // Breakdown table
    let rowsQuery = dsql`
      SELECT
        j.id, j.created_at AS date,
        c.first_name || ' ' || c.last_name AS client_name,
        j.upsell_cadence_selected AS cadence,
        j.upsell_accepted, j.upsell_declined, j.upsell_deferred,
        rl.locked_rate,
        j.base_fee AS deep_clean_total
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
      LEFT JOIN rate_locks rl ON rl.client_id = j.client_id AND rl.active = true
      WHERE j.company_id = ${companyId}
        ${branchFilter(req, "j.branch_id")}
        AND j.upsell_shown = true
        AND j.created_at::date BETWEEN ${fromStr}::date AND ${toStr}::date
      ORDER BY j.created_at DESC
      LIMIT 200
    `;
    const rowsResult = await db.execute(rowsQuery);

    // Rate lock health
    const lockHealthResult = await db.execute(dsql`
      SELECT
        COUNT(*) FILTER (WHERE active = true) AS active_count,
        COUNT(*) FILTER (WHERE active = true AND lock_expires_at <= NOW() + INTERVAL '30 days') AS expiring_30,
        COUNT(*) FILTER (WHERE active = false AND voided_at >= DATE_TRUNC('month', NOW())) AS voided_month,
        COUNT(*) FILTER (WHERE active = false AND voided_at >= DATE_TRUNC('month', NOW()) AND void_reason = 'time_overrun') AS voided_time_overrun,
        COUNT(*) FILTER (WHERE active = false AND voided_at >= DATE_TRUNC('month', NOW()) AND void_reason = 'service_gap') AS voided_service_gap,
        COUNT(*) FILTER (WHERE active = false AND voided_at >= DATE_TRUNC('month', NOW()) AND void_reason = 'manual') AS voided_manual,
        COUNT(*) FILTER (WHERE active = false AND voided_at >= DATE_TRUNC('month', NOW()) AND void_reason = 'expired') AS voided_expired
      FROM rate_locks
      WHERE company_id = ${companyId}
    `);

    const rows = rowsResult.rows as any[];
    const filteredRows = rows
      .filter(r => {
        if (statusFilter === "accepted") return r.upsell_accepted;
        if (statusFilter === "declined") return r.upsell_declined && !r.upsell_accepted;
        if (statusFilter === "deferred") return r.upsell_deferred && !r.upsell_accepted;
        return true;
      })
      .filter(r => !cadenceFilter || cadenceFilter === "all" || r.cadence === cadenceFilter);

    return res.json({
      kpi: kpi,
      trend: trendResult.rows,
      rows: filteredRows,
      lockHealth: lockHealthResult.rows[0] ?? {},
    });
  } catch (err) {
    console.error("upsell-conversion error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/reports/mileage ────────────────────────────────────────────────
// [mileage-report 2026-08-15] Sal: "I need a report where i can see how much in
// mileage we are rembursing. Check the accuracy as well please."
//
// Two jobs in one surface:
//   1. HOW MUCH — split applied (money that actually moved) from pending (money
//      still at the review gate). These must never be added together into one
//      headline: "no money until reviewed" (CLAUDE.md) means pending is a
//      forecast, not a liability.
//   2. IS IT RIGHT — every leg is checked and anything suspicious is returned in
//      `flagged` with a reason. This exists because leg #56057 (9,668.57 mi /
//      $7,009.71 for a ~12-mile Chicago trip) sat in the pending pool for weeks
//      with nothing surfacing it. Both jobs on that leg had no address, so the
//      measurement fell through to haversine_fallback and produced a number
//      a third of the way around the planet — and nothing checked it.
//
// Flag reasons, most severe first:
//   implausible_distance — over MAX_PLAUSIBLE_MILES. A service business does not
//                          drive 200 miles between two houses. Always a data bug.
//   estimated            — measurement_is_estimated / haversine_fallback: the
//                          mapping API never measured this, so the miles are a
//                          guess off coordinates. Root cause is a missing address.
//   duplicate            — same tech, same day, same job pair, more than one row.
//                          A true double-count; pay one, discard the rest.
//   carpool_candidate    — same day + same job pair, MULTIPLE techs. NOT proof of
//                          a shared car: two techs assigned to both houses each
//                          legitimately drive it in their own vehicle and are each
//                          owed. Nothing in the schema records who rode with whom,
//                          so this is surfaced for a human to judge and is
//                          deliberately reported separately from the real errors
//                          above. Matches detectCarpoolCandidates() in
//                          lib/mileage-approval.ts, which likewise never
//                          auto-resolves.
const MAX_PLAUSIBLE_MILES = 200;

router.get("/mileage", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    let fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 90 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);
    // [reporting-floor 2026-08-17] Pre-cutover work is MaidCentral's record, not Qleno's.
    const { fromStr: floorFrom, clamp: rangeClamp } = await clampFrom(companyId, fromStr, toStr);
    fromStr = floorFrom;
    const userId  = req.query.user_id ? Number(req.query.user_id) : null;
    const userFilter = userId ? sql`AND ml.user_id = ${userId}` : sql``;

    // leg_date is timestamptz — always cast to ::date before comparing or
    // bucketing, or `leg_date + 1` style arithmetic throws.
    const legRows = await db.execute(sql`
      SELECT
        ml.id, ml.user_id, to_char(ml.leg_date, 'YYYY-MM-DD') AS leg_date, ml.miles, ml.minutes,
        ml.amount, ml.rate_per_mile, ml.status,
        ml.split_group_size, ml.amount_before_split,
        ml.measurement_source, ml.measurement_is_estimated,
        ml.from_job_id, ml.to_job_id,
        u.first_name, u.last_name,
        fj.address_zip  AS from_zip,
        tj.address_zip  AS to_zip,
        fc.first_name   AS from_client_first, fc.last_name AS from_client_last,
        tc.first_name   AS to_client_first,   tc.last_name AS to_client_last
      FROM mileage_legs ml
      JOIN users u        ON u.id  = ml.user_id
      LEFT JOIN jobs fj   ON fj.id = ml.from_job_id
      LEFT JOIN jobs tj   ON tj.id = ml.to_job_id
      LEFT JOIN clients fc ON fc.id = fj.client_id
      LEFT JOIN clients tc ON tc.id = tj.client_id
      WHERE ml.company_id = ${companyId}
        AND ml.leg_date::date BETWEEN ${fromStr}::date AND ${toStr}::date
        ${userFilter}
      ORDER BY ml.leg_date DESC, ml.id
    `);

    type Leg = {
      id: number; user_id: number; leg_date: string; miles: number; minutes: number;
      amount: number; rate_per_mile: number; status: string;
      split_group_size: number | null; amount_before_split: number | null;
      measurement_source: string | null; measurement_is_estimated: boolean;
      from_job_id: number | null; to_job_id: number | null;
      tech_name: string; from_label: string; to_label: string;
    };

    const nameOf = (f: any, l: any, zip: any, jobId: any) =>
      f ? `${f} ${l ?? ""}`.trim() : (zip ? `Job #${jobId} (${zip})` : `Job #${jobId ?? "?"}`);

    const legs: Leg[] = (legRows.rows as any[]).map(r => ({
      id: Number(r.id),
      user_id: Number(r.user_id),
      // Already a bare YYYY-MM-DD string via to_char — pg hands DATE back as a
      // JS Date otherwise and the day shifts by timezone on the way out.
      leg_date: String(r.leg_date),
      miles: parseF(r.miles),
      minutes: parseN(r.minutes),
      amount: parseF(r.amount),
      rate_per_mile: parseF(r.rate_per_mile),
      status: String(r.status),
      split_group_size: r.split_group_size == null ? null : Number(r.split_group_size),
      amount_before_split: r.amount_before_split == null ? null : parseF(r.amount_before_split),
      measurement_source: r.measurement_source ?? null,
      measurement_is_estimated: !!r.measurement_is_estimated,
      from_job_id: r.from_job_id ? Number(r.from_job_id) : null,
      to_job_id: r.to_job_id ? Number(r.to_job_id) : null,
      tech_name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
      from_label: nameOf(r.from_client_first, r.from_client_last, r.from_zip, r.from_job_id),
      to_label:   nameOf(r.to_client_first,   r.to_client_last,   r.to_zip,   r.to_job_id),
    }));

    const isPending = (s: string) => s === "computed" || s === "reviewed";
    const isLive    = (s: string) => s !== "discarded"; // discarded legs are decided; they owe nothing

    const summary = {
      applied_amount:   legs.filter(l => l.status === "applied").reduce((s, l) => s + l.amount, 0),
      applied_miles:    legs.filter(l => l.status === "applied").reduce((s, l) => s + l.miles, 0),
      applied_legs:     legs.filter(l => l.status === "applied").length,
      pending_amount:   legs.filter(l => isPending(l.status)).reduce((s, l) => s + l.amount, 0),
      pending_miles:    legs.filter(l => isPending(l.status)).reduce((s, l) => s + l.miles, 0),
      pending_legs:     legs.filter(l => isPending(l.status)).length,
      discarded_amount: legs.filter(l => l.status === "discarded").reduce((s, l) => s + l.amount, 0),
      discarded_legs:   legs.filter(l => l.status === "discarded").length,
      total_legs:       legs.length,
    };

    // ── accuracy pass ──────────────────────────────────────────────────────
    // Duplicates: same tech + day + job pair appearing more than once. Only
    // pre-apply rows — an applied row is already decided and re-flagging it
    // would invite double-discarding real history.
    //
    // Only the EXTRA copies get flagged — the first row of each group stays
    // clean. One of those drives really happened and is really owed, so
    // flagging every copy would quietly under-pay the tech the moment the
    // office used "approve all clean". Flag the surplus, keep the original.
    const dupKey = (l: Leg) => `${l.user_id}|${l.leg_date}|${l.from_job_id}|${l.to_job_id}`;
    const dupSeen = new Set<string>();
    const dupExtraIds = new Set<number>();
    for (const l of legs) {
      if (!isPending(l.status)) continue;
      const k = dupKey(l);
      if (dupSeen.has(k)) dupExtraIds.add(l.id);
      else dupSeen.add(k);
    }

    // Carpool candidates: same day + job pair, >1 DISTINCT tech.
    const poolKey = (l: Leg) => `${l.leg_date}|${l.from_job_id}|${l.to_job_id}`;
    const poolTechs = new Map<string, Set<number>>();
    for (const l of legs) {
      if (!isPending(l.status)) continue;
      const k = poolKey(l);
      if (!poolTechs.has(k)) poolTechs.set(k, new Set());
      poolTechs.get(k)!.add(l.user_id);
    }

    const flagged: Array<Leg & { flag: string; flag_detail: string }> = [];
    for (const l of legs) {
      if (!isLive(l.status)) continue;
      let flag: string | null = null;
      let detail = "";
      if (l.miles > MAX_PLAUSIBLE_MILES) {
        flag = "implausible_distance";
        detail = `${l.miles.toFixed(1)} mi between two jobs on the same day — impossible. Almost always a missing address on one end.`;
      } else if (l.measurement_is_estimated || l.measurement_source === "haversine_fallback") {
        flag = "estimated";
        detail = "Never measured by the mapping API — straight-line estimate from coordinates because an address was missing.";
      } else if (dupExtraIds.has(l.id)) {
        flag = "duplicate";
        detail = "A second copy of a drive already counted once today. The original stays payable — discard this one.";
      } else if (
        (poolTechs.get(poolKey(l))?.size ?? 0) > 1 &&
        l.amount > 0 &&
        // An already-split leg is a decided drive, not an open question. Leaving
        // it flagged would park it in the judgement queue forever and keep it
        // out of "approve all clean" — the exact opposite of what splitting is
        // for. It carries its share now and is ready to approve like any leg.
        l.split_group_size == null
      ) {
        // A $0 leg (same address, or two units at one building) is nothing to
        // decide — keep it out of the office's judgement queue.
        flag = "carpool_candidate";
        detail = `${poolTechs.get(poolKey(l))!.size} techs have this same drive. If they rode together only one should be paid — if they drove separately both are owed. Nothing in the data can tell you which; your call.`;
      }
      if (flag) flagged.push({ ...l, flag, flag_detail: detail });
    }
    const severity: Record<string, number> = {
      implausible_distance: 0, estimated: 1, duplicate: 2, carpool_candidate: 3,
    };
    flagged.sort((a, b) => (severity[a.flag]! - severity[b.flag]!) || (b.amount - a.amount));

    // "Clean pending" = what you'd owe if you approved everything EXCEPT the
    // hard errors. Carpool candidates count as clean here: they are a judgement
    // call, not a defect, and most of them are legitimately owed.
    const hardErrorIds = new Set(
      flagged.filter(f => f.flag !== "carpool_candidate").map(f => f.id),
    );
    const cleanPending = legs
      .filter(l => isPending(l.status) && !hardErrorIds.has(l.id))
      .reduce((s, l) => s + l.amount, 0);

    // ── shared drives, grouped ─────────────────────────────────────────────
    // [shared-drive-split 2026-08-15] The flat `flagged` list shows one row per
    // tech, which is exactly the wrong shape for this decision: the office is
    // looking at ONE drive and deciding what to do about the techs on it. Group
    // by drive so the screen can show both names together, and carry the split
    // state so it can offer "split between them" or undo a split it already did.
    //
    // Includes drives already split — they're no longer flagged, but the office
    // still needs to see what it decided and be able to reverse a misclick.
    const sharedDrivesMap = new Map<string, any>();
    for (const l of legs) {
      if (!isPending(l.status)) continue;
      if ((poolTechs.get(poolKey(l))?.size ?? 0) <= 1) continue;
      const isSplit = l.split_group_size != null;
      // The drive's full cost: the pre-split amount when split, else the leg's
      // own amount. Both are the same number, just before vs after the rewrite.
      const fullAmount = isSplit ? (l.amount_before_split ?? l.amount) : l.amount;
      if (fullAmount <= 0 && !isSplit) continue; // $0 drive — nothing to decide
      const k = poolKey(l);
      if (!sharedDrivesMap.has(k)) {
        sharedDrivesMap.set(k, {
          key: k,
          leg_date: l.leg_date,
          from_job_id: l.from_job_id,
          to_job_id: l.to_job_id,
          from_label: l.from_label,
          to_label: l.to_label,
          miles: l.miles,
          is_split: isSplit,
          // What one drive actually costs — what the group pays if split.
          full_amount: fullAmount,
          // What the group pays as it stands. Equals full_amount once split;
          // full_amount × tech-count while it isn't.
          current_total: 0,
          legs: [],
        });
      }
      const g = sharedDrivesMap.get(k)!;
      g.current_total += l.amount;
      g.legs.push({
        id: l.id,
        user_id: l.user_id,
        tech_name: l.tech_name,
        amount: l.amount,
        amount_before_split: l.amount_before_split,
        status: l.status,
      });
    }
    const shared_drives = [...sharedDrivesMap.values()]
      .map(g => ({
        ...g,
        legs: g.legs.sort((a: any, b: any) => a.id - b.id),
        tech_count: g.legs.length,
        // What the office saves by splitting this drive. Zero once split.
        overpay: g.is_split ? 0 : g.current_total - g.full_amount,
      }))
      .sort((a, b) => b.overpay - a.overpay || a.leg_date.localeCompare(b.leg_date));

    // ── rollups ────────────────────────────────────────────────────────────
    const byWeekMap = new Map<string, any>();
    for (const l of legs) {
      if (!isLive(l.status)) continue;
      // Sun-anchored week to match the dispatch/payroll week everywhere else.
      const d = new Date(`${l.leg_date}T00:00:00`);
      d.setDate(d.getDate() - d.getDay());
      const wk = dateStr(d);
      if (!byWeekMap.has(wk)) byWeekMap.set(wk, { week_start: wk, legs: 0, miles: 0, amount: 0, applied_amount: 0, pending_amount: 0 });
      const w = byWeekMap.get(wk)!;
      w.legs += 1; w.miles += l.miles; w.amount += l.amount;
      if (l.status === "applied") w.applied_amount += l.amount;
      if (isPending(l.status)) w.pending_amount += l.amount;
    }
    const by_week = [...byWeekMap.values()].sort((a, b) => a.week_start.localeCompare(b.week_start));

    const byTechMap = new Map<number, any>();
    for (const l of legs) {
      if (!isLive(l.status)) continue;
      if (!byTechMap.has(l.user_id)) byTechMap.set(l.user_id, { user_id: l.user_id, tech_name: l.tech_name, legs: 0, miles: 0, amount: 0, applied_amount: 0, pending_amount: 0, flagged_legs: 0 });
      const t = byTechMap.get(l.user_id)!;
      t.legs += 1; t.miles += l.miles; t.amount += l.amount;
      if (l.status === "applied") t.applied_amount += l.amount;
      if (isPending(l.status)) t.pending_amount += l.amount;
    }
    for (const f of flagged) { const t = byTechMap.get(f.user_id); if (t) t.flagged_legs += 1; }
    const by_tech = [...byTechMap.values()].sort((a, b) => b.amount - a.amount);

    // Current rate, for the header. Latest effective_date on or before `to`.
    const rateRow = await db.execute(sql`
      SELECT rate FROM mileage_rates
      WHERE company_id = ${companyId} AND effective_date <= ${toStr}::date
      ORDER BY effective_date DESC LIMIT 1
    `);

    return res.json({
      range_clamped: rangeClamp,
      from: fromStr,
      to: toStr,
      rate_per_mile: rateRow.rows[0] ? parseF((rateRow.rows[0] as any).rate) : null,
      summary: { ...summary, clean_pending_amount: cleanPending },
      by_week,
      by_tech,
      flagged,
      shared_drives,
      legs,
    });
  } catch (err) {
    console.error("Mileage report error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/reports/owner-digest ───────────────────────────────────────────
// [owner-digest 2026-08-19] Read-only preview of the 6 PM recap: every number
// the text carries, plus the exact message body that would be sent, plus which
// comms gate (if any) is currently holding the text back. Sends nothing.
//
// This exists so the recap can be checked against the board BEFORE it starts
// texting anyone. A daily number the owner cannot reconcile is worse than no
// daily number.
router.get("/owner-digest", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const date = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date : undefined;
    const { buildOwnerDigest, formatOwnerDigestSms } = await import("../lib/owner-digest.js");
    const { resolveSender } = await import("../lib/comms-sender.js");
    const digest = await buildOwnerDigest(companyId, date);
    const sender = await resolveSender(companyId, null);
    return res.json({
      digest,
      sms_preview: formatOwnerDigestSms(digest),
      delivery: {
        cron_enabled: process.env.OWNER_DIGEST_ENABLED === "true",
        bypass_comms_gate: process.env.OWNER_DIGEST_BYPASS_COMMS_GATE === "true",
        sms_blocked_by: sender.reason ?? null,
      },
    });
  } catch (err) {
    console.error("GET /reports/owner-digest:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/reports/owner-digest/send ─────────────────────────────────────
// Send the recap right now, to the tenant's owners, on demand. Owner-only: the
// recipients are the owners themselves, so nobody else needs to be able to fire
// it. Obeys the same comms ladder as the cron — this is a "send it early", not
// a way around the gate.
router.post("/owner-digest/send", requireAuth, requireRole("owner", "super_admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const date = typeof req.body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
      ? req.body.date : undefined;
    const { sendOwnerDigest } = await import("../lib/owner-digest.js");
    return res.json(await sendOwnerDigest(companyId, date));
  } catch (err) {
    console.error("POST /reports/owner-digest/send:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
