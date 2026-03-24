import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, clientsTable, usersTable, invoicesTable, timeclockTable, scorecardsTable, accountsTable, accountPropertiesTable, quotesTable } from "@workspace/db/schema";
import { eq, and, gte, lte, lt, isNull, count, sum, avg, desc, sql, isNotNull } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

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
        eq(usersTable.is_active, true)
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

    const flagged = await db
      .select({
        id: timeclockTable.id,
        user_id: timeclockTable.user_id,
        distance_ft: timeclockTable.distance_from_job_ft,
        user_name: sql<string>`concat(${usersTable.first_name},' ',${usersTable.last_name})`,
      })
      .from(timeclockTable)
      .leftJoin(usersTable, eq(timeclockTable.user_id, usersTable.id))
      .where(and(eq(timeclockTable.company_id, companyId), eq(timeclockTable.flagged, true), gte(timeclockTable.clock_in_at, new Date(todayStr))))
      .limit(5);

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

    return res.json({
      counts: {
        in_progress: Number(inProgress[0].c),
        scheduled: Number(scheduled[0].c),
        complete: Number(complete[0].c),
        cancelled: Number(cancelled[0].c),
        en_route: enRouteCount,
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

    // job_history columns: bill_rate (amount), scheduled_date (date)
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
    ] = await Promise.all([
      // Week revenue from job_history
      db.execute(sql`
        SELECT COALESCE(SUM(bill_rate), 0)::numeric AS total
        FROM job_history
        WHERE company_id = ${companyId}
          AND scheduled_date >= ${weekStartStr}
          AND scheduled_date <= ${todayStr}
      `),
      // Previous week revenue
      db.execute(sql`
        SELECT COALESCE(SUM(bill_rate), 0)::numeric AS total
        FROM job_history
        WHERE company_id = ${companyId}
          AND scheduled_date >= ${prevWeekStartStr}
          AND scheduled_date <= ${prevWeekEndStr}
      `),
      // This month revenue
      db.execute(sql`
        SELECT COALESCE(SUM(bill_rate), 0)::numeric AS total
        FROM job_history
        WHERE company_id = ${companyId}
          AND scheduled_date >= ${monthStartStr}
          AND scheduled_date <= ${todayStr}
      `),
      // Last month revenue
      db.execute(sql`
        SELECT COALESCE(SUM(bill_rate), 0)::numeric AS total
        FROM job_history
        WHERE company_id = ${companyId}
          AND scheduled_date >= ${lastMonthStartStr}
          AND scheduled_date <= ${lastMonthEndStr}
      `),
      // Avg bill — last 30 days from job_history
      db.execute(sql`
        SELECT COALESCE(AVG(bill_rate), 0)::numeric AS avg_bill
        FROM job_history
        WHERE company_id = ${companyId}
          AND scheduled_date >= ${thirtyDaysAgoStr}
          AND scheduled_date <= ${todayStr}
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
      // At-risk: active clients with job_history but no service in last 45 days
      db.execute(sql`
        SELECT COUNT(DISTINCT c.id)::int AS at_risk
        FROM clients c
        WHERE c.company_id = ${companyId}
          AND c.is_active = true
          AND EXISTS (
            SELECT 1 FROM job_history jh
            WHERE jh.customer_id = c.id AND jh.company_id = ${companyId}
          )
          AND NOT EXISTS (
            SELECT 1 FROM job_history jh2
            WHERE jh2.customer_id = c.id
              AND jh2.company_id = ${companyId}
              AND jh2.scheduled_date >= ${fortyFiveDaysAgoStr}
          )
          AND NOT EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.client_id = c.id
              AND j.company_id = ${companyId}
              AND j.scheduled_date >= ${thirtyDaysAgoStr}
          )
          AND c.created_at < now() - interval '30 days'
      `),
      // Unassigned jobs today
      db.select({ count: count() }).from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.scheduled_date, todayStr), isNull(jobsTable.assigned_user_id))),
      // Flagged clock-ins today
      db.select({ count: count() }).from(timeclockTable)
        .where(and(eq(timeclockTable.company_id, companyId), eq(timeclockTable.flagged, true), gte(timeclockTable.clock_in_at, new Date(todayStr)))),
      // Overdue invoices
      db.select({ count: count() }).from(invoicesTable)
        .where(and(eq(invoicesTable.company_id, companyId), eq(invoicesTable.status, "overdue"))),
      // Jobs complete but not invoiced (this month)
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

      // HCP: New Jobs Booked This Week — jobs created_at >= weekStart
      db.select({ c: count() }).from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, companyId),
          gte(jobsTable.created_at, weekStart),
        )),

      // HCP: Quotes Given Today
      db.select({ c: count() }).from(quotesTable)
        .where(and(
          eq(quotesTable.company_id, companyId),
          gte(quotesTable.created_at, new Date(todayStr)),
        )),

      // HCP: Booked Online This Month (source = 'online_booking' in job_history)
      db.execute(sql`
        SELECT COUNT(*)::int AS booked_online
        FROM job_history
        WHERE company_id = ${companyId}
          AND source = 'online_booking'
          AND scheduled_date >= ${monthStartStr}
          AND scheduled_date <= ${todayStr}
      `),
    ]);

    const weekRevNum = parseFloat((jhWeekRev.rows[0] as any)?.total || "0");
    const prevWeekRevNum = parseFloat((jhPrevWeekRev.rows[0] as any)?.total || "0");
    const weekDelta = prevWeekRevNum > 0 ? Math.round(((weekRevNum - prevWeekRevNum) / prevWeekRevNum) * 100) : null;

    const monthRevNum = parseFloat((jhMonthRev.rows[0] as any)?.total || "0");
    const lastMonthRevNum = parseFloat((jhLastMonthRev.rows[0] as any)?.total || "0");
    const monthDelta = lastMonthRevNum > 0 ? Math.round(((monthRevNum - lastMonthRevNum) / lastMonthRevNum) * 100) : null;

    const avgBill = parseFloat((jhAvgBill.rows[0] as any)?.avg_bill || "0");
    const qualityScoreRaw = (avgScore as any).rows?.[0]?.avg_score;
    const qualityScore = qualityScoreRaw != null ? Math.round(parseFloat(qualityScoreRaw)) : null;
    const atRiskRaw = Number((atRiskResult.rows[0] as any)?.at_risk || 0);
    const unassigned = Number(unassignedToday[0]?.count || 0);
    const flagged = Number(flaggedToday[0]?.count || 0);
    const overdue = Number(overdueInvoices[0]?.count || 0);
    const notInvoiced = Number((completeNotInvoiced as any)[0]?.count || 0);
    const clientsAtRisk = atRiskRaw;

    // HCP values
    const revBookedToday = parseFloat((hcpRevBookedToday[0] as any)?.total || "0");
    const newJobsThisWeek = Number((hcpNewJobsThisWeek[0] as any)?.c || 0);
    const quotesGivenToday = Number((hcpQuotesToday[0] as any)?.c || 0);
    const bookedOnlineMonth = Number((hcpBookedOnlineMonth.rows[0] as any)?.booked_online || 0);

    type ActionItem = { level: 'red' | 'amber' | 'blue'; text: string; action: string };
    const actions: ActionItem[] = [];
    if (flagged > 0) actions.push({ level: 'red', text: `${flagged} flagged clock-in${flagged > 1 ? 's' : ''} need review`, action: '/employees/clocks' });
    if (unassigned > 0) actions.push({ level: 'red', text: `${unassigned} job${unassigned > 1 ? 's' : ''} today ${unassigned > 1 ? 'are' : 'is'} unassigned`, action: '/jobs' });
    if (overdue > 0) actions.push({ level: 'red', text: `${overdue} invoice${overdue > 1 ? 's' : ''} overdue — review immediately`, action: '/invoices' });
    if (notInvoiced > 0) actions.push({ level: 'amber', text: `${notInvoiced} completed job${notInvoiced > 1 ? 's' : ''} this month not yet invoiced`, action: '/invoices' });
    if (atRiskRaw > 0) actions.push({ level: 'amber', text: `${atRiskRaw} client${atRiskRaw > 1 ? 's' : ''} with no booking in 30+ days`, action: '/customers' });

    return res.json({
      week_revenue: weekRevNum,
      week_delta: weekDelta,
      month_revenue: monthRevNum,
      month_delta: monthDelta,
      avg_bill: avgBill,
      active_clients: Number(activeClients[0]?.count || 0),
      quality_score: qualityScore,
      clients_at_risk: clientsAtRisk,
      churn_configured: true,
      action_items: actions.slice(0, 5),
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

    // job_history columns: bill_rate (amount), scheduled_date (date)
    const rows = await db.execute(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('month', scheduled_date), 'Mon ''YY') AS month,
        DATE_TRUNC('month', scheduled_date) AS month_date,
        COALESCE(SUM(bill_rate), 0)::numeric AS revenue,
        COUNT(*)::int AS jobs
      FROM job_history
      WHERE company_id = ${companyId}
        AND scheduled_date >= DATE_TRUNC('month', NOW()) - INTERVAL '11 months'
        AND scheduled_date <= NOW()
      GROUP BY DATE_TRUNC('month', scheduled_date)
      ORDER BY month_date ASC
    `);

    return res.json({
      data: rows.rows.map((r: any) => ({
        month: r.month,
        revenue: parseFloat(r.revenue),
        jobs: Number(r.jobs),
      })),
    });
  } catch (err) {
    console.error("Revenue chart error:", err);
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
        billing_type: accountsTable.billing_type,
      })
      .from(accountsTable)
      .where(and(
        eq(accountsTable.company_id, companyId),
        eq(accountsTable.is_active, true),
        isNull(accountsTable.stripe_customer_id),
        eq(accountsTable.billing_type, "invoice"),
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

export default router;
