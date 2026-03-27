import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable, jobsTable, scorecardsTable, timeclockTable,
  clientsTable, clientRatingsTable, invoicesTable, additionalPayTable,
  contactTicketsTable,
} from "@workspace/db/schema";
import { eq, and, gte, lte, desc, count, avg, sum, sql, lt, inArray, isNull, ne } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();
const ROLE = requireRole("owner", "admin", "office");

function dateStr(d: Date) { return d.toISOString().split("T")[0]; }
function parseF(v: any) { return parseFloat(v || "0"); }
function parseN(v: any) { return Number(v || 0); }

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

    const topPerformers = await db.select({
      id: usersTable.id, first_name: usersTable.first_name, last_name: usersTable.last_name,
      avatar_url: usersTable.avatar_url, jobs_completed: count(jobsTable.id), avg_score: avg(scorecardsTable.score),
    }).from(usersTable)
      .leftJoin(jobsTable, and(eq(jobsTable.assigned_user_id, usersTable.id), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, dateStr7)))
      .leftJoin(scorecardsTable, and(eq(scorecardsTable.user_id, usersTable.id), gte(scorecardsTable.created_at, sevenDaysAgo), eq(scorecardsTable.excluded, false)))
      .where(and(eq(usersTable.company_id, companyId), eq(usersTable.is_active, true)))
      .groupBy(usersTable.id).orderBy(desc(count(jobsTable.id))).limit(5);

    const lateClockins = await db.select({ user_id: timeclockTable.user_id, late_count: count(timeclockTable.id) })
      .from(timeclockTable)
      .where(and(eq(timeclockTable.company_id, companyId), eq(timeclockTable.flagged, true), gte(timeclockTable.clock_in_at, thirtyDaysAgo)))
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
      .from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete")))
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
    }).from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, dateStr30)))
      .groupBy(jobsTable.service_type).orderBy(desc(sum(jobsTable.base_fee)));

    const avgJobValue = await db.select({ avg: avg(jobsTable.base_fee) }).from(jobsTable)
      .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, dateStr30)));

    const projectedRevenue = await db.select({ projected: sum(jobsTable.base_fee) }).from(jobsTable)
      .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "scheduled"), gte(jobsTable.scheduled_date, todayStr)));

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

    const trend = await db.execute(sql`
      SELECT
        ${groupExpr} AS period,
        count(*) AS job_count,
        coalesce(sum(base_fee), 0) AS revenue,
        coalesce(avg(base_fee), 0) AS avg_per_job,
        coalesce(sum(allowed_hours), 0) AS allowed_hours
      FROM jobs
      WHERE company_id = ${companyId}
        AND status = 'complete'
        AND scheduled_date BETWEEN ${fromStr} AND ${toStr}
      GROUP BY 1
      ORDER BY 1
    `);

    const summary = await db.execute(sql`
      SELECT
        count(*) AS job_count,
        coalesce(sum(base_fee), 0) AS total_revenue,
        coalesce(avg(base_fee), 0) AS avg_job_value,
        coalesce(sum(allowed_hours), 0) AS total_allowed_hours
      FROM jobs
      WHERE company_id = ${companyId}
        AND status = 'complete'
        AND scheduled_date BETWEEN ${fromStr} AND ${toStr}
    `);

    // Projected: sum of scheduled jobs this month
    const monthStart = dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
    const monthEnd   = dateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    const projected  = await db.execute(sql`
      SELECT coalesce(sum(base_fee), 0) AS projected
      FROM jobs
      WHERE company_id = ${companyId} AND status IN ('scheduled','in_progress','complete')
        AND scheduled_date BETWEEN ${monthStart} AND ${monthEnd}
    `);

    const s = summary.rows[0] as any;
    return res.json({
      from: fromStr, to: toStr, group_by: groupBy,
      summary: {
        total_revenue: parseF(s?.total_revenue), avg_job_value: parseF(s?.avg_job_value),
        job_count: parseN(s?.job_count), projected_month_end: parseF((projected.rows[0] as any)?.projected),
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
        i.id, i.status, i.total, i.created_at, i.paid_at,
        c.first_name, c.last_name, c.email,
        (i.created_at + interval '30 days') AS due_date,
        GREATEST(0, EXTRACT(EPOCH FROM (NOW() - (i.created_at + interval '30 days'))) / 86400)::int AS days_overdue
      FROM invoices i
      JOIN clients c ON c.id = i.client_id
      WHERE i.company_id = ${companyId}
        AND i.status IN ('sent','overdue')
      ORDER BY days_overdue DESC
    `);

    const data = (rows.rows as any[]).map(r => ({
      id: r.id, status: r.status, total: parseF(r.total),
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

    const rows = await db.execute(sql`
      SELECT
        j.id, j.scheduled_date, j.service_type, j.base_fee,
        j.allowed_hours, j.actual_hours,
        c.first_name AS client_first, c.last_name AS client_last,
        u.first_name AS emp_first, u.last_name AS emp_last,
        u.pay_rate, u.pay_type,
        COALESCE(
          CASE u.pay_type
            WHEN 'hourly' THEN u.pay_rate::numeric * COALESCE(j.actual_hours, j.allowed_hours, 0)::numeric
            WHEN 'per_job' THEN u.pay_rate::numeric
            WHEN 'fee_split' THEN j.base_fee::numeric * COALESCE(u.fee_split_pct, j.fee_split_pct, 0)::numeric / 100
            ELSE 0
          END, 0
        ) AS labor_cost
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
      LEFT JOIN users u ON u.id = j.assigned_user_id
      WHERE j.company_id = ${companyId}
        AND j.status = 'complete'
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      ORDER BY j.scheduled_date DESC
      LIMIT 500
    `);

    const data = (rows.rows as any[]).map(r => {
      const revenue = parseF(r.base_fee);
      const labor   = parseF(r.labor_cost);
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

    const weekData = await Promise.all(weeks.map(async w => {
      const revRow = await db.execute(sql`
        SELECT coalesce(sum(base_fee), 0) AS revenue, count(*) AS jobs
        FROM jobs WHERE company_id=${companyId} AND status='complete'
          AND scheduled_date BETWEEN ${w.start} AND ${w.end}
      `);
      const payRow = await db.execute(sql`
        SELECT coalesce(sum(
          CASE u.pay_type
            WHEN 'hourly' THEN u.pay_rate::numeric * COALESCE(j.actual_hours, j.allowed_hours, 0)::numeric
            WHEN 'per_job' THEN u.pay_rate::numeric
            WHEN 'fee_split' THEN j.base_fee::numeric * COALESCE(u.fee_split_pct, j.fee_split_pct, 0)::numeric / 100
            ELSE 0
          END
        ), 0) AS payroll
        FROM jobs j JOIN users u ON u.id = j.assigned_user_id
        WHERE j.company_id=${companyId} AND j.status='complete'
          AND j.scheduled_date BETWEEN ${w.start} AND ${w.end}
      `);
      const addPayRow = await db.execute(sql`
        SELECT coalesce(sum(amount), 0) AS add_pay FROM additional_pay
        WHERE company_id=${companyId} AND created_at::date BETWEEN ${w.start} AND ${w.end}
      `);

      const revenue = parseF((revRow.rows[0] as any)?.revenue);
      const payroll = parseF((payRow.rows[0] as any)?.payroll) + parseF((addPayRow.rows[0] as any)?.add_pay);
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

    const employees = await db.select({ id: usersTable.id, first_name: usersTable.first_name, last_name: usersTable.last_name, pay_rate: usersTable.pay_rate, pay_type: usersTable.pay_type, fee_split_pct: usersTable.fee_split_pct })
      .from(usersTable).where(and(eq(usersTable.company_id, companyId), eq(usersTable.is_active, true), ne(usersTable.role, "owner")));

    const rows = await Promise.all(employees.map(async emp => {
      const jobsRes = await db.execute(sql`
        SELECT j.id, j.base_fee, j.allowed_hours, j.actual_hours, j.fee_split_pct, j.scheduled_date, j.service_type,
          COALESCE(
            CASE ${sql.raw(`'${emp.pay_type}'`)}
              WHEN 'hourly' THEN ${emp.pay_rate || 0}::numeric * COALESCE(j.actual_hours, j.allowed_hours, 0)::numeric
              WHEN 'per_job' THEN ${emp.pay_rate || 0}::numeric
              WHEN 'fee_split' THEN j.base_fee::numeric * COALESCE(${emp.fee_split_pct || 0}::numeric, j.fee_split_pct::numeric, 0) / 100
              ELSE 0
            END, 0) AS base_pay
        FROM jobs j WHERE j.company_id=${companyId} AND j.assigned_user_id=${emp.id}
          AND j.status='complete' AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      `);

      const clockRes = await db.execute(sql`
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (clock_out_at - clock_in_at))/3600), 0) AS clock_hours,
          COUNT(*) FILTER (WHERE clock_out_at IS NULL) AS missing_outs,
          COUNT(DISTINCT scheduled_date::date) AS days_worked
        FROM timeclock t JOIN jobs j ON j.id = t.job_id
        WHERE t.company_id=${companyId} AND t.user_id=${emp.id}
          AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr}
      `);

      const addPayRes = await db.execute(sql`
        SELECT type, coalesce(sum(amount), 0) AS total FROM additional_pay
        WHERE company_id=${companyId} AND user_id=${emp.id}
          AND created_at::date BETWEEN ${fromStr} AND ${toStr}
        GROUP BY type
      `);

      const jobs = jobsRes.rows as any[];
      const clk  = clockRes.rows[0] as any;
      const addPay = addPayRes.rows as any[];
      const base_pay = jobs.reduce((s, j) => s + parseF(j.base_pay), 0);
      const tips     = addPay.filter(p => p.type === "tips").reduce((s, p) => s + parseF(p.total), 0);
      const add_pay  = addPay.filter(p => p.type !== "tips").reduce((s, p) => s + parseF(p.total), 0);
      const job_hrs  = jobs.reduce((s, j) => s + parseF(j.allowed_hours || j.actual_hours || 0), 0);
      const clk_hrs  = parseF(clk?.clock_hours);
      const overtime = Math.max(0, clk_hrs - 40) * parseF(emp.pay_rate || 0) * 0.5;

      return {
        id: emp.id, name: `${emp.first_name} ${emp.last_name}`, pay_type: emp.pay_type,
        days_worked: parseN(clk?.days_worked), job_hours: job_hrs, clock_hours: clk_hrs,
        base_pay, tips, additional_pay: add_pay, overtime, deductions: 0, gross_pay: base_pay + tips + add_pay + overtime,
        missing_clk_outs: parseN(clk?.missing_outs), jobs_count: jobs.length,
      };
    }));

    // Flags
    const missingClocks = await db.execute(sql`
      SELECT j.id, c.first_name, c.last_name, j.scheduled_date, j.service_type
      FROM jobs j JOIN clients c ON c.id=j.client_id
      LEFT JOIN timeclock t ON t.job_id=j.id
      WHERE j.company_id=${companyId} AND j.status='complete'
        AND j.scheduled_date BETWEEN ${fromStr} AND ${toStr} AND t.id IS NULL LIMIT 20
    `);
    const unclockedOut = await db.execute(sql`
      SELECT u.first_name, u.last_name, t.clock_in_at FROM timeclock t JOIN users u ON u.id=t.user_id
      WHERE t.company_id=${companyId} AND t.clock_out_at IS NULL
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
      const rev = await db.execute(sql`SELECT coalesce(sum(base_fee),0) AS revenue, count(*) AS jobs, coalesce(avg(base_fee),0) AS avg_bill FROM jobs WHERE company_id=${companyId} AND status='complete' AND scheduled_date BETWEEN ${start} AND ${end}`);
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
      const r = await db.execute(sql`SELECT coalesce(sum(base_fee),0) AS revenue, coalesce(avg(sc.score),0) AS quality FROM jobs j LEFT JOIN scorecards sc ON sc.job_id=j.id AND sc.excluded=false WHERE j.company_id=${companyId} AND j.status='complete' AND j.scheduled_date BETWEEN ${wStart} AND ${wEnd}`);
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

    return res.json({
      from: fromStr, to: toStr, data,
      summary: {
        total: data.length,
        avg_tenure_days: data.length > 0 ? data.reduce((s, r) => s + r.tenure_days, 0) / data.length : 0,
        revenue_lost: data.reduce((s, r) => s + r.bill_rate, 0),
      },
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
        c.first_name AS client_first, c.last_name AS client_last, c.address, c.city, c.notes AS client_notes,
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
        AND j.status IN ('scheduled','in_progress')
      ORDER BY j.scheduled_time NULLS LAST
    `);

    const data = (rows.rows as any[]).map(r => ({
      id: r.id, time: r.scheduled_time, service_type: r.service_type, status: r.status,
      client_name: `${r.client_first} ${r.client_last}`,
      address: r.address, city: r.city,
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
