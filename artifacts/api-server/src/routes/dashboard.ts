import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, clientsTable, usersTable, invoicesTable, timeclockTable, scorecardsTable, accountsTable, accountPropertiesTable, quotesTable, recurringSchedulesTable } from "@workspace/db/schema";
import { eq, and, or, gte, lte, lt, isNull, count, sum, avg, desc, sql, isNotNull, ne, notInArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { jobRevenueExpr } from "../lib/job-revenue-sql.js";
import { computeCommissionRows, type CommissionInputJob } from "../lib/commission-compute.js";
import { parseResRatesRow } from "../lib/commission-rates.js";

const router = Router();

// [tech-boundary 2026-06-17] All /api/dashboard routes are office-tier
// only. Was zero requireRole calls before this PR — a tech with the
// URL could pull /metrics, /today, /kpis, /revenue-chart, etc. The
// payload includes per-employee performance and company financials
// that techs should never see.
const officeGate = requireRole("owner", "admin", "office", "super_admin");

// ── Weekly forecast in-memory cache (5 min TTL, keyed by companyId + week start) ──
const wfCache = new Map<string, { data: unknown; ts: number }>();

router.get("/metrics", requireAuth, officeGate, async (req, res) => {
  try {
    const { period = "week", branch_id } = req.query;
    const branchFilter = branch_id && branch_id !== "all" ? parseInt(branch_id as string) : null;

    const now = new Date();
    let dateFrom: Date;
    switch (period) {
      case "today":
        dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case "month":
        dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case "year":
        dateFrom = new Date(now.getFullYear(), 0, 1);
        break;
      default:
        dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    const dateFromStr = dateFrom.toISOString().split("T")[0];

    const jobBranchCond = branchFilter ? [eq(jobsTable.branch_id, branchFilter)] : [];
    const invBranchCond = branchFilter ? [eq(invoicesTable.branch_id, branchFilter)] : [];
    const clientBranchCond = branchFilter ? [eq(clientsTable.branch_id, branchFilter)] : [];

    const [scheduledCount, inProgressCount, completedCount, cancelledCount] = await Promise.all([
      db.select({ count: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, req.auth!.companyId), eq(jobsTable.status, "scheduled"), gte(jobsTable.scheduled_date, dateFromStr), ...jobBranchCond)),
      db.select({ count: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, req.auth!.companyId), eq(jobsTable.status, "in_progress"), ...jobBranchCond)),
      db.select({ count: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, req.auth!.companyId), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, dateFromStr), ...jobBranchCond)),
      db.select({ count: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, req.auth!.companyId), eq(jobsTable.status, "cancelled"), gte(jobsTable.scheduled_date, dateFromStr), ...jobBranchCond)),
    ]);

    const revenueResult = await db
      .select({ total: sum(invoicesTable.total), tips: sum(invoicesTable.tips) })
      .from(invoicesTable)
      .where(and(
        eq(invoicesTable.company_id, req.auth!.companyId),
        eq(invoicesTable.status, "paid"),
        gte(invoicesTable.created_at, dateFrom),
        ...invBranchCond
      ));

    const activeClients = await db
      .select({ count: count() })
      .from(clientsTable)
      .where(and(eq(clientsTable.company_id, req.auth!.companyId), ...clientBranchCond));

    const activeEmployees = await db
      .select({ count: count() })
      .from(usersTable)
      .where(and(
        eq(usersTable.company_id, req.auth!.companyId),
        eq(usersTable.is_active, true)
      ));

    const scoreAvg = await db
      .select({ avg: avg(scorecardsTable.score) })
      .from(scorecardsTable)
      .where(and(
        eq(scorecardsTable.company_id, req.auth!.companyId),
        eq(scorecardsTable.excluded, false),
        gte(scorecardsTable.created_at, dateFrom)
      ));

    const flaggedCount = await db
      .select({ count: count() })
      .from(timeclockTable)
      .where(and(
        eq(timeclockTable.company_id, req.auth!.companyId),
        eq(timeclockTable.flagged, true),
        gte(timeclockTable.clock_in_at, dateFrom)
      ));

    const topEmployees = await db
      .select({
        user_id: usersTable.id,
        name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        jobs_completed: count(jobsTable.id),
      })
      .from(usersTable)
      .leftJoin(jobsTable, and(
        eq(jobsTable.assigned_user_id, usersTable.id),
        eq(jobsTable.status, "complete"),
        gte(jobsTable.scheduled_date, dateFromStr)
      ))
      .where(and(
        eq(usersTable.company_id, req.auth!.companyId),
        eq(usersTable.is_active, true),
        eq(usersTable.role, "technician"),
        ne(usersTable.first_name, "Francisco"),
        ne(usersTable.first_name, "Maribel")
      ))
      .groupBy(usersTable.id)
      .orderBy(desc(count(jobsTable.id)))
      .limit(5);

    const recentJobs = await db
      .select({
        id: jobsTable.id,
        client_id: jobsTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        assigned_user_id: jobsTable.assigned_user_id,
        assigned_user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        frequency: jobsTable.frequency,
        base_fee: jobsTable.base_fee,
        allowed_hours: jobsTable.allowed_hours,
        actual_hours: jobsTable.actual_hours,
        notes: jobsTable.notes,
        created_at: jobsTable.created_at,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(eq(jobsTable.company_id, req.auth!.companyId))
      .orderBy(desc(jobsTable.created_at))
      .limit(10);

    return res.json({
      period,
      jobs_scheduled: scheduledCount[0].count,
      jobs_completed: completedCount[0].count,
      jobs_in_progress: inProgressCount[0].count,
      jobs_cancelled: cancelledCount[0].count,
      total_revenue: parseFloat(revenueResult[0]?.total || "0"),
      total_tips: parseFloat(revenueResult[0]?.tips || "0"),
      active_clients: activeClients[0].count,
      active_employees: activeEmployees[0].count,
      avg_job_score: scoreAvg[0].avg ? parseFloat(scoreAvg[0].avg) : null,
      flagged_clock_ins: flaggedCount[0].count,
      top_employees: topEmployees.map(e => ({ ...e, avg_score: null })),
      recent_jobs: recentJobs.map(j => ({
        ...j,
        before_photo_count: 0,
        after_photo_count: 0,
      })),
    });
  } catch (err) {
    console.error("Dashboard metrics error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get dashboard metrics" });
  }
});

router.get("/today", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const tomorrowStr = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString().split("T")[0];
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const { branch_id } = req.query;
    const todayBranchCond = branch_id && branch_id !== "all" ? [eq(jobsTable.branch_id, parseInt(branch_id as string))] : [];

    const [todayJobs, inProgress, complete, cancelled, scheduled] = await Promise.all([
      db.select({
        id: jobsTable.id,
        status: jobsTable.status,
        scheduled_time: jobsTable.scheduled_time,
        assigned_user_id: jobsTable.assigned_user_id,
        client_name: sql<string>`concat(${clientsTable.first_name},' ',${clientsTable.last_name})`,
        base_fee: jobsTable.base_fee,
        account_id: jobsTable.account_id,
        hourly_rate: jobsTable.hourly_rate,
        allowed_hours: jobsTable.allowed_hours,
        client_type: clientsTable.client_type,
      })
        .from(jobsTable)
        .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.scheduled_date, todayStr), ...todayBranchCond)),
      db.select({ c: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "in_progress"), eq(jobsTable.scheduled_date, todayStr), ...todayBranchCond)),
      db.select({ c: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), eq(jobsTable.scheduled_date, todayStr), ...todayBranchCond)),
      db.select({ c: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "cancelled"), eq(jobsTable.scheduled_date, todayStr), ...todayBranchCond)),
      db.select({ c: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "scheduled"), eq(jobsTable.scheduled_date, todayStr), ...todayBranchCond)),
    ]);

    // Commercial work bills hourly_rate × allowed_hours (matching MaidCentral
    // and the dispatch board); residential uses the stored fee.
    const todayRevenue = todayJobs.filter(j => j.status === 'complete').reduce((s, j) => {
      const rate = parseFloat((j as any).hourly_rate || '0');
      const hrs = parseFloat((j as any).allowed_hours || '0');
      const commercial = (j as any).account_id != null || (j as any).client_type === 'commercial';
      if (commercial && rate > 0 && hrs > 0) return s + rate * hrs;
      return s + parseFloat(j.base_fee || '0');
    }, 0);

    // Flagged clock-ins today — get both full count AND detail list separately
    const [flaggedCountRow, flagged] = await Promise.all([
      db.select({ c: count() }).from(timeclockTable)
        .where(and(eq(timeclockTable.company_id, companyId), eq(timeclockTable.flagged, true), gte(timeclockTable.clock_in_at, new Date(todayStr)), lt(timeclockTable.clock_in_at, new Date(tomorrowStr)))),
      db.select({
        id: timeclockTable.id,
        user_id: timeclockTable.user_id,
        distance_ft: timeclockTable.distance_from_job_ft,
        user_name: sql<string>`concat(${usersTable.first_name},' ',${usersTable.last_name})`,
      })
        .from(timeclockTable)
        .leftJoin(usersTable, eq(timeclockTable.user_id, usersTable.id))
        .where(and(eq(timeclockTable.company_id, companyId), eq(timeclockTable.flagged, true), gte(timeclockTable.clock_in_at, new Date(todayStr)), lt(timeclockTable.clock_in_at, new Date(tomorrowStr))))
        .limit(5),
    ]);

    const overdueInvoices = await db
      .select({
        id: invoicesTable.id,
        total: invoicesTable.total,
        client_name: sql<string>`concat(${clientsTable.first_name},' ',${clientsTable.last_name})`,
        created_at: invoicesTable.created_at,
      })
      .from(invoicesTable)
      .leftJoin(clientsTable, eq(invoicesTable.client_id, clientsTable.id))
      .where(and(eq(invoicesTable.company_id, companyId), eq(invoicesTable.status, "overdue")))
      .limit(5);

    const allEmployees = await db
      .select({
        id: usersTable.id,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
        avatar_url: usersTable.avatar_url,
        role: usersTable.role,
      })
      .from(usersTable)
      .where(and(eq(usersTable.company_id, companyId), eq(usersTable.is_active, true)));

    const activeClockins = await db
      .select({
        user_id: timeclockTable.user_id,
        clock_in_at: timeclockTable.clock_in_at,
        job_id: timeclockTable.job_id,
      })
      .from(timeclockTable)
      .where(and(
        eq(timeclockTable.company_id, companyId),
        gte(timeclockTable.clock_in_at, new Date(todayStr)),
        lt(timeclockTable.clock_in_at, new Date(tomorrowStr)),
        isNull(timeclockTable.clock_out_at),
      ));

    const nowMs = now.getTime();
    const employeeBoard = allEmployees.map(emp => {
      const empJobs = todayJobs.filter(j => j.assigned_user_id === emp.id);
      const activeClock = activeClockins.find(c => c.user_id === emp.id);
      const currentJob = empJobs.find(j => j.status === 'in_progress') || (activeClock ? empJobs[0] : null);

      let status: string;
      let detail = '';

      if (activeClock) {
        status = 'ON JOB';
        const elapsedMin = Math.floor((nowMs - new Date(activeClock.clock_in_at).getTime()) / 60000);
        const h = Math.floor(elapsedMin / 60), m = elapsedMin % 60;
        detail = currentJob ? `${currentJob.client_name} · ${h}h ${m}m` : `${elapsedMin}min elapsed`;
      } else if (empJobs.length === 0) {
        status = 'OFF TODAY';
      } else if (empJobs.every(j => j.status === 'complete')) {
        status = 'COMPLETE';
      } else {
        const nextJob = empJobs.find(j => j.status === 'scheduled' && j.scheduled_time);
        if (nextJob?.scheduled_time) {
          const [h, m] = nextJob.scheduled_time.split(':').map(Number);
          const jobMs = new Date(todayStr + 'T00:00:00').setHours(h, m);
          const diffMin = (jobMs - nowMs) / 60000;
          if (diffMin > 0 && diffMin <= 30) {
            status = 'EN ROUTE';
            detail = `Job in ${Math.floor(diffMin)}min`;
          } else {
            status = 'SCHEDULED';
            detail = `${empJobs.length} job${empJobs.length > 1 ? 's' : ''} today`;
          }
        } else {
          status = 'SCHEDULED';
          detail = `${empJobs.length} job${empJobs.length > 1 ? 's' : ''} today`;
        }
      }

      return { ...emp, status, detail, job_count: empJobs.length };
    });

    const alerts: { type: string; message: string; action: string; id?: number }[] = [];
    const now15min = new Date(nowMs + 15 * 60 * 1000);
    for (const emp of employeeBoard) {
      if (emp.status === 'SCHEDULED') {
        const empJobs = todayJobs.filter(j => j.assigned_user_id === emp.id && j.scheduled_time);
        for (const job of empJobs) {
          const [h, m] = (job.scheduled_time || '').split(':').map(Number);
          const jobMs = new Date(todayStr + 'T00:00:00').setHours(h, m);
          if (jobMs <= now15min.getTime() && jobMs >= nowMs - 15 * 60 * 1000) {
            alerts.push({
              type: 'warning',
              message: `${emp.first_name} ${emp.last_name} hasn't clocked in — job starts${jobMs > nowMs ? ` in ${Math.floor((jobMs - nowMs) / 60000)} min` : ' now'}`,
              action: 'call_employee',
              id: emp.id,
            });
          }
        }
      }
    }
    for (const inv of overdueInvoices) {
      const daysAgo = Math.floor((nowMs - new Date(inv.created_at).getTime()) / (1000 * 60 * 60 * 24));
      alerts.push({ type: 'warning', message: `Invoice #${inv.id} overdue by ${daysAgo} days — ${inv.client_name}`, action: 'send_invoice', id: inv.id });
    }
    for (const flag of flagged) {
      alerts.push({ type: 'warning', message: `Clock-in flagged — ${flag.user_name} was ${flag.distance_ft}ft from job site`, action: 'review_clock', id: flag.id });
    }

    const enRouteCount = employeeBoard.filter(e => e.status === 'EN ROUTE').length;

    // Counts for status chips — scoped to today
    // unassigned: status='scheduled' AND assigned_user_id IS NULL (per spec)
    const unassignedCount = todayJobs.filter(j => j.assigned_user_id === null && j.status === 'scheduled').length;
    // Use the dedicated COUNT query for accurate flagged count (not limited by detail LIMIT 5)
    const flaggedCount = Number(flaggedCountRow[0]?.c || 0);

    // [today-view 2026-07-08] Owner-useful partition of the day. The old tiles
    // showed status='scheduled' as "Scheduled" (9) which read as the day's
    // TOTAL when it was only the not-yet-done ones (the day actually has
    // scheduled + in_progress + complete = 18). And "In Progress" sat at 0
    // because Phes jobs go scheduled→complete via the clock without ever being
    // stamped 'in_progress' (Sal: "jobs in progress makes no sense"). New:
    // Scheduled Today = the real total, Remaining = still to do. Cancelled is
    // excluded from the day's total.
    const inProgressN = Number(inProgress[0].c);
    const scheduledN = Number(scheduled[0].c);
    const completeN = Number(complete[0].c);
    return res.json({
      counts: {
        in_progress: inProgressN,
        scheduled: scheduledN,
        complete: completeN,
        cancelled: Number(cancelled[0].c),
        en_route: enRouteCount,
        flagged: flaggedCount,
        unassigned: unassignedCount,
        scheduled_total: inProgressN + scheduledN + completeN,
        remaining: inProgressN + scheduledN,
      },
      today_revenue: todayRevenue,
      alerts,
      employee_board: employeeBoard,
    });
  } catch (err) {
    console.error("Dashboard today error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/kpis", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const tomorrowStr = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString().split("T")[0];

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthStartStr = monthStart.toISOString().split("T")[0];
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    const lastMonthStartStr = lastMonthStart.toISOString().split("T")[0];
    const lastMonthEndStr = lastMonthEnd.toISOString().split("T")[0];

    const dayOfWeek = now.getDay();
    const daysToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysToMon);
    const weekStartStr = weekStart.toISOString().split("T")[0];
    // [week-revenue-fullweek 2026-07-08] Full week end (Sunday). "Revenue this
    // week" must count the WHOLE week's booked schedule, not just up to today —
    // Sal: "for the week it should count jobs as they are added to the schedule
    // (or deduct)." Capping at today dropped every Thu-Sun job already on the
    // books, so the number read low and the vs-prior-week delta (which uses the
    // full prior week) was apples-to-oranges (a phantom -45%).
    const weekEndStr = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const prevWeekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const prevWeekStartStr = prevWeekStart.toISOString().split("T")[0];
    const prevWeekEndStr = new Date(weekStart.getTime() - 1).toISOString().split("T")[0];

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];
    const fortyFiveDaysAgoStr = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    // Next 7 days window
    const next7Start = todayStr;
    const next7End = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const [
      jhWeekRev,
      jhPrevWeekRev,
      jhMonthRev,
      jhLastMonthRev,
      jhAvgBill,
      avgScore,
      activeClients,
      atRiskResult,
      unassignedToday,
      flaggedToday,
      overdueInvoices,
      completeNotInvoiced,
      // HouseCall Pro KPI bar
      hcpRevBookedToday,
      hcpNewJobsThisWeek,
      hcpQuotesToday,
      hcpBookedOnlineMonth,
      // Next 7 days
      next7Rev,
      next7Count,
      // Recurring count
      recurringCount,
      // Outstanding AR
      outstandingAR,
      // Completed jobs not invoiced (last 30 days)
      completeNotInvoiced30,
      // Techs with jobs today but no clock-in
      techsNoClockin,
      // Jobs in next 7 days missing address_street
      jobsMissingAddress,
      // Invoice sequence check
      invoiceHighId,
    ] = await Promise.all([
      // Week revenue — from jobs (booked/realized). job_history is the legacy
      // billed-history table and is empty for tenants that didn't import it
      // (fresh-start tenants showed a blank "—"). Sum the period's
      // non-cancelled jobs by billed_amount when invoiced, else base_fee.
      db.execute(sql`
        SELECT COALESCE(SUM(${jobRevenueExpr(sql`COALESCE(j.billed_amount, j.base_fee, 0)`)}), 0)::numeric AS total
        FROM jobs j
        LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId}
          AND j.status != 'cancelled'
          AND j.scheduled_date >= ${weekStartStr}
          AND j.scheduled_date <= ${weekEndStr}
      `),
      // Previous week revenue (for delta calculation)
      db.execute(sql`
        SELECT COALESCE(SUM(${jobRevenueExpr(sql`COALESCE(j.billed_amount, j.base_fee, 0)`)}), 0)::numeric AS total
        FROM jobs j
        LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId}
          AND j.status != 'cancelled'
          AND j.scheduled_date >= ${prevWeekStartStr}
          AND j.scheduled_date <= ${prevWeekEndStr}
      `),
      // This month revenue (MTD)
      db.execute(sql`
        SELECT COALESCE(SUM(${jobRevenueExpr(sql`COALESCE(j.billed_amount, j.base_fee, 0)`)}), 0)::numeric AS total
        FROM jobs j
        LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId}
          AND j.status != 'cancelled'
          AND j.scheduled_date >= ${monthStartStr}
          AND j.scheduled_date <= ${todayStr}
      `),
      // Last month revenue (for delta calculation)
      db.execute(sql`
        SELECT COALESCE(SUM(${jobRevenueExpr(sql`COALESCE(j.billed_amount, j.base_fee, 0)`)}), 0)::numeric AS total
        FROM jobs j
        LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId}
          AND j.status != 'cancelled'
          AND j.scheduled_date >= ${lastMonthStartStr}
          AND j.scheduled_date <= ${lastMonthEndStr}
      `),
      // Avg bill — last 30 days (exclude $0 jobs so the average is meaningful)
      db.execute(sql`
        SELECT COALESCE(AVG(${jobRevenueExpr(sql`COALESCE(j.billed_amount, j.base_fee, 0)`)}), 0)::numeric AS avg_bill
        FROM jobs j
        LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId}
          AND j.status != 'cancelled'
          AND ${jobRevenueExpr(sql`COALESCE(j.billed_amount, j.base_fee, 0)`)} > 0
          AND j.scheduled_date >= ${thirtyDaysAgoStr}
          AND j.scheduled_date <= ${todayStr}
      `),
      // Avg quality score (last 90 days)
      db.execute(sql`
        SELECT AVG(score)::numeric AS avg_score
        FROM scorecards
        WHERE company_id = ${companyId}
          AND created_at >= ${ninetyDaysAgo}
      `),
      // Active clients count
      db.select({ count: count() }).from(clientsTable)
        .where(and(eq(clientsTable.company_id, companyId), eq(clientsTable.is_active, true))),
      // At-risk: active clients with past completed jobs but no service in last 45 days
      db.execute(sql`
        SELECT COUNT(DISTINCT c.id)::int AS at_risk
        FROM clients c
        WHERE c.company_id = ${companyId}
          AND c.is_active = true
          AND EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.client_id = c.id AND j.company_id = ${companyId} AND j.status = 'complete'
          )
          AND NOT EXISTS (
            SELECT 1 FROM jobs j2
            WHERE j2.client_id = c.id
              AND j2.company_id = ${companyId}
              AND j2.scheduled_date >= ${fortyFiveDaysAgoStr}
          )
          AND c.created_at < now() - interval '30 days'
      `),
      // Unassigned jobs today: status='scheduled' AND assigned_user_id IS NULL (per spec)
      db.select({ count: count() }).from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.scheduled_date, todayStr), eq(jobsTable.status, "scheduled"), isNull(jobsTable.assigned_user_id))),
      // Flagged clock-ins today (bounded to today only)
      db.select({ count: count() }).from(timeclockTable)
        .where(and(eq(timeclockTable.company_id, companyId), eq(timeclockTable.flagged, true), gte(timeclockTable.clock_in_at, new Date(todayStr)), lt(timeclockTable.clock_in_at, new Date(tomorrowStr)))),
      // Overdue invoices
      db.select({ count: count() }).from(invoicesTable)
        .where(and(eq(invoicesTable.company_id, companyId), eq(invoicesTable.status, "overdue"))),
      // Jobs complete but not invoiced (this month) — kept for legacy
      db.select({ id: jobsTable.id }).from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, monthStartStr)))
        .then(async (completedJobs) => {
          if (completedJobs.length === 0) return [{ count: 0 }];
          const invoicedJobIds = await db.select({ job_id: invoicesTable.job_id }).from(invoicesTable)
            .where(and(eq(invoicesTable.company_id, companyId), isNotNull(invoicesTable.job_id)));
          const invoicedSet = new Set(invoicedJobIds.map(i => i.job_id));
          return [{ count: completedJobs.filter(j => !invoicedSet.has(j.id)).length }];
        }),

      // HCP: Revenue Booked Today (jobs scheduled today, sum base_fee, excluding cancelled)
      db.select({ total: sum(jobsTable.base_fee) }).from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.scheduled_date, todayStr),
          sql`${jobsTable.status} != 'cancelled'`,
        )),

      // HCP: Jobs Booked TODAY (Sal: "new jobs booked should only be jobs
      // booked today"). Count bookings CREATED today (Chicago), non-cancelled,
      // excluding recurring-engine occurrences (recurring_schedule_id set —
      // one new recurring client generates many future occurrences with
      // today's created_at; we count the booking, not every generated visit).
      // [booked-today-drilldown 2026-07-22] The tile links to
      // /reports/jobs?booked_on=<today>, whose `booked_on` filter in
      // buildJobWhereClause (routes/jobs.ts) mirrors these three predicates.
      // Change one, change the other or the count won't match the list it opens.
      db.select({ c: count() }).from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, companyId),
          sql`(${jobsTable.created_at} AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date`,
          isNull(jobsTable.recurring_schedule_id),
          sql`${jobsTable.status} != 'cancelled'`,
        )),

      // HCP: Quotes Given Today
      db.select({ c: count() }).from(quotesTable)
        .where(and(
          eq(quotesTable.company_id, companyId),
          gte(quotesTable.created_at, new Date(todayStr)),
        )),

      // HCP: Booked Online This Month (jobs created via online booking this month)
      db.select({ c: count() }).from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, companyId),
          gte(jobsTable.scheduled_date, monthStartStr),
          sql`${jobsTable.status} != 'cancelled'`,
        )),

      // Next 7 days revenue
      db.execute(sql`
        SELECT COALESCE(SUM(${jobRevenueExpr(sql`COALESCE(j.billed_amount, j.base_fee, 0)`)}), 0)::numeric AS total
        FROM jobs j
        LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId}
          AND j.status != 'cancelled'
          AND j.scheduled_date >= ${next7Start}
          AND j.scheduled_date <= ${next7End}
      `),

      // Next 7 days job count
      db.select({ c: count() }).from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, companyId),
          gte(jobsTable.scheduled_date, next7Start),
          lte(jobsTable.scheduled_date, next7End),
          sql`${jobsTable.status} != 'cancelled'`,
        )),

      // Recurring schedules active count
      db.select({ count: count() }).from(recurringSchedulesTable)
        .where(and(
          eq(recurringSchedulesTable.company_id, companyId),
          eq(recurringSchedulesTable.is_active, true),
        )),

      // Outstanding AR — invoices status IN ('sent', 'overdue')
      // Note: schema enum only has draft/sent/paid/overdue — 'unpaid' is not a valid enum value
      db.execute(sql`
        SELECT
          COUNT(*)::int AS inv_count,
          COALESCE(SUM(total), 0)::numeric AS total,
          COUNT(CASE WHEN created_at < now() - interval '30 days' THEN 1 END)::int AS over_30
        FROM invoices
        WHERE company_id = ${companyId}
          AND status IN ('sent', 'overdue')
      `),

      // Completed jobs in last 30 days not invoiced
      db.select({ id: jobsTable.id }).from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.status, "complete"),
          gte(jobsTable.scheduled_date, thirtyDaysAgoStr),
          lte(jobsTable.scheduled_date, todayStr),
        ))
        .then(async (completedJobs) => {
          if (completedJobs.length === 0) return 0;
          const invoicedJobIds = await db.select({ job_id: invoicesTable.job_id }).from(invoicesTable)
            .where(and(eq(invoicesTable.company_id, companyId), isNotNull(invoicesTable.job_id)));
          const invoicedSet = new Set(invoicedJobIds.map(i => i.job_id));
          return completedJobs.filter(j => !invoicedSet.has(j.id)).length;
        }),

      // Techs with jobs today but no clock-in entry today
      db.execute(sql`
        SELECT COUNT(DISTINCT j.assigned_user_id)::int AS tech_count
        FROM jobs j
        WHERE j.company_id = ${companyId}
          AND j.scheduled_date = ${todayStr}
          AND j.status != 'cancelled'
          AND j.assigned_user_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM timeclock tc
            WHERE tc.user_id = j.assigned_user_id
              AND tc.company_id = ${companyId}
              AND tc.clock_in_at >= ${todayStr}::date
              AND tc.clock_in_at < ${tomorrowStr}::date
          )
      `),

      // Jobs in next 7 days missing address_street
      db.select({ count: count() }).from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, companyId),
          gte(jobsTable.scheduled_date, next7Start),
          lte(jobsTable.scheduled_date, next7End),
          sql`${jobsTable.status} != 'cancelled'`,
          isNull(jobsTable.address_street),
        )),

      // Check if any invoice with id >= 6082 exists
      db.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM invoices WHERE company_id = ${companyId} AND id >= 6082
      `),
    ]);

    type SqlRow = Record<string, unknown>;
    function rowStr(row: SqlRow | undefined, key: string): string { return String(row?.[key] ?? "0"); }
    function rowNum(row: SqlRow | undefined, key: string): number { return Number(row?.[key] ?? 0); }

    const weekRevNum = parseFloat(rowStr(jhWeekRev.rows[0], 'total'));
    const prevWeekRevNum = parseFloat(rowStr(jhPrevWeekRev.rows[0], 'total'));
    const weekDelta = prevWeekRevNum > 0 ? Math.round(((weekRevNum - prevWeekRevNum) / prevWeekRevNum) * 100) : null;

    const monthRevNum = parseFloat(rowStr(jhMonthRev.rows[0], 'total'));
    const lastMonthRevNum = parseFloat(rowStr(jhLastMonthRev.rows[0], 'total'));
    const monthDelta = lastMonthRevNum > 0 ? Math.round(((monthRevNum - lastMonthRevNum) / lastMonthRevNum) * 100) : null;

    const avgBill = parseFloat(rowStr(jhAvgBill.rows[0], 'avg_bill'));
    const qualityScoreRaw = avgScore.rows[0]?.['avg_score'];
    const qualityScore = qualityScoreRaw != null ? Math.round(parseFloat(String(qualityScoreRaw))) : null;
    const atRiskRaw = rowNum(atRiskResult.rows[0], 'at_risk');
    const unassigned = Number(unassignedToday[0]?.count || 0);
    const flagged = Number(flaggedToday[0]?.count || 0);
    const overdue = Number(overdueInvoices[0]?.count || 0);
    const notInvoiced = Number((completeNotInvoiced as Array<{ count: number }>)[0]?.count || 0);
    const clientsAtRisk = atRiskRaw;

    const next7RevNum = parseFloat(rowStr(next7Rev.rows[0], 'total'));
    const next7CountNum = Number(next7Count[0]?.c || 0);
    const recurringCountNum = Number(recurringCount[0]?.count || 0);

    const arRow = outstandingAR.rows[0];
    const arCount = rowNum(arRow, 'inv_count');
    const arTotal = parseFloat(rowStr(arRow, 'total'));
    const arOver30 = rowNum(arRow, 'over_30');

    const notInvoiced30 = typeof completeNotInvoiced30 === 'number' ? completeNotInvoiced30 : 0;
    const techsNoClockinNum = rowNum(techsNoClockin.rows[0], 'tech_count');
    const jobsMissingAddrNum = Number(jobsMissingAddress[0]?.count || 0);
    const hasInvoiceHighId = rowNum(invoiceHighId.rows[0], 'cnt') > 0;

    // HCP values (hcpRevBookedToday uses sum() → string|null; hcpNew/Quotes/Booked use count() → number)
    const revBookedToday = parseFloat(String(hcpRevBookedToday[0]?.total ?? "0"));
    const newJobsToday = Number(hcpNewJobsThisWeek[0]?.c || 0);
    const quotesGivenToday = Number(hcpQuotesToday[0]?.c || 0);
    const bookedOnlineMonth = Number(hcpBookedOnlineMonth[0]?.c || 0);

    type ActionItem = { level: 'red' | 'amber' | 'blue'; title: string; text: string; action: string };
    const actions: ActionItem[] = [];

    // 1. Unassigned jobs today (red)
    if (unassigned > 0) {
      actions.push({
        level: 'red',
        title: 'Unassigned Jobs',
        text: `${unassigned} job${unassigned > 1 ? 's' : ''} today ${unassigned > 1 ? 'are' : 'is'} unassigned`,
        action: '/dispatch?status=unassigned',
      });
    }

    // 2. Outstanding AR (red)
    if (arCount > 0) {
      const arTotalFmt = arTotal >= 1000 ? `$${(arTotal / 1000).toFixed(1)}k` : `$${arTotal.toFixed(0)}`;
      actions.push({
        level: 'red',
        title: 'Outstanding AR',
        text: `${arCount} invoice${arCount > 1 ? 's' : ''} outstanding — ${arTotalFmt} total${arOver30 > 0 ? `, ${arOver30} over 30 days` : ''}`,
        action: '/invoices',
      });
    }

    // 3. Completed jobs not invoiced in last 30 days (amber)
    if (notInvoiced30 > 0) {
      actions.push({
        level: 'amber',
        title: 'Not Invoiced',
        text: `${notInvoiced30} completed job${notInvoiced30 > 1 ? 's' : ''} in last 30 days not yet invoiced`,
        action: '/invoices',
      });
    }

    // 4. Techs with jobs today but no clock-in (amber)
    if (techsNoClockinNum > 0) {
      actions.push({
        level: 'amber',
        title: 'Clocked In',
        text: `${techsNoClockinNum} tech${techsNoClockinNum > 1 ? 's' : ''} with jobs today but no clock-in`,
        action: '/clock-monitor',
      });
    }

    // 5. Static: Tammy McArcle card on file issue (blue)
    actions.push({
      level: 'blue',
      title: 'Card on File',
      text: 'Tammy McArcle — Card on file issue in Square.',
      action: '/clients',
    });

    // 6. Clients at risk (blue)
    if (atRiskRaw > 0) {
      actions.push({
        level: 'blue',
        title: 'Clients at Risk',
        text: `${atRiskRaw} client${atRiskRaw > 1 ? 's' : ''} with no booking in 45+ days`,
        action: '/clients?filter=at_risk',
      });
    }

    // 7. Jobs missing address (amber)
    if (jobsMissingAddrNum > 0) {
      actions.push({
        level: 'amber',
        title: 'Missing Address',
        text: `${jobsMissingAddrNum} job${jobsMissingAddrNum > 1 ? 's' : ''} in next 7 days missing street address`,
        action: '/jobs',
      });
    }

    // 8. Static invoice sequence note (blue, only if no invoices with id >= 6082)
    if (!hasInvoiceHighId) {
      actions.push({
        level: 'blue',
        title: 'Invoice Sequence',
        text: 'Invoice numbering sequence may need to be updated to match prior records.',
        action: '',
      });
    }

    return res.json({
      week_revenue: weekRevNum,
      week_delta: weekDelta,
      month_revenue: monthRevNum,
      month_delta: monthDelta,
      avg_bill: avgBill,
      active_clients: Number(activeClients[0]?.count || 0),
      recurring_count: recurringCountNum,
      quality_score: qualityScore,
      clients_at_risk: clientsAtRisk,
      churn_configured: true,
      next7_revenue: next7RevNum,
      next7_jobs: next7CountNum,
      action_items: actions.slice(0, 8),
      // HouseCall Pro KPI bar
      hcp: {
        rev_booked_today: revBookedToday,
        new_jobs_today: newJobsToday,
        quotes_given_today: quotesGivenToday,
        booked_online_month: bookedOnlineMonth,
      },
    });
  } catch (err) {
    console.error("Dashboard kpis error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/revenue-chart", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;

    // Build a fixed 12-month label set using month_date as key (YYYY-MM format)
    // Current year: last 12 months; prior year: same months shifted -1 year
    const [currentRows, priorRows] = await Promise.all([
      db.execute(sql`
        SELECT
          TO_CHAR(DATE_TRUNC('month', job_date), 'Mon ''YY') AS month,
          TO_CHAR(DATE_TRUNC('month', job_date), 'YYYY-MM') AS month_key,
          DATE_TRUNC('month', job_date) AS month_date,
          COALESCE(SUM(revenue), 0)::numeric AS revenue,
          COUNT(*)::int AS jobs
        FROM job_history
        WHERE company_id = ${companyId}
          AND job_date >= DATE_TRUNC('month', NOW()) - INTERVAL '11 months'
          AND job_date <= NOW()
        GROUP BY DATE_TRUNC('month', job_date)
        ORDER BY month_date ASC
      `),
      // Prior year: historical job_history shifted back 1 year
      // Key by month_date + 1 year so we can match it to the current month
      db.execute(sql`
        SELECT
          TO_CHAR(DATE_TRUNC('month', job_date) + INTERVAL '1 year', 'YYYY-MM') AS month_key,
          COALESCE(SUM(revenue), 0)::numeric AS revenue,
          COUNT(*)::int AS jobs
        FROM job_history
        WHERE company_id = ${companyId}
          AND job_date >= DATE_TRUNC('month', NOW()) - INTERVAL '23 months'
          AND job_date < DATE_TRUNC('month', NOW()) - INTERVAL '11 months'
        GROUP BY DATE_TRUNC('month', job_date)
        ORDER BY month_key ASC
      `),
    ]);

    const currentData = currentRows.rows.map((r) => ({
      month: String(r['month'] ?? ''),
      month_key: String(r['month_key'] ?? ''),
      revenue: parseFloat(String(r['revenue'] ?? '0')),
      jobs: Number(r['jobs'] ?? 0),
    }));

    // Build prior-year lookup by month_key (shifted +1 year to match current month)
    const priorByKey: Record<string, number> = {};
    priorRows.rows.forEach((r) => {
      const key = String(r['month_key'] ?? '');
      const rev = parseFloat(String(r['revenue'] ?? '0'));
      if (key) priorByKey[key] = rev;
    });

    // Align prior year revenue to the same month labels using month_key
    const priorYear = currentData.map((d) => ({
      month: d.month,
      revenue: priorByKey[d.month_key] ?? 0,
    }));

    // Strip month_key from the public response
    const data = currentData.map(({ month_key: _mk, ...rest }) => rest);

    return res.json({
      data,
      prior_year: priorYear,
    });
  } catch (err) {
    console.error("Revenue chart error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/techs-today", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];

    const techs = await db
      .select({
        id: usersTable.id,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
        avatar_url: usersTable.avatar_url,
      })
      .from(usersTable)
      .where(and(
        eq(usersTable.company_id, companyId),
        eq(usersTable.role, "technician"),
        eq(usersTable.is_active, true),
      ));

    const jobCounts = await db
      .select({
        assigned_user_id: jobsTable.assigned_user_id,
        job_count: count(),
      })
      .from(jobsTable)
      .where(and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.scheduled_date, todayStr),
        sql`${jobsTable.status} != 'cancelled'`,
        isNotNull(jobsTable.assigned_user_id),
      ))
      .groupBy(jobsTable.assigned_user_id);

    const jobCountMap: Record<number, number> = {};
    for (const row of jobCounts) {
      if (row.assigned_user_id != null) {
        jobCountMap[row.assigned_user_id] = Number(row.job_count);
      }
    }

    const enriched = techs.map(t => ({
      ...t,
      job_count: jobCountMap[t.id] ?? 0,
    })).sort((a, b) => {
      if (b.job_count !== a.job_count) return b.job_count - a.job_count;
      return `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`);
    });

    const totalJobsToday = enriched.reduce((s, t) => s + t.job_count, 0);

    return res.json({
      techs: enriched,
      total_jobs_today: totalJobsToday,
    });
  } catch (err) {
    console.error("Techs today error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/commercial-alerts", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const todayStr = new Date().toISOString().split("T")[0];

    const [chargeFailedJobs, noCardAccounts, hoursVarianceJobs] = await Promise.all([
      db.select({
        id: jobsTable.id,
        account_id: jobsTable.account_id,
        account_name: accountsTable.account_name,
        billed_amount: jobsTable.billed_amount,
        charge_failed_at: jobsTable.charge_failed_at,
        property_address: accountPropertiesTable.address,
        property_city: accountPropertiesTable.city,
      })
      .from(jobsTable)
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(accountPropertiesTable, eq(jobsTable.account_property_id, accountPropertiesTable.id))
      .where(and(
        eq(jobsTable.company_id, companyId),
        isNotNull(jobsTable.charge_failed_at),
        eq(jobsTable.status, "complete"),
      ))
      .limit(5),

      db.select({
        id: accountsTable.id,
        account_name: accountsTable.account_name,
      })
      .from(accountsTable)
      .where(and(
        eq(accountsTable.company_id, companyId),
        eq(accountsTable.is_active, true),
        isNull(accountsTable.stripe_customer_id),
      ))
      .limit(5),

      db.select({
        id: jobsTable.id,
        account_id: jobsTable.account_id,
        account_name: accountsTable.account_name,
        allowed_hours: jobsTable.allowed_hours,
        actual_hours: jobsTable.actual_hours,
        scheduled_date: jobsTable.scheduled_date,
      })
      .from(jobsTable)
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .where(and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.scheduled_date, todayStr),
        isNotNull(jobsTable.actual_hours),
        isNotNull(jobsTable.allowed_hours),
      ))
      .limit(10),
    ]);

    type Alert = { level: string; text: string; job_id?: number; account_id?: number };
    const alerts: Alert[] = [];

    for (const job of chargeFailedJobs) {
      alerts.push({
        level: "red",
        text: `Charge failed — ${job.account_name || 'Account'}: $${parseFloat(job.billed_amount || "0").toFixed(2)} at ${job.property_address || 'unknown address'}`,
        job_id: job.id,
        account_id: job.account_id || undefined,
      });
    }
    for (const acct of noCardAccounts) {
      alerts.push({ level: "amber", text: `No payment method on file — ${acct.account_name}`, account_id: acct.id });
    }
    for (const job of hoursVarianceJobs) {
      const allowed = parseFloat(job.allowed_hours || "0");
      const actual = parseFloat(job.actual_hours || "0");
      if (allowed > 0 && Math.abs(actual - allowed) / allowed > 0.2) {
        const over = actual > allowed;
        alerts.push({
          level: over ? "amber" : "blue",
          text: `Hours variance — ${job.account_name || 'Job'}: ${actual.toFixed(1)}h actual vs ${allowed.toFixed(1)}h allowed (${over ? '+' : ''}${Math.round(((actual - allowed) / allowed) * 100)}%)`,
          job_id: job.id,
          account_id: job.account_id || undefined,
        });
      }
    }

    return res.json({ alerts });
  } catch (err) {
    console.error("Commercial alerts error:", err);
    return res.status(500).json({ alerts: [] });
  }
});

// ── GET /api/dashboard/weekly-forecast ──────────────────────────────────────
router.get("/weekly-forecast", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];

    // Week definitions: Sun–Sat
    const dow = now.getDay(); // 0=Sun … 6=Sat
    const cwStart = new Date(now); cwStart.setDate(now.getDate() - dow); cwStart.setHours(0,0,0,0);
    const cwEnd   = new Date(cwStart); cwEnd.setDate(cwStart.getDate() + 6);
    const lwStart = new Date(cwStart); lwStart.setDate(cwStart.getDate() - 7);
    const lwEnd   = new Date(cwStart); lwEnd.setDate(cwStart.getDate() - 1);
    const nwStart = new Date(cwEnd);  nwStart.setDate(cwEnd.getDate() + 1);
    const nwEnd   = new Date(nwStart); nwEnd.setDate(nwStart.getDate() + 6);

    const cacheKey = `${companyId}:${cwStart.toISOString().split("T")[0]}`;
    const cached = wfCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return res.json(cached.data);

    const d = (dt: Date) => dt.toISOString().split("T")[0];

    // 8-week avg window: 8 weeks ending last Saturday
    const avgStart = new Date(cwStart); avgStart.setDate(cwStart.getDate() - 8 * 7);

    const [lwHist, cwHistPast, cwJobsFuture, nwJobs, avgResult] = await Promise.all([
      // Last week actuals from job_history
      db.execute(sql`
        SELECT job_date::text AS date,
               COALESCE(SUM(revenue),0)::numeric AS revenue,
               COUNT(*)::int AS job_count
        FROM job_history
        WHERE company_id = ${companyId}
          AND job_date >= ${d(lwStart)} AND job_date <= ${d(lwEnd)}
          AND EXTRACT(DOW FROM job_date) NOT IN (0,6)
        GROUP BY job_date
      `),

      // Current week past days (before today) from job_history
      db.execute(sql`
        SELECT job_date::text AS date,
               COALESCE(SUM(revenue),0)::numeric AS revenue,
               COUNT(*)::int AS job_count
        FROM job_history
        WHERE company_id = ${companyId}
          AND job_date >= ${d(cwStart)} AND job_date < ${todayStr}
          AND EXTRACT(DOW FROM job_date) NOT IN (0,6)
        GROUP BY job_date
      `),

      // Current week today + future days from jobs table
      db.execute(sql`
        SELECT scheduled_date::text AS date,
               COALESCE(SUM(base_fee),0)::numeric AS revenue,
               COUNT(*)::int AS job_count,
               COUNT(*) FILTER (WHERE assigned_user_id IS NULL)::int AS unassigned_count
        FROM jobs
        WHERE company_id = ${companyId}
          AND scheduled_date >= ${todayStr}
          AND scheduled_date <= ${d(cwEnd)}
          AND status != 'cancelled'
          AND EXTRACT(DOW FROM scheduled_date) NOT IN (0,6)
        GROUP BY scheduled_date
      `),

      // Next week projected from jobs table
      db.execute(sql`
        SELECT scheduled_date::text AS date,
               COALESCE(SUM(base_fee),0)::numeric AS revenue,
               COUNT(*)::int AS job_count,
               COUNT(*) FILTER (WHERE assigned_user_id IS NULL)::int AS unassigned_count
        FROM jobs
        WHERE company_id = ${companyId}
          AND scheduled_date >= ${d(nwStart)} AND scheduled_date <= ${d(nwEnd)}
          AND status != 'cancelled'
          AND EXTRACT(DOW FROM scheduled_date) NOT IN (0,6)
        GROUP BY scheduled_date
      `),

      // 8-week daily avg (revenue + jobs)
      db.execute(sql`
        SELECT AVG(daily_rev)::numeric AS daily_avg,
               AVG(daily_jobs)::numeric AS daily_avg_jobs
        FROM (
          SELECT job_date, SUM(revenue) AS daily_rev, COUNT(*) AS daily_jobs
          FROM job_history
          WHERE company_id = ${companyId}
            AND job_date >= ${d(avgStart)} AND job_date < ${d(cwStart)}
            AND EXTRACT(DOW FROM job_date) NOT IN (0,6)
          GROUP BY job_date
        ) sub
      `),
    ]);

    const daily_avg      = parseFloat(String((avgResult.rows[0] as any)?.daily_avg ?? "0"));
    const daily_avg_jobs = Math.round(parseFloat(String((avgResult.rows[0] as any)?.daily_avg_jobs ?? "0")));

    // Build lookup maps
    const toMap = (rows: unknown[]) => {
      const m = new Map<string, { revenue: number; job_count: number; unassigned_count: number }>();
      for (const r of rows as any[]) {
        m.set(r.date, {
          revenue: parseFloat(r.revenue ?? "0"),
          job_count: parseInt(r.job_count ?? "0"),
          unassigned_count: parseInt(r.unassigned_count ?? "0"),
        });
      }
      return m;
    };
    const lwMap   = toMap(lwHist.rows);
    const cwHMap  = toMap(cwHistPast.rows);
    const cwJMap  = toMap(cwJobsFuture.rows);
    const nwMap   = toMap(nwJobs.rows);

    const DAY_NAMES = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
    const fmtRange = (s: Date, e: Date) => {
      const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `${M[s.getMonth()]} ${s.getDate()} \u2013 ${M[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
    };

    const buildDays = (start: Date, weekType: "last"|"current"|"projected") => {
      return Array.from({ length: 7 }, (_, i) => {
        const dt = new Date(start); dt.setDate(start.getDate() + i);
        const dateStr  = d(dt);
        const dayIdx   = dt.getDay();
        const isWeekend = dayIdx === 0 || dayIdx === 6;
        const isPast    = dateStr < todayStr;
        const isToday   = dateStr === todayStr;

        if (isWeekend) return { date: dateStr, day_name: DAY_NAMES[dayIdx], revenue: 0, job_count: 0, unassigned_count: 0, is_weekend: true, is_past: isPast, is_today: false, entry_type: weekType };

        let data = { revenue: 0, job_count: 0, unassigned_count: 0 };
        if (weekType === "last")       data = lwMap.get(dateStr)  || data;
        else if (weekType === "current") data = (isPast ? cwHMap : cwJMap).get(dateStr) || data;
        else                             data = nwMap.get(dateStr) || data;

        return { date: dateStr, day_name: DAY_NAMES[dayIdx], ...data, is_weekend: false, is_past: isPast, is_today: isToday, entry_type: weekType };
      });
    };

    const lwDays = buildDays(lwStart, "last");
    const cwDays = buildDays(cwStart, "current");
    const nwDays = buildDays(nwStart, "projected");

    const wdSum = (days: ReturnType<typeof buildDays>) =>
      days.filter(d => !d.is_weekend).reduce((a, d) => ({ rev: a.rev + d.revenue, jobs: a.jobs + d.job_count, ua: a.ua + d.unassigned_count }), { rev: 0, jobs: 0, ua: 0 });

    const lwTot = wdSum(lwDays);
    const cwTot = wdSum(cwDays);
    const nwTot = wdSum(nwDays);

    const result = {
      daily_avg,
      daily_avg_jobs,
      weeks: [
        { id: "last",    label: "LAST WEEK",    date_range: fmtRange(lwStart, lwEnd),  total_revenue: lwTot.rev, total_jobs: lwTot.jobs, total_unassigned: 0,        daily_avg, daily_avg_jobs, days: lwDays },
        { id: "current", label: "CURRENT WEEK", date_range: fmtRange(cwStart, cwEnd),  total_revenue: cwTot.rev, total_jobs: cwTot.jobs, total_unassigned: cwTot.ua, daily_avg, daily_avg_jobs, days: cwDays },
        { id: "next",    label: "NEXT WEEK",    date_range: fmtRange(nwStart, nwEnd),  total_revenue: nwTot.rev, total_jobs: nwTot.jobs, total_unassigned: nwTot.ua, daily_avg, daily_avg_jobs, days: nwDays },
      ],
    };

    wfCache.set(cacheKey, { data: result, ts: Date.now() });
    return res.json(result);
  } catch (err) {
    console.error("Weekly forecast error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Shared BUSINESS HEALTH calc — single source of truth for rate-trend,
// avg-bill, and retention, used by BOTH the mobile cards and the desktop
// BUSINESS HEALTH section. Revenue/avg-bill/trend read job_history (the clean
// MC ledger the desktop revenue chart uses: date=job_date, amount=revenue),
// NOT the jobs table (corrupted for trend windows). Closed full months only —
// trailing 12 vs prior 12, partial current month excluded. Company-wide
// (job_history has no branch column). This is the #266 calc, factored out so
// there is no divergent parallel implementation.
async function computeBusinessHealth(companyId: number): Promise<{
  rate_trend: number; avg_bill_12mo: number; retention: number; last12_n: number; prior12_n: number;
}> {
  const [hist, ret] = await Promise.all([
    db.execute(sql`
      SELECT
        COALESCE(AVG(revenue) FILTER (WHERE revenue > 0
          AND job_date >= date_trunc('month', now()) - INTERVAL '12 months'
          AND job_date <  date_trunc('month', now())), 0)::numeric AS last12_avg,
        COUNT(*) FILTER (WHERE revenue > 0
          AND job_date >= date_trunc('month', now()) - INTERVAL '12 months'
          AND job_date <  date_trunc('month', now()))::int AS last12_n,
        COALESCE(AVG(revenue) FILTER (WHERE revenue > 0
          AND job_date >= date_trunc('month', now()) - INTERVAL '24 months'
          AND job_date <  date_trunc('month', now()) - INTERVAL '12 months'), 0)::numeric AS prior12_avg,
        COUNT(*) FILTER (WHERE revenue > 0
          AND job_date >= date_trunc('month', now()) - INTERVAL '24 months'
          AND job_date <  date_trunc('month', now()) - INTERVAL '12 months')::int AS prior12_n
      FROM job_history WHERE company_id = ${companyId}
    `),
    db.execute(sql`
      SELECT COUNT(DISTINCT customer_id)::int AS total,
             COUNT(DISTINCT customer_id) FILTER (WHERE is_active = true)::int AS active
      FROM recurring_schedules WHERE company_id = ${companyId}
    `),
  ]);
  const h: any = (hist as any).rows[0] ?? {};
  const r: any = (ret as any).rows[0] ?? {};
  const last12 = Number(h.last12_avg ?? 0);
  const prior12 = Number(h.prior12_avg ?? 0);
  const total = Number(r.total ?? 0);
  return {
    rate_trend: prior12 > 0 ? Math.round(((last12 - prior12) / prior12) * 10000) / 100 : 0,
    avg_bill_12mo: Math.round(last12 * 100) / 100,
    retention: total > 0 ? Math.round((Number(r.active ?? 0) / total) * 100) : 0,
    last12_n: Number(h.last12_n ?? 0),
    prior12_n: Number(h.prior12_n ?? 0),
  };
}

// Payroll % to revenue — TEMPORARY single clean month (April 2026).
// Cost: the existing reports.ts pay calc (pay_type x hours/rate + fee_split +
// additional_pay) scoped to April-only completed jobs — April is clean in the
// jobs table. Revenue denominator: job_history April (clean MC ledger).
// We deliberately do NOT compute trailing-12 here: that would inherit the May
// gap and Jan-Mar 2x corruption on the cost side. A true single month beats a
// corrupt twelve. Widen to trailing-12 once the jobs table is reconciled
// (known follow-up). Window is hardcoded by design until then.
const PAYROLL_MONTH_START = "2026-04-01";
const PAYROLL_MONTH_END = "2026-04-30";
const PAYROLL_WINDOW_LABEL = "Apr 2026";
async function computeAprilPayrollPct(companyId: number): Promise<{ payroll_pct: number; payroll_window: string }> {
  const [payRow, addPayRow, revRow] = await Promise.all([
    db.execute(sql`
      SELECT COALESCE(SUM(
        CASE u.pay_type
          WHEN 'hourly'    THEN u.pay_rate::numeric * COALESCE(j.actual_hours, j.allowed_hours, 0)::numeric
          WHEN 'per_job'   THEN u.pay_rate::numeric
          WHEN 'fee_split' THEN j.base_fee::numeric * COALESCE(u.fee_split_pct, j.fee_split_pct, 0)::numeric / 100
          ELSE 0
        END), 0)::numeric AS payroll
      FROM jobs j JOIN users u ON u.id = j.assigned_user_id
      WHERE j.company_id = ${companyId} AND j.status = 'complete'
        AND j.scheduled_date >= ${PAYROLL_MONTH_START} AND j.scheduled_date <= ${PAYROLL_MONTH_END}
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(amount), 0)::numeric AS add_pay FROM additional_pay
      WHERE company_id = ${companyId}
        AND created_at::date >= ${PAYROLL_MONTH_START} AND created_at::date <= ${PAYROLL_MONTH_END}
    `),
    db.execute(sql`
      SELECT COALESCE(SUM(revenue), 0)::numeric AS revenue FROM job_history
      WHERE company_id = ${companyId}
        AND job_date >= ${PAYROLL_MONTH_START} AND job_date <= ${PAYROLL_MONTH_END}
    `),
  ]);
  const cost = Number((payRow as any).rows[0]?.payroll ?? 0) + Number((addPayRow as any).rows[0]?.add_pay ?? 0);
  const revenue = Number((revRow as any).rows[0]?.revenue ?? 0);
  return {
    payroll_pct: revenue > 0 ? Math.round((cost / revenue) * 1000) / 10 : 0,
    payroll_window: PAYROLL_WINDOW_LABEL,
  };
}

// [revenue-connect 2026-06-12] Payroll % — LAST COMPLETED WEEK (Sun–Sat,
// America/Chicago), replacing the April-2026 pin now that the job_history
// live bridge keeps the revenue ledger current past the MC cutover.
// Numerator: commission via the shared engine (computeCommissionRows +
// job_technicians.final_pay overrides) — the same formula behind the
// payroll page's "PAYROLL % OF REV" header, so the two surfaces agree for
// the same week. Denominator: job_history revenue for the week. Falls back
// to the pinned April calc when the week has no ledger revenue (bridge not
// yet run on this deploy / fresh tenant) so the card never blanks.
async function computeLastWeekPayrollPct(companyId: number): Promise<{ payroll_pct: number; payroll_window: string }> {
  const nowCt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const start = new Date(nowCt);
  start.setDate(nowCt.getDate() - nowCt.getDay() - 7); // previous Sunday
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const d = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const label = `${M[start.getMonth()]} ${start.getDate()} – ${M[end.getMonth()]} ${end.getDate()}`;

  const revRow = await db.execute(sql`
    SELECT COALESCE(SUM(revenue), 0)::numeric AS revenue FROM job_history
    WHERE company_id = ${companyId}
      AND job_date >= ${d(start)} AND job_date <= ${d(end)}
  `);
  const revenue = Number((revRow as any).rows[0]?.revenue ?? 0);
  if (revenue <= 0) return computeAprilPayrollPct(companyId);

  // Company comp settings — same resilient waterfall as /payroll/detail.
  let compSettings: any = {
    res_tech_pay_pct: 0.35,
    deep_clean_pay_pct: 0.32,
    move_in_out_pay_pct: 0.32,
    commercial_hourly_rate: 20.0,
    commercial_comp_mode: "allowed_hours",
  };
  try {
    const rows = await db.execute(sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
    if (rows.rows[0]) compSettings = rows.rows[0];
  } catch { /* tiered columns absent — keep defaults */ }
  const resRates = parseResRatesRow(compSettings);

  const jobRows = await db.execute(sql`
    SELECT j.id, j.assigned_user_id, j.service_type::text AS service_type, j.account_id,
           j.base_fee, j.billed_amount, j.allowed_hours, j.actual_hours, j.branch_id,
           j.scheduled_date::text AS scheduled_date, c.client_type
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = ${companyId} AND j.status = 'complete'
       AND j.scheduled_date >= ${d(start)} AND j.scheduled_date <= ${d(end)}
  `);
  const jobs: CommissionInputJob[] = (jobRows.rows as any[]).map(r => ({
    id: Number(r.id),
    // Commercial routing matches /payroll/detail: account link OR a
    // commercial client_type. computeCommissionRows keys on account_id
    // only, so a commercial client without an account gets a sentinel.
    account_id: r.account_id != null ? Number(r.account_id) : (r.client_type === "commercial" ? -1 : null),
    assigned_user_id: r.assigned_user_id != null ? Number(r.assigned_user_id) : null,
    service_type: r.service_type ?? null,
    base_fee: r.base_fee ?? null,
    billed_amount: r.billed_amount ?? null,
    allowed_hours: r.allowed_hours ?? null,
    actual_hours: r.actual_hours ?? null,
    branch_id: r.branch_id != null ? Number(r.branch_id) : null,
    scheduled_date: String(r.scheduled_date),
    client_type: r.client_type ?? null,
  }));

  // Per-job hand-set pay overrides (job_technicians.final_pay) win — same
  // rule as the payroll surfaces.
  const overrides = new Map<string, number>();
  const jobIds = jobs.map(j => j.id);
  if (jobIds.length > 0) {
    try {
      const t = await db.execute(sql`
        SELECT job_id, user_id, final_pay FROM job_technicians
        WHERE company_id = ${companyId} AND job_id = ANY(${jobIds}::int[]) AND final_pay IS NOT NULL
      `);
      for (const r of t.rows as any[]) {
        const pay = parseFloat(String(r.final_pay));
        if (Number.isFinite(pay)) overrides.set(`${r.user_id}:${r.job_id}`, pay);
      }
    } catch { /* job_technicians absent on a fresh tenant — engine-computed only */ }
  }

  const commissionRows = computeCommissionRows({
    jobs,
    resRates,
    commercial: {
      commercial_hourly_rate: parseFloat(String(compSettings.commercial_hourly_rate ?? 20)),
      commercial_comp_mode: compSettings.commercial_comp_mode === "actual_hours" ? "actual_hours" : "allowed_hours",
    },
    overrides,
  });
  const cost = commissionRows.reduce((s, r) => s + r.amount, 0);
  return {
    payroll_pct: Math.round((cost / revenue) * 1000) / 10,
    payroll_window: label,
  };
}

// ── Period-scoped money summary ─────────────────────────────────────────────
// [dashboard-period-selector 2026-07-22] /kpis answers fixed windows only
// (this week, this month, next 7). The redesigned dashboard puts ONE period
// selector at the top of the page and every money card has to follow it, so
// this endpoint takes the window as a parameter and returns the four numbers
// that row shows: revenue booked, cash collected, receivables, payroll %.
//
// Read-only. No schema change. Every number is company-scoped and, where the
// table carries a branch, branch-scoped too.
//
// Definitions, so the card labels can't drift from the SQL:
//   revenue_booked — non-cancelled jobs SCHEDULED in the window, valued at
//     billed_amount when invoiced else base_fee. Same expression as /kpis, so
//     "revenue this week" ties to the KPI strip to the penny.
//   collected     — payments RECEIVED in the window (payments.created_at).
//     Booked ≠ collected; showing both side by side is the point.
//   payroll       — [arrears 2026-07-22] ALWAYS the last COMPLETED Sun–Sat
//     week, never the selected window. Phes pays in arrears: this week's
//     commission isn't owed or even final yet, so dividing a partial week's
//     cost by a partial week's revenue produced a number that swung wildly
//     every morning and meant nothing. The card is labelled with the actual
//     dates it covers and does NOT move with the period selector.

type PeriodKey = "today" | "week" | "month";

const ctNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Sun–Sat weeks, calendar months, both in America/Chicago — the same tz the
// "booked today" KPI counts in. `prev` is the immediately preceding window of
// the same shape, which is what the delta chips compare against.
function resolvePeriod(period: PeriodKey): { from: string; to: string; prevFrom: string; prevTo: string; label: string } {
  const now = ctNow();
  const d = (base: Date, days: number) => { const x = new Date(base); x.setDate(base.getDate() + days); return x; };

  if (period === "today") {
    return { from: ymd(now), to: ymd(now), prevFrom: ymd(d(now, -1)), prevTo: ymd(d(now, -1)), label: "Today" };
  }
  if (period === "month") {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const ps = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const pe = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: ymd(s), to: ymd(e), prevFrom: ymd(ps), prevTo: ymd(pe), label: "This month" };
  }
  const s = d(now, -now.getDay());          // Sunday
  const e = d(s, 6);                        // Saturday
  return { from: ymd(s), to: ymd(e), prevFrom: ymd(d(s, -7)), prevTo: ymd(d(s, -1)), label: "This week" };
}

// The last COMPLETED Sun–Sat week. Independent of the page's period selector —
// see the payroll note above.
function lastCompletedWeek(): { from: string; to: string } {
  const now = ctNow();
  const d = (base: Date, days: number) => { const x = new Date(base); x.setDate(base.getDate() + days); return x; };
  const thisSun = d(now, -now.getDay());
  return { from: ymd(d(thisSun, -7)), to: ymd(d(thisSun, -1)) };
}

const pctDelta = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;

// Commission cost for jobs completed in [from, to]. Extracted from the
// last-week payroll-% helper so the period selector and the BUSINESS HEALTH
// card can't disagree about what a commission dollar is.
async function commissionCostForRange(companyId: number, from: string, to: string, branchId: number | null): Promise<number> {
  let compSettings: any = {
    res_tech_pay_pct: 0.35, deep_clean_pay_pct: 0.32, move_in_out_pay_pct: 0.32,
    commercial_hourly_rate: 20.0, commercial_comp_mode: "allowed_hours",
  };
  try {
    const rows = await db.execute(sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
    if (rows.rows[0]) compSettings = rows.rows[0];
  } catch { /* tiered columns absent — keep defaults */ }

  const jobRows = await db.execute(sql`
    SELECT j.id, j.assigned_user_id, j.service_type::text AS service_type, j.account_id,
           j.base_fee, j.billed_amount, j.allowed_hours, j.actual_hours, j.branch_id,
           j.scheduled_date::text AS scheduled_date, c.client_type
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.company_id = ${companyId} AND j.status = 'complete'
       AND j.scheduled_date >= ${from} AND j.scheduled_date <= ${to}
       ${branchId != null ? sql`AND j.branch_id = ${branchId}` : sql``}
  `);
  const jobs: CommissionInputJob[] = (jobRows.rows as any[]).map(r => ({
    id: Number(r.id),
    account_id: r.account_id != null ? Number(r.account_id) : (r.client_type === "commercial" ? -1 : null),
    assigned_user_id: r.assigned_user_id != null ? Number(r.assigned_user_id) : null,
    service_type: r.service_type ?? null,
    base_fee: r.base_fee ?? null,
    billed_amount: r.billed_amount ?? null,
    allowed_hours: r.allowed_hours ?? null,
    actual_hours: r.actual_hours ?? null,
    branch_id: r.branch_id != null ? Number(r.branch_id) : null,
    scheduled_date: String(r.scheduled_date),
    client_type: r.client_type ?? null,
  }));
  if (jobs.length === 0) return 0;

  const overrides = new Map<string, number>();
  try {
    const t = await db.execute(sql`
      SELECT job_id, user_id, final_pay FROM job_technicians
      WHERE company_id = ${companyId} AND job_id = ANY(${jobs.map(j => j.id)}::int[]) AND final_pay IS NOT NULL
    `);
    for (const r of t.rows as any[]) {
      const pay = parseFloat(String(r.final_pay));
      if (Number.isFinite(pay)) overrides.set(`${r.user_id}:${r.job_id}`, pay);
    }
  } catch { /* job_technicians absent on a fresh tenant — engine-computed only */ }

  return computeCommissionRows({
    jobs,
    resRates: parseResRatesRow(compSettings),
    commercial: {
      commercial_hourly_rate: parseFloat(String(compSettings.commercial_hourly_rate ?? 20)),
      commercial_comp_mode: compSettings.commercial_comp_mode === "actual_hours" ? "actual_hours" : "allowed_hours",
    },
    overrides,
  }).reduce((s, r) => s + r.amount, 0);
}

router.get("/summary", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const raw = String(req.query.period ?? "week");
    const period: PeriodKey = raw === "today" || raw === "month" ? raw : "week";
    const branchId = req.query.branch_id && req.query.branch_id !== "all"
      ? parseInt(String(req.query.branch_id), 10) : null;
    const w = resolvePeriod(period);

    const revSql = (from: string, to: string) => db.execute(sql`
      SELECT COALESCE(SUM(${jobRevenueExpr(sql`COALESCE(j.billed_amount, j.base_fee, 0)`)}), 0)::numeric AS total,
             COUNT(*)::int AS jobs
        FROM jobs j
        LEFT JOIN clients c ON c.id = j.client_id
       WHERE j.company_id = ${companyId}
         AND j.status != 'cancelled'
         AND j.scheduled_date >= ${from} AND j.scheduled_date <= ${to}
         ${branchId != null ? sql`AND j.branch_id = ${branchId}` : sql``}
    `);

    // Payments carry no branch column — collected is company-wide by
    // construction. The card says "all branches" when a branch filter is on
    // rather than silently reporting a number the filter didn't touch.
    const paidSql = (from: string, to: string) => db.execute(sql`
      SELECT COALESCE(SUM(amount), 0)::numeric AS total
        FROM payments
       WHERE company_id = ${companyId}
         AND created_at >= ${from}::date
         AND created_at < (${to}::date + interval '1 day')
    `);

    const pw = lastCompletedWeek();

    const [curRev, prevRev, curPaid, prevPaid, payRev, payCost] = await Promise.all([
      revSql(w.from, w.to),
      revSql(w.prevFrom, w.prevTo),
      paidSql(w.from, w.to),
      paidSql(w.prevFrom, w.prevTo),
      revSql(pw.from, pw.to),
      commissionCostForRange(companyId, pw.from, pw.to, branchId),
    ]);

    const n = (r: any, k: string) => parseFloat(String(r?.rows?.[0]?.[k] ?? 0)) || 0;
    const revenue = n(curRev, "total");
    const revenuePrev = n(prevRev, "total");
    const collected = n(curPaid, "total");
    const collectedPrev = n(prevPaid, "total");

    return res.json({
      period,
      label: w.label,
      window: { from: w.from, to: w.to },
      prev_window: { from: w.prevFrom, to: w.prevTo },
      branch_id: branchId,
      revenue_booked: {
        value: revenue,
        prev: revenuePrev,
        delta_pct: pctDelta(revenue, revenuePrev),
        jobs: Number(curRev.rows[0]?.jobs ?? 0),
      },
      collected: {
        value: collected,
        prev: collectedPrev,
        delta_pct: pctDelta(collected, collectedPrev),
        // true when the number ignores the active branch filter
        company_wide: branchId != null,
      },
      // Last completed week, always — Phes pays in arrears. See the note above.
      payroll: {
        cost: Math.round(payCost * 100) / 100,
        revenue: n(payRev, "total"),
        pct_of_revenue: n(payRev, "total") > 0
          ? Math.round((payCost / n(payRev, "total")) * 1000) / 10 : null,
        window: { from: pw.from, to: pw.to },
        label: "Last week",
      },
    });
  } catch (err) {
    console.error("GET /dashboard/summary error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── What actually got BOOKED in the window ──────────────────────────────────
// [dashboard-booked 2026-07-22] /summary's `revenue_booked` filters on
// jobs.scheduled_date — it is the window's SCHEDULED job revenue, which is what
// the hero shows. That answers "what's on the calendar", not "what did we sell".
// This endpoint answers the second question: jobs whose BOOKING was created in
// the window (jobs.created_at), regardless of when they're scheduled. Same
// definition as `revenue_newly_booked_today` on /mobile-cards, widened to the
// period selector's window.
//
// CRITICAL — recurring occurrences are NOT sales. The recurring engine stamps
// created_at when it generates each future occurrence, so a naive count of
// "jobs created this window" is dominated by calendar fill: for Phes this week
// that was 289 engine-generated occurrences worth $58.5k against 20 genuinely
// sold jobs worth $7.3k. Reporting $65.8k as "booked" would be off by 9x and
// would drown the source breakdown in Unknown. So `total` and both breakdowns
// cover only jobs with recurring_schedule_id IS NULL — work someone actually
// sold — and the engine's output is reported separately as `recurring`.
//
// Two breakdowns, because "we booked $4,100" alone doesn't tell Sal what to do:
//   by_service — what kind of work got sold (jobs.service_type)
//   by_source  — which channel it came from. A job's lead is found by
//     leads.job_id first (the direct stamp advanceLeadStage writes), falling
//     back to leads.client_id so a later job for an acquired client still
//     attributes to the channel that won them. No lead either way →
//     "Unknown", which is honest: office-created repeat work has no lead row.
//
// Read-only, company- and branch-scoped, office-gated like the rest of the file.
router.get("/booked", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const raw = String(req.query.period ?? "week");
    const period: PeriodKey = raw === "today" || raw === "month" ? raw : "week";
    const branchId = req.query.branch_id && req.query.branch_id !== "all"
      ? parseInt(String(req.query.branch_id), 10) : null;
    const w = resolvePeriod(period);

    const rows = await db.execute(sql`
      SELECT (j.recurring_schedule_id IS NOT NULL) AS from_schedule,
             j.service_type::text AS service_type,
             COALESCE(
               (SELECT l.source FROM leads l
                 WHERE l.company_id = j.company_id AND l.job_id = j.id
                 ORDER BY l.created_at DESC LIMIT 1),
               (SELECT l.source FROM leads l
                 WHERE l.company_id = j.company_id AND l.client_id = j.client_id
                 ORDER BY l.created_at DESC LIMIT 1)
             ) AS source,
             COUNT(*)::int AS jobs,
             COALESCE(SUM(${jobRevenueExpr(sql`COALESCE(j.billed_amount, j.base_fee, 0)`)}), 0)::numeric AS revenue
        FROM jobs j
        LEFT JOIN clients c ON c.id = j.client_id
       WHERE j.company_id = ${companyId}
         AND j.status != 'cancelled'
         AND j.created_at >= ${w.from}::date
         AND j.created_at < (${w.to}::date + interval '1 day')
         ${branchId != null ? sql`AND j.branch_id = ${branchId}` : sql``}
       GROUP BY 1, 2, 3
    `);

    const all = rows.rows as any[];
    const sold = all.filter(r => r.from_schedule !== true);
    const generated = all.filter(r => r.from_schedule === true);
    const sum = (rs: any[], k: string) =>
      rs.reduce((s, r) => s + (parseFloat(String(r[k] ?? 0)) || 0), 0);

    type Bucket = { key: string; jobs: number; revenue: number };
    const fold = (pick: (r: any) => string | null) => {
      const m = new Map<string, Bucket>();
      for (const r of sold) {
        const key = pick(r) || "unknown";
        const b = m.get(key) ?? { key, jobs: 0, revenue: 0 };
        b.jobs += Number(r.jobs ?? 0);
        b.revenue += parseFloat(String(r.revenue ?? 0)) || 0;
        m.set(key, b);
      }
      return [...m.values()]
        .map(b => ({ ...b, revenue: Math.round(b.revenue * 100) / 100 }))
        .sort((a, b) => b.revenue - a.revenue || b.jobs - a.jobs);
    };

    const byService = fold(r => r.service_type);
    const bySource = fold(r => r.source);

    return res.json({
      period,
      label: w.label,
      window: { from: w.from, to: w.to },
      branch_id: branchId,
      // Work someone SOLD in this window — excludes engine-generated occurrences.
      total: {
        revenue: Math.round(sum(sold, "revenue") * 100) / 100,
        jobs: sold.reduce((s, r) => s + Number(r.jobs ?? 0), 0),
      },
      // Calendar fill the recurring engine produced in the same window. Shown
      // separately so it can never be mistaken for new business.
      recurring: {
        revenue: Math.round(sum(generated, "revenue") * 100) / 100,
        jobs: generated.reduce((s, r) => s + Number(r.jobs ?? 0), 0),
      },
      by_service: byService,
      by_source: bySource,
    });
  } catch (err) {
    console.error("GET /dashboard/booked error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Desktop BUSINESS HEALTH section. Same source-of-truth helpers as mobile.
router.get("/business-health", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const [bh, pay] = await Promise.all([computeBusinessHealth(companyId), computeLastWeekPayrollPct(companyId)]);
    return res.json({ ...bh, ...pay });
  } catch (err) {
    console.error("GET /dashboard/business-health error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Mobile customizable dashboard ────────────────────────────────────────────
// Read-only aggregate feeding the role-based, user-customizable MOBILE dashboard.
// One payload = every card's value, so the mobile surface does a single fetch.
// Branch-aware for job/client-based cards (jobs.branch_id / clients.branch_id);
// leads + quotes are company-wide (quotes has no reliable branch_id column).
// Desktop endpoints are untouched.
router.get("/mobile-cards", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const branchRaw = req.query.branch_id;
    const branchId = branchRaw && branchRaw !== "all" ? parseInt(branchRaw as string) : null;
    const jb = branchId ? sql`AND j.branch_id = ${branchId}` : sql``;
    const cb = branchId ? sql`AND branch_id = ${branchId}` : sql``;
    // "Today" / month boundaries in Central time (Phes), not UTC.
    const today = sql`(now() AT TIME ZONE 'America/Chicago')::date`;
    const monthStart = sql`date_trunc('month', (now() AT TIME ZONE 'America/Chicago'))`;
    const todayStart = sql`date_trunc('day', (now() AT TIME ZONE 'America/Chicago'))`;
    // Revenue: completed/booked use base_fee; rollups use billed_amount fallback.
    const exprBase = jobRevenueExpr(sql`CAST(j.base_fee AS NUMERIC)`, "j", "c");
    const exprBilled = jobRevenueExpr(sql`COALESCE(CAST(j.billed_amount AS NUMERIC), CAST(j.base_fee AS NUMERIC), 0)`, "j", "c");

    const [todayRev, todayCounts, monthRev, bh, pay, next7, lateRows, leadsRows, quotesRows, activeRows, newBookedRows] = await Promise.all([
      // Daily revenue (completed today, actual) vs Revenue booked today (all non-cancelled scheduled today)
      db.execute(sql`
        SELECT
          COALESCE(SUM(${exprBase}) FILTER (WHERE j.status = 'complete'), 0)::numeric AS daily,
          COALESCE(SUM(${exprBase}) FILTER (WHERE j.status != 'cancelled'), 0)::numeric AS booked
        FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId} AND j.scheduled_date = ${today} ${jb}
      `),
      // Today's counts + status breakdown + techs working
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status != 'cancelled')::int AS jobs_today,
          COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
          COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
          COUNT(*) FILTER (WHERE status = 'complete')::int AS complete,
          COUNT(*) FILTER (WHERE flagged = true AND status != 'cancelled')::int AS flagged,
          COUNT(*) FILTER (WHERE status = 'scheduled' AND assigned_user_id IS NULL)::int AS unassigned,
          COUNT(DISTINCT assigned_user_id) FILTER (WHERE status != 'cancelled' AND assigned_user_id IS NOT NULL)::int AS techs_today
        FROM jobs j
        WHERE j.company_id = ${companyId} AND j.scheduled_date = ${today} ${jb}
      `),
      // Monthly revenue (month-to-date)
      db.execute(sql`
        SELECT COALESCE(SUM(${exprBilled}), 0)::numeric AS v
        FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId} AND j.status != 'cancelled'
          AND j.scheduled_date >= ${monthStart}::date AND j.scheduled_date <= ${today} ${jb}
      `),
      // Avg bill, rate trend, retention via the shared BUSINESS HEALTH calc
      // (job_history-sourced; see computeBusinessHealth). Single source of
      // truth shared with the desktop BUSINESS HEALTH section.
      computeBusinessHealth(companyId),
      // Payroll % (last completed week) — shared with desktop.
      computeLastWeekPayrollPct(companyId),
      // Next 7 days (jobs + revenue)
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE j.status != 'cancelled')::int AS jobs,
          COALESCE(SUM(${exprBilled}) FILTER (WHERE j.status != 'cancelled'), 0)::numeric AS revenue
        FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId}
          AND j.scheduled_date >= ${today} AND j.scheduled_date <= ${today} + INTERVAL '7 days' ${jb}
      `),
      // Late clock-ins: scheduled today, assigned, no clock-in for the job, now ≥ start+20m (Central)
      db.execute(sql`
        SELECT COUNT(*)::int AS v
        FROM jobs j
        WHERE j.company_id = ${companyId} AND j.scheduled_date = ${today}
          AND j.status = 'scheduled' AND j.assigned_user_id IS NOT NULL
          AND j.scheduled_time IS NOT NULL
          AND (now() AT TIME ZONE 'America/Chicago')::time >= (j.scheduled_time::time + INTERVAL '20 minutes')
          AND NOT EXISTS (SELECT 1 FROM timeclock tc WHERE tc.job_id = j.id AND tc.company_id = ${companyId})
          ${jb}
      `),
      // Leads this month (company-wide)
      db.execute(sql`
        SELECT COUNT(*)::int AS v FROM leads
        WHERE company_id = ${companyId} AND created_at >= ${monthStart}
      `),
      // Quotes + closed (won) this month AND today (company-wide). Closed =
      // booked / converted. Today's cohort mirrors the monthly one: quotes
      // created today, and of those how many are closed.
      db.execute(sql`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status = 'booked' OR booked_job_id IS NOT NULL)::int AS closed,
               COUNT(*) FILTER (WHERE created_at >= ${todayStart})::int AS total_today,
               COUNT(*) FILTER (WHERE (status = 'booked' OR booked_job_id IS NOT NULL) AND created_at >= ${todayStart})::int AS closed_today
        FROM quotes WHERE company_id = ${companyId} AND created_at >= ${monthStart}
      `),
      // Active clients (branch-aware)
      db.execute(sql`
        SELECT COUNT(*)::int AS v FROM clients
        WHERE company_id = ${companyId} AND is_active = true ${cb}
      `),
      // Revenue newly BOOKED today — jobs whose booking was created today
      // (jobs.created_at), regardless of when they're scheduled. Distinct from
      // "scheduled today" (revenue_booked_today) and "completed today"
      // (daily_revenue). Same Central-day convention as the quotes "today" cohort.
      db.execute(sql`
        SELECT COALESCE(SUM(${exprBase}), 0)::numeric AS v
        FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.company_id = ${companyId}
          AND j.created_at >= ${todayStart}
          AND j.status != 'cancelled' ${jb}
      `),
    ]);

    const tc: any = (todayCounts as any).rows[0] ?? {};
    const tr: any = (todayRev as any).rows[0] ?? {};
    const n7: any = (next7 as any).rows[0] ?? {};
    const q: any = (quotesRows as any).rows[0] ?? {};
    const quotesTotal = Number(q.total ?? 0);
    const quotesClosed = Number(q.closed ?? 0);
    const quotesTotalToday = Number(q.total_today ?? 0);
    const quotesClosedToday = Number(q.closed_today ?? 0);
    const num = (v: any) => Math.round(Number(v ?? 0) * 100) / 100;

    return res.json({
      branch_id: branchId,
      daily_revenue: num(tr.daily),
      revenue_booked_today: num(tr.booked),
      revenue_newly_booked_today: num((newBookedRows as any).rows[0]?.v),
      jobs_today: Number(tc.jobs_today ?? 0),
      jobs_scheduled_today: Number(tc.scheduled ?? 0),
      late_clockins: Number((lateRows as any).rows[0]?.v ?? 0),
      todays_status: {
        in_progress: Number(tc.in_progress ?? 0),
        scheduled: Number(tc.scheduled ?? 0),
        complete: Number(tc.complete ?? 0),
        flagged: Number(tc.flagged ?? 0),
        unassigned: Number(tc.unassigned ?? 0),
      },
      unassigned_jobs: Number(tc.unassigned ?? 0),
      techs_today: Number(tc.techs_today ?? 0),
      next_7_days_jobs: Number(n7.jobs ?? 0),
      next_7_days_revenue: num(n7.revenue),
      leads: Number((leadsRows as any).rows[0]?.v ?? 0),
      quotes: quotesTotal,
      closed_quotes: quotesClosed,
      close_rate: quotesTotal > 0 ? Math.round((quotesClosed / quotesTotal) * 100) : 0,
      quotes_today: quotesTotalToday,
      closed_quotes_today: quotesClosedToday,
      close_rate_today: quotesTotalToday > 0 ? Math.round((quotesClosedToday / quotesTotalToday) * 100) : 0,
      monthly_revenue: num((monthRev as any).rows[0]?.v),
      // Avg bill, rate trend, retention from the shared job_history calc.
      avg_bill: bh.avg_bill_12mo,
      active_clients: Number((activeRows as any).rows[0]?.v ?? 0),
      rate_trend: bh.rate_trend,
      avg_bill_12mo: bh.avg_bill_12mo,
      retention: bh.retention,
      payroll_pct: pay.payroll_pct,
      payroll_window: pay.payroll_window,
    });
  } catch (err) {
    console.error("GET /dashboard/mobile-cards error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Per-user mobile dashboard card preference (selected cards + order).
// Reuses user_column_preferences with page='mobile_dashboard' — no schema change.
// No rows = user hasn't customized → frontend shows the role default.
router.get("/card-prefs", requireAuth, officeGate, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;
    const result = await db.execute(sql`
      SELECT column_key AS card_key, visible, sort_order
      FROM user_column_preferences
      WHERE user_id = ${userId} AND company_id = ${companyId} AND page = 'mobile_dashboard'
      ORDER BY sort_order ASC
    `);
    return res.json((result as any).rows ?? []);
  } catch (err) {
    console.error("GET /dashboard/card-prefs error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/card-prefs", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;
    const cards: Array<{ card_key: string; visible: boolean; sort_order: number }> = req.body?.cards;
    if (!Array.isArray(cards)) return res.status(400).json({ error: "cards array required" });
    // Pure upsert (no DELETE+INSERT): one row per card with visible flag + order.
    for (const c of cards) {
      await db.execute(sql`
        INSERT INTO user_column_preferences (user_id, company_id, page, column_key, visible, sort_order)
        VALUES (${userId}, ${companyId}, 'mobile_dashboard', ${String(c.card_key).slice(0, 50)}, ${!!c.visible}, ${parseInt(String(c.sort_order)) || 0})
        ON CONFLICT (user_id, page, column_key)
        DO UPDATE SET visible = EXCLUDED.visible, sort_order = EXCLUDED.sort_order
      `);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("PUT /dashboard/card-prefs error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Reset to role default = remove this user's customization rows.
router.delete("/card-prefs", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const companyId = req.auth!.companyId;
    await db.execute(sql`
      DELETE FROM user_column_preferences
      WHERE user_id = ${userId} AND company_id = ${companyId} AND page = 'mobile_dashboard'
    `);
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /dashboard/card-prefs error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Recent activity feed (main dashboard, under the revenue forecast) ─────────
// HCP-style stream of business events drawn from app_audit_log. Company-scoped,
// business events only — auth/LMS/smoke-test noise is filtered out so the card
// reads like "what happened to my jobs/quotes/invoices/clients lately", with a
// link back to each record. Raw fields go to the client; the dashboard maps
// them to a friendly label + route (the frontend owns the route table).
router.get("/recent-activity", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const limit = Math.min(parseInt(String(req.query.limit ?? "15")) || 15, 50);
    const r = await db.execute(sql`
      SELECT aal.id, aal.action, aal.target_type, aal.target_id,
             aal.new_value, aal.performed_at,
             NULLIF(TRIM(COALESCE(au.first_name,'') || ' ' || COALESCE(au.last_name,'')), '') AS user_name
      FROM app_audit_log aal
      LEFT JOIN users au ON aal.performed_by = au.id
      WHERE aal.company_id = ${companyId}
        AND aal.performed_at >= NOW() - INTERVAL '30 days'
        AND aal.target_type IN ('job','quote','invoice','client','employee')
        AND aal.action NOT LIKE 'lms_%'
        AND aal.action NOT IN (
          'login_success','login_failed','logout','password_changed',
          'password_reset','company_switch','user_companies_grant',
          'user_companies_revoke','SMOKE_TEST'
        )
      ORDER BY aal.performed_at DESC
      LIMIT ${limit}
    `);
    const activities = (r.rows as any[]).map((x) => ({
      id: Number(x.id),
      action: String(x.action),
      target_type: String(x.target_type),
      target_id: x.target_id != null ? String(x.target_id) : null,
      new_value: x.new_value ?? null,
      performed_at: x.performed_at,
      user_name: x.user_name ?? null,
    }));
    return res.json({ activities });
  } catch (err) {
    console.error("Recent activity error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Live weather for the dispatch day ───────────────────────────────────────
// [dashboard-weather 2026-07-22] Weather is an operations input for a cleaning
// crew, not decoration: snow and heavy rain move drive time, push arrival
// windows, and drive same-day cancellations. The office should see it on the
// dashboard rather than on a second tab.
//
// Source is Open-Meteo — free, no API key, no account. The only thing that
// leaves this server is a city name (e.g. "Oak Lawn, IL"); no customer or
// employee data is sent. Coordinates and the forecast are cached in-process so
// a dashboard refresh doesn't re-hit the provider.
//
// Location comes from the ACTIVE BRANCH's city/state (branches.city/state),
// falling back to the company's. Oak Lawn and Schaumburg are ~30 miles apart
// with genuinely different lake-effect weather, so the branch matters — the
// coordinates are never hardcoded per branch.
const WMO: Record<number, string> = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Rain showers", 81: "Rain showers", 82: "Heavy showers",
  85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorms", 96: "Thunderstorms", 99: "Severe thunderstorms",
};

// Codes where the office should expect schedule friction. Drives the card's
// advisory line — the only opinion the endpoint offers.
const ROUGH = new Set([56, 57, 65, 66, 67, 71, 73, 75, 77, 82, 85, 86, 95, 96, 99]);

const geoCache = new Map<string, { lat: number; lon: number } | null>();
const wxCache = new Map<string, { at: number; body: any }>();
const WX_TTL_MS = 15 * 60 * 1000;

async function geocode(place: string): Promise<{ lat: number; lon: number } | null> {
  if (geoCache.has(place)) return geoCache.get(place)!;
  const [city, state] = place.split(",").map(s => s.trim());
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&country=US&language=en&format=json`;
  const r = await fetch(url);
  if (!r.ok) { geoCache.set(place, null); return null; }
  const j: any = await r.json();
  const hits: any[] = j?.results || [];
  // Prefer the hit in the right state — "Schaumburg" is unambiguous, "Oak Lawn"
  // is not.
  const hit = hits.find(h => !state || h.admin1_code === state || h.admin1 === state) || hits[0];
  const out = hit ? { lat: hit.latitude, lon: hit.longitude } : null;
  geoCache.set(place, out);
  return out;
}

router.get("/weather", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const branchId = req.query.branch_id && req.query.branch_id !== "all"
      ? parseInt(String(req.query.branch_id), 10) : null;

    let place = "";
    if (branchId != null) {
      const b = await db.execute(sql`
        SELECT city, state FROM branches WHERE id = ${branchId} AND company_id = ${companyId} LIMIT 1`);
      const row: any = b.rows[0];
      if (row?.city) place = `${row.city}, ${row.state || ""}`;
    }
    if (!place) {
      const c = await db.execute(sql`SELECT city, state FROM companies WHERE id = ${companyId} LIMIT 1`);
      const row: any = c.rows[0];
      if (row?.city) place = `${row.city}, ${row.state || ""}`;
    }
    // No city on file is a data gap, not an error — the card just hides.
    if (!place) return res.json({ available: false, reason: "no_location" });

    const cached = wxCache.get(place);
    if (cached && Date.now() - cached.at < WX_TTL_MS) return res.json(cached.body);

    const geo = await geocode(place);
    if (!geo) return res.json({ available: false, reason: "geocode_failed", place });

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}`
      + `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m`
      + `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code`
      + `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch`
      + `&timezone=America%2FChicago&forecast_days=1`;
    const r = await fetch(url);
    if (!r.ok) return res.json({ available: false, reason: "provider_error", place });
    const j: any = await r.json();

    const code = Number(j?.current?.weather_code ?? 0);
    const body = {
      available: true,
      place,
      temp: Math.round(Number(j?.current?.temperature_2m ?? 0)),
      feels_like: Math.round(Number(j?.current?.apparent_temperature ?? 0)),
      code,
      condition: WMO[code] || "—",
      wind_mph: Math.round(Number(j?.current?.wind_speed_10m ?? 0)),
      high: Math.round(Number(j?.daily?.temperature_2m_max?.[0] ?? 0)),
      low: Math.round(Number(j?.daily?.temperature_2m_min?.[0] ?? 0)),
      precip_chance: Number(j?.daily?.precipitation_probability_max?.[0] ?? 0),
      rough: ROUGH.has(code),
    };
    wxCache.set(place, { at: Date.now(), body });
    return res.json(body);
  } catch (err) {
    console.error("GET /dashboard/weather error:", err);
    // Weather must never break the dashboard.
    return res.json({ available: false, reason: "error" });
  }
});

export default router;
