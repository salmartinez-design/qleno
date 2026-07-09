import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable, jobsTable, scorecardsTable, timeclockTable,
  clientsTable, clientRatingsTable, invoicesTable, additionalPayTable,
  contactTicketsTable,
} from "@workspace/db/schema";
import { eq, and, gte, lte, desc, count, avg, sum, sql, lt, inArray, isNull, ne } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { computePeriodPayLines } from "../lib/period-pay.js";

const router = Router();
const ROLE = requireRole("owner", "admin", "office");

function dateStr(d: Date) { return d.toISOString().split("T")[0]; }
function parseF(v: any) { return parseFloat(v || "0"); }
function parseN(v: any) { return Number(v || 0); }

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

    const topPerformers = await db.select({
      id: usersTable.id, first_name: usersTable.first_name, last_name: usersTable.last_name,
      avatar_url: usersTable.avatar_url, jobs_completed: count(jobsTable.id), avg_score: avg(scorecardsTable.score),
    }).from(usersTable)
      .leftJoin(jobsTable, and(eq(jobsTable.assigned_user_id, usersTable.id), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, dateStr7), branchCondJob))
      .leftJoin(scorecardsTable, and(eq(scorecardsTable.user_id, usersTable.id), gte(scorecardsTable.created_at, sevenDaysAgo), eq(scorecardsTable.excluded, false)))
      .where(and(eq(usersTable.company_id, companyId), eq(usersTable.is_active, true)))
      .groupBy(usersTable.id).orderBy(desc(count(jobsTable.id))).limit(5);

    const lateClockins = await db.select({ user_id: timeclockTable.user_id, late_count: count(timeclockTable.id) })
      .from(timeclockTable)
      .where(and(eq(timeclockTable.company_id, companyId), eq(timeclockTable.flagged, true), gte(timeclockTable.clock_in_at, thirtyDaysAgo), branchCondClock))
      .groupBy(timeclockTable.user_id);

    const lowScorecards = await db.select({ user_id: scorecardsTable.user_id, avg_score: avg(scorecardsTable.score) })
      .from(scorecardsTable)
      .where(and(eq(scorecardsTable.company_id, companyId), gte(scorecardsTable.created_at, thirtyDaysAgo), eq(scorecardsTable.excluded, false)))
      .groupBy(scorecardsTable.user_id).having(sql`avg(${scorecardsTable.score}) < 3.0`);

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
      service_type: jobsTable.service_type, total_revenue: sum(jobsTable.base_fee), job_count: count(jobsTable.id),
    }).from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, dateStr30), branchCondJob))
      .groupBy(jobsTable.service_type).orderBy(desc(sum(jobsTable.base_fee)));

    const avgJobValue = await db.select({ avg: avg(jobsTable.base_fee) }).from(jobsTable)
      .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, dateStr30), branchCondJob));

    const projectedRevenue = await db.select({ projected: sum(jobsTable.base_fee) }).from(jobsTable)
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
    const fromStr = (req.query.from as string) || dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
    const toStr   = (req.query.to   as string) || dateStr(now);
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
    const totalRev = parseF(s?.total_revenue);
    const cancelFeeRev = parseF(cb.cancellation_fee_revenue);
    return res.json({
      from: fromStr, to: toStr, group_by: groupBy,
      summary: {
        total_revenue: totalRev,
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
      trend: (trend.rows as any[]).map(r => ({
        period: r.period, job_count: parseN(r.job_count), revenue: parseF(r.revenue),
        avg_per_job: parseF(r.avg_per_job), allowed_hours: parseF(r.allowed_hours),
      })),
    });
  } catch (err) {
    console.error("Revenue report error:", err);
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
    const fromStr = (req.query.from as string) || dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
    const toStr   = (req.query.to   as string) || dateStr(now);

    // [pay-model-parity 2026-07-04] Labor cost per job = SUM of the paycheck
    // engine's per-tech amounts on that job (computePeriodPayLines), NOT the old
    // per-EMPLOYEE pay_type CASE (no allowed_hours branch, primary tech only).
    const { lines: costLines } = await computePeriodPayLines(companyId, fromStr, toStr);
    const laborByJob = new Map<number, number>();
    for (const l of costLines) laborByJob.set(l.job_id, (laborByJob.get(l.job_id) ?? 0) + (l.amount || 0));

    const rows = await db.execute(sql`
      SELECT
        j.id, j.scheduled_date, j.service_type, j.base_fee,
        j.allowed_hours, j.actual_hours,
        c.first_name AS client_first, c.last_name AS client_last,
        u.first_name AS emp_first, u.last_name AS emp_last,
        u.pay_rate, u.pay_type
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
      LEFT JOIN users u ON u.id = j.assigned_user_id
      WHERE j.company_id = ${companyId}
        ${branchFilter(req, "j.branch_id")}
        AND j.status = 'complete'
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      ORDER BY j.scheduled_date DESC
      LIMIT 500
    `);

    const data = (rows.rows as any[]).map(r => {
      const revenue = parseF(r.base_fee);
      const labor   = Math.round((laborByJob.get(Number(r.id)) ?? 0) * 100) / 100;
      const profit  = revenue - labor;
      const margin  = revenue > 0 ? (profit / revenue) * 100 : 0;
      return {
        id: r.id, date: r.scheduled_date, service_type: r.service_type,
        client_name: `${r.client_first} ${r.client_last}`,
        employee_name: r.emp_first ? `${r.emp_first} ${r.emp_last}` : "Unassigned",
        revenue, labor_cost: parseF(labor), gross_profit: profit, margin_pct: margin,
        allowed_hours: parseF(r.allowed_hours), actual_hours: parseF(r.actual_hours),
      };
    });

    const avgMargin = data.length > 0 ? data.reduce((s, r) => s + r.margin_pct, 0) / data.length : 0;

    // Best/worst service types
    const byService: Record<string, { total: number; count: number }> = {};
    data.forEach(r => {
      if (!byService[r.service_type]) byService[r.service_type] = { total: 0, count: 0 };
      byService[r.service_type].total += r.margin_pct;
      byService[r.service_type].count += 1;
    });
    const serviceAvgs = Object.entries(byService).map(([st, v]) => ({ service_type: st, avg_margin: v.total / v.count }))
      .sort((a, b) => b.avg_margin - a.avg_margin);

    return res.json({
      from: fromStr, to: toStr, data,
      summary: {
        avg_margin: avgMargin,
        best_service: serviceAvgs[0]?.service_type || null,
        worst_service: serviceAvgs[serviceAvgs.length - 1]?.service_type || null,
        total_revenue: data.reduce((s, r) => s + r.revenue, 0),
        total_labor: data.reduce((s, r) => s + r.labor_cost, 0),
        total_profit: data.reduce((s, r) => s + r.gross_profit, 0),
      },
    });
  } catch (err) {
    console.error("Job costing error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── PAYROLL % TO REVENUE ────────────────────────────────────────────────────
router.get("/payroll-to-revenue", requireAuth, ROLE, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();

    // Last 12 weeks
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay() - i * 7);
      weekStart.setHours(0,0,0,0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      weeks.push({ start: dateStr(weekStart), end: dateStr(weekEnd) });
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
        SELECT coalesce(sum(base_fee), 0) AS revenue, count(*) AS jobs
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
        WHERE company_id=${companyId} AND created_at::date BETWEEN ${w.start} AND ${w.end}
      `);

      const revenue = parseF((revRow.rows[0] as any)?.revenue);
      const payroll = (payrollByWeek.get(w.start) ?? 0) + parseF((addPayRow.rows[0] as any)?.add_pay);
      const pct     = revenue > 0 ? (payroll / revenue) * 100 : 0;
      return { week: w.start, revenue, payroll, pct, jobs: parseN((revRow.rows[0] as any)?.jobs) };
    }));

    const currentWeek = weekData[weekData.length - 1];
    const status = currentWeek.pct > 45 ? "critical" : currentWeek.pct > 40 ? "high" : currentWeek.pct >= 30 ? "healthy" : "low";

    return res.json({ weeks: weekData, current: currentWeek, status });
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
    const fromStr = (req.query.from as string) || dateStr(monday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const toStr = (req.query.to as string) || dateStr(sunday);

    // Filter the employee list by home_branch_id when a specific branch is
    // requested. Techs without a home_branch (legacy NULLs) are still surfaced
    // when "all" is selected; the per-employee job query below also branch-
    // filters so an Oak Lawn tech who did Schaumburg jobs won't double-count.
    const employees = await db.select({ id: usersTable.id, first_name: usersTable.first_name, last_name: usersTable.last_name, pay_rate: usersTable.pay_rate, pay_type: usersTable.pay_type, fee_split_pct: usersTable.fee_split_pct })
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
    for (const l of payLines) {
      if (branchNum != null && l.branch_id !== branchNum) continue;
      basePayByUser.set(l.user_id, (basePayByUser.get(l.user_id) ?? 0) + (l.amount || 0));
      if (!jobIdsByUser.has(l.user_id)) jobIdsByUser.set(l.user_id, new Set());
      jobIdsByUser.get(l.user_id)!.add(l.job_id);
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
          AND created_at::date BETWEEN ${fromStr} AND ${toStr}
        GROUP BY type
      `);

      const clk  = clockRes.rows[0] as any;
      const addPay = addPayRes.rows as any[];
      // Pay + job attribution now come from the engine (per-tech clocked split),
      // not a primary-only assigned_user_id join.
      const myJobIds = jobIdsByUser.get(emp.id) ?? new Set<number>();
      const base_pay = Math.round((basePayByUser.get(emp.id) ?? 0) * 100) / 100;
      const tips     = addPay.filter(p => p.type === "tips").reduce((s, p) => s + parseF(p.total), 0);
      const add_pay  = addPay.filter(p => p.type !== "tips").reduce((s, p) => s + parseF(p.total), 0);
      const job_hrs  = [...myJobIds].reduce((s, id) => s + (allowedHoursByJob.get(id) ?? 0), 0);
      const clk_hrs  = parseF(clk?.clock_hours);
      const overtime = Math.max(0, clk_hrs - 40) * parseF(emp.pay_rate || 0) * 0.5;

      return {
        id: emp.id, name: `${emp.first_name} ${emp.last_name}`, pay_type: emp.pay_type,
        days_worked: parseN(clk?.days_worked), job_hours: job_hrs, clock_hours: clk_hrs,
        base_pay, tips, additional_pay: add_pay, overtime, deductions: 0, gross_pay: base_pay + tips + add_pay + overtime,
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
      from: fromStr, to: toStr, employees: rows,
      totals: {
        base_pay: rows.reduce((s, r) => s + r.base_pay, 0),
        tips: rows.reduce((s, r) => s + r.tips, 0),
        additional_pay: rows.reduce((s, r) => s + r.additional_pay, 0),
        overtime: rows.reduce((s, r) => s + r.overtime, 0),
        gross_pay: rows.reduce((s, r) => s + r.gross_pay, 0),
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
    const fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);

    const byDay = await db.execute(sql`
      SELECT
        j.scheduled_date::text AS date,
        count(j.id) AS jobs,
        coalesce(sum(j.allowed_hours), 0) AS allowed_hours,
        coalesce(sum(EXTRACT(EPOCH FROM (t.clock_out_at - t.clock_in_at))/3600) FILTER (WHERE t.clock_out_at IS NOT NULL), 0) AS clock_hours
      FROM jobs j
      LEFT JOIN timeclock t ON t.job_id=j.id AND t.user_id=j.assigned_user_id
      WHERE j.company_id=${companyId} AND j.status='complete'
        ${branchFilter(req, "j.branch_id")}
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      GROUP BY j.scheduled_date ORDER BY j.scheduled_date
    `);

    const byEmployee = await db.execute(sql`
      SELECT
        u.id, u.first_name, u.last_name,
        count(j.id) AS jobs,
        coalesce(sum(j.allowed_hours), 0) AS allowed_hours,
        coalesce(sum(EXTRACT(EPOCH FROM (t.clock_out_at - t.clock_in_at))/3600) FILTER (WHERE t.clock_out_at IS NOT NULL), 0) AS clock_hours
      FROM jobs j
      JOIN users u ON u.id=j.assigned_user_id
      LEFT JOIN timeclock t ON t.job_id=j.id AND t.user_id=j.assigned_user_id
      WHERE j.company_id=${companyId} AND j.status='complete'
        ${branchFilter(req, "j.branch_id")}
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      GROUP BY u.id, u.first_name, u.last_name ORDER BY clock_hours DESC
    `);

    const totals = (byDay.rows as any[]).reduce((acc, r) => ({
      jobs: acc.jobs + parseN(r.jobs),
      allowed: acc.allowed + parseF(r.allowed_hours),
      clock: acc.clock + parseF(r.clock_hours),
    }), { jobs: 0, allowed: 0, clock: 0 });

    const overallEff = totals.clock > 0 ? (totals.allowed / totals.clock) * 100 : 0;

    return res.json({
      from: fromStr, to: toStr,
      overall_efficiency: overallEff,
      total_jobs: totals.jobs, total_allowed_hours: totals.allowed, total_clock_hours: totals.clock,
      by_day: (byDay.rows as any[]).map(r => {
        const eff = parseF(r.clock_hours) > 0 ? (parseF(r.allowed_hours) / parseF(r.clock_hours)) * 100 : 0;
        return { date: r.date, jobs: parseN(r.jobs), allowed_hours: parseF(r.allowed_hours), clock_hours: parseF(r.clock_hours), efficiency_pct: eff };
      }),
      by_employee: (byEmployee.rows as any[]).map(r => {
        const eff = parseF(r.clock_hours) > 0 ? (parseF(r.allowed_hours) / parseF(r.clock_hours)) * 100 : 0;
        return { id: r.id, name: `${r.first_name} ${r.last_name}`, jobs: parseN(r.jobs), allowed_hours: parseF(r.allowed_hours), clock_hours: parseF(r.clock_hours), efficiency_pct: eff };
      }),
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
    const fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);
    const userId  = req.query.user_id ? Number(req.query.user_id) : null;

    const empFilter = userId ? sql`AND u.id = ${userId}` : sql``;

    const rows = await db.execute(sql`
      SELECT
        u.id, u.first_name, u.last_name, u.avatar_url,
        count(DISTINCT j.id) AS jobs_completed,
        count(DISTINCT j.scheduled_date) AS days_worked,
        coalesce(sum(j.allowed_hours), 0) AS job_hours,
        coalesce(sum(EXTRACT(EPOCH FROM (t.clock_out_at - t.clock_in_at))/3600) FILTER (WHERE t.clock_out_at IS NOT NULL), 0) AS clock_hours,
        coalesce(sum(j.base_fee), 0) AS revenue_generated,
        coalesce(avg(sc.score) FILTER (WHERE sc.excluded=false), 0) AS scorecard_avg,
        coalesce(sum(ap.amount) FILTER (WHERE ap.type='tips'), 0) AS tips_earned,
        count(tc.id) FILTER (WHERE tc.flagged=true) AS flagged_clocks
      FROM users u
      LEFT JOIN jobs j ON j.assigned_user_id=u.id AND j.status='complete'
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
        ${branchFilter(req, "j.branch_id")}
      LEFT JOIN timeclock t ON t.job_id=j.id AND t.user_id=u.id
      LEFT JOIN scorecards sc ON sc.user_id=u.id AND sc.created_at::date BETWEEN ${fromStr} AND ${toStr}
      LEFT JOIN additional_pay ap ON ap.user_id=u.id AND ap.created_at::date BETWEEN ${fromStr} AND ${toStr}
      LEFT JOIN timeclock tc ON tc.user_id=u.id AND tc.clock_in_at::date BETWEEN ${fromStr} AND ${toStr}
      WHERE u.company_id=${companyId} AND u.is_active=true ${empFilter}
      GROUP BY u.id ORDER BY revenue_generated DESC
    `);

    return res.json({
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
    const isTech     = authRole === "technician";
    const now = new Date();
    const fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);
    const userId  = isTech ? authUserId : (req.query.user_id ? Number(req.query.user_id) : null);

    const userFilter = userId ? sql`AND ap.user_id = ${userId}` : sql``;

    const rows = await db.execute(sql`
      SELECT
        ap.id, ap.amount, ap.type, ap.notes, ap.created_at,
        u.first_name AS emp_first, u.last_name AS emp_last,
        c.first_name AS client_first, c.last_name AS client_last,
        j.service_type, j.scheduled_date
      FROM additional_pay ap
      JOIN users u ON u.id=ap.user_id
      LEFT JOIN jobs j ON j.id=ap.job_id
      LEFT JOIN clients c ON c.id=j.client_id
      WHERE ap.company_id=${companyId} AND ap.type='tips'
        AND ap.created_at::date BETWEEN ${fromStr} AND ${toStr}
        ${branchFilter(req, "j.branch_id")}
        ${userFilter}
      ORDER BY ap.created_at DESC LIMIT 500
    `);

    const data = (rows.rows as any[]).map(r => ({
      id: r.id, date: r.created_at, amount: parseF(r.amount), type: r.type, notes: r.notes,
      employee_name: `${r.emp_first} ${r.emp_last}`,
      client_name: r.client_first ? `${r.client_first} ${r.client_last}` : null,
      service_type: r.service_type, job_date: r.scheduled_date,
    }));

    const totalTips = data.reduce((s, r) => s + r.amount, 0);
    return res.json({ from: fromStr, to: toStr, data, summary: { total_tips: totalTips, avg_per_tip: data.length > 0 ? totalTips / data.length : 0, count: data.length } });
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
    const fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);
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
    const fromStr = (req.query.from as string) || dateStr(new Date(now.getTime() - 30 * 86400000));
    const toStr   = (req.query.to   as string) || dateStr(now);
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
      const rev = await db.execute(sql`SELECT coalesce(sum(base_fee),0) AS revenue, count(*) AS jobs, coalesce(avg(base_fee),0) AS avg_bill FROM jobs WHERE company_id=${companyId} AND status='complete' ${branchFilter(req)} AND scheduled_date BETWEEN ${start} AND ${end}`);
      const qual = await db.execute(sql`SELECT coalesce(avg(score),0) AS avg FROM scorecards WHERE company_id=${companyId} AND excluded=false AND created_at::date BETWEEN ${start} AND ${end}`);
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
      const r = await db.execute(sql`SELECT coalesce(sum(base_fee),0) AS revenue, coalesce(avg(sc.score),0) AS quality FROM jobs j LEFT JOIN scorecards sc ON sc.job_id=j.id AND sc.excluded=false WHERE j.company_id=${companyId} AND j.status='complete' ${branchFilter(req, "j.branch_id")} AND j.scheduled_date BETWEEN ${wStart} AND ${wEnd}`);
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
      SELECT sc.id, sc.score, sc.comments, sc.excluded, sc.created_at,
        c.first_name AS client_first, c.last_name AS client_last,
        u.first_name AS emp_first, u.last_name AS emp_last,
        j.service_type, j.scheduled_date
      FROM scorecards sc
      JOIN clients c ON c.id=sc.client_id
      JOIN users u ON u.id=sc.user_id
      JOIN jobs j ON j.id=sc.job_id
      WHERE sc.company_id=${companyId}
        ${branchFilter(req, "j.branch_id")}
        AND sc.created_at::date BETWEEN ${fromStr} AND ${toStr}
      ORDER BY sc.created_at DESC LIMIT 200
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
      LEFT JOIN scorecards sc ON sc.client_id=c.id AND sc.id=(SELECT id FROM scorecards WHERE client_id=c.id ORDER BY created_at DESC LIMIT 1)
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
        SELECT score FROM scorecards WHERE client_id=c.id ORDER BY created_at DESC LIMIT 1
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
router.get("/upsell-conversion", requireAuth, async (req, res) => {
  const { sql: dsql } = await import("drizzle-orm");
  const companyId = (req as any).user?.company_id;
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

export default router;
