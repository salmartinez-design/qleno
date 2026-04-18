import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, clientsTable, usersTable, invoicesTable, timeclockTable, scorecardsTable, accountsTable, accountPropertiesTable, quotesTable, recurringSchedulesTable } from "@workspace/db/schema";
import { eq, and, or, gte, lte, lt, isNull, count, sum, avg, desc, sql, isNotNull, ne, notInArray } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

// ── Weekly forecast in-memory cache (5 min TTL, keyed by companyId + week start) ──
const wfCache = new Map<string, { data: unknown; ts: number }>();

router.get("/metrics", requireAuth, async (req, res) => {
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

router.get("/today", requireAuth, async (req, res) => {
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
      })
        .from(jobsTable)
        .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.scheduled_date, todayStr), ...todayBranchCond)),
      db.select({ c: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "in_progress"), eq(jobsTable.scheduled_date, todayStr), ...todayBranchCond)),
      db.select({ c: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), eq(jobsTable.scheduled_date, todayStr), ...todayBranchCond)),
      db.select({ c: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "cancelled"), eq(jobsTable.scheduled_date, todayStr), ...todayBranchCond)),
      db.select({ c: count() }).from(jobsTable).where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "scheduled"), eq(jobsTable.scheduled_date, todayStr), ...todayBranchCond)),
    ]);

    const todayRevenue = todayJobs.filter(j => j.status === 'complete').reduce((s, j) => s + parseFloat(j.base_fee || '0'), 0);

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

    return res.json({
      counts: {
        in_progress: Number(inProgress[0].c),
        scheduled: Number(scheduled[0].c),
        complete: Number(complete[0].c),
        cancelled: Number(cancelled[0].c),
        en_route: enRouteCount,
        flagged: flaggedCount,
        unassigned: unassignedCount,
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

router.get("/kpis", requireAuth, async (req, res) => {
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
      // Week revenue from job_history (authoritative historical billed revenue)
      db.execute(sql`
        SELECT COALESCE(SUM(revenue), 0)::numeric AS total
        FROM job_history
        WHERE company_id = ${companyId}
          AND job_date >= ${weekStartStr}
          AND job_date <= ${todayStr}
      `),
      // Previous week revenue (for delta calculation)
      db.execute(sql`
        SELECT COALESCE(SUM(revenue), 0)::numeric AS total
        FROM job_history
        WHERE company_id = ${companyId}
          AND job_date >= ${prevWeekStartStr}
          AND job_date <= ${prevWeekEndStr}
      `),
      // This month revenue (MTD)
      db.execute(sql`
        SELECT COALESCE(SUM(revenue), 0)::numeric AS total
        FROM job_history
        WHERE company_id = ${companyId}
          AND job_date >= ${monthStartStr}
          AND job_date <= ${todayStr}
      `),
      // Last month revenue (for delta calculation)
      db.execute(sql`
        SELECT COALESCE(SUM(revenue), 0)::numeric AS total
        FROM job_history
        WHERE company_id = ${companyId}
          AND job_date >= ${lastMonthStartStr}
          AND job_date <= ${lastMonthEndStr}
      `),
      // Avg bill — last 30 days
      db.execute(sql`
        SELECT COALESCE(AVG(revenue), 0)::numeric AS avg_bill
        FROM job_history
        WHERE company_id = ${companyId}
          AND job_date >= ${thirtyDaysAgoStr}
          AND job_date <= ${todayStr}
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

      // HCP: New Jobs Booked This Week — real bookings only
      // Exclude phantom recurring-engine auto-spawned jobs (recurring_schedule_id set + base_fee=0).
      // Those aren't "new bookings" in the human sense — they're cron-generated.
      db.select({ c: count() }).from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, companyId),
          gte(jobsTable.created_at, weekStart),
          or(
            isNull(jobsTable.recurring_schedule_id),
            sql`CAST(${jobsTable.base_fee} AS NUMERIC) > 0`,
          ),
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
        SELECT COALESCE(SUM(base_fee), 0)::numeric AS total
        FROM jobs
        WHERE company_id = ${companyId}
          AND status != 'cancelled'
          AND scheduled_date >= ${next7Start}
          AND scheduled_date <= ${next7End}
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
    const newJobsThisWeek = Number(hcpNewJobsThisWeek[0]?.c || 0);
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
        new_jobs_this_week: newJobsThisWeek,
        quotes_given_today: quotesGivenToday,
        booked_online_month: bookedOnlineMonth,
      },
    });
  } catch (err) {
    console.error("Dashboard kpis error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/revenue-chart", requireAuth, async (req, res) => {
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

router.get("/techs-today", requireAuth, async (req, res) => {
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

router.get("/commercial-alerts", requireAuth, async (req, res) => {
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
router.get("/weekly-forecast", requireAuth, async (req, res) => {
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

export default router;
