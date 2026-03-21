import { Router } from "express";
import { db } from "@workspace/db";
import { jobsTable, clientsTable, usersTable, invoicesTable, timeclockTable, scorecardsTable, accountsTable, accountPropertiesTable } from "@workspace/db/schema";
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

    // Today's job counts by status
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

    // Today's revenue (complete jobs' base_fee sum)
    const todayRevenue = todayJobs.filter(j => j.status === 'complete').reduce((s, j) => s + parseFloat(j.base_fee || '0'), 0);

    // Flagged clocks (unresolved)
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

    // Overdue invoices
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

    // Employees with jobs today — check active timeclock
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
        // Check if next job starts within 30 min
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

    // Auto-generate alerts
    const alerts: { type: string; message: string; action: string; id?: number }[] = [];

    // Employees not clocked in with imminent jobs
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
      alerts.push({
        type: 'warning',
        message: `Invoice #${inv.id} overdue by ${daysAgo} days — ${inv.client_name}`,
        action: 'send_invoice',
        id: inv.id,
      });
    }

    for (const flag of flagged) {
      alerts.push({
        type: 'warning',
        message: `Clock-in flagged — ${flag.user_name} was ${flag.distance_ft}ft from job site`,
        action: 'review_clock',
        id: flag.id,
      });
    }

    // En route count
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

    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekStartStr = weekStart.toISOString().split("T")[0];
    const prevWeekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const prevWeekStartStr = prevWeekStart.toISOString().split("T")[0];

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

    const [
      weekRev, prevWeekRev,
      monthRev, lastMonthRev,
      monthJobs,
      avgScore,
      activeClients,
      atRiskClients,
      unassignedToday,
      flaggedToday,
      overdueInvoices,
      completeNotInvoiced,
    ] = await Promise.all([
      // Week revenue
      db.select({ total: sum(invoicesTable.total) }).from(invoicesTable)
        .where(and(eq(invoicesTable.company_id, companyId), eq(invoicesTable.status, "paid"), gte(invoicesTable.created_at, weekStart))),
      // Previous week revenue
      db.select({ total: sum(invoicesTable.total) }).from(invoicesTable)
        .where(and(eq(invoicesTable.company_id, companyId), eq(invoicesTable.status, "paid"), gte(invoicesTable.created_at, prevWeekStart), lt(invoicesTable.created_at, weekStart))),
      // Month revenue
      db.select({ total: sum(invoicesTable.total) }).from(invoicesTable)
        .where(and(eq(invoicesTable.company_id, companyId), eq(invoicesTable.status, "paid"), gte(invoicesTable.created_at, monthStart))),
      // Last month revenue
      db.select({ total: sum(invoicesTable.total) }).from(invoicesTable)
        .where(and(eq(invoicesTable.company_id, companyId), eq(invoicesTable.status, "paid"), gte(invoicesTable.created_at, lastMonthStart), lte(invoicesTable.created_at, lastMonthEnd))),
      // Month jobs (for avg bill)
      db.select({ count: count(), fee_sum: sum(jobsTable.base_fee) }).from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, monthStartStr))),
      // Avg quality score (last 30 days)
      db.select({ avg: avg(scorecardsTable.score) }).from(scorecardsTable)
        .where(and(eq(scorecardsTable.company_id, companyId), eq(scorecardsTable.excluded, false), gte(scorecardsTable.created_at, thirtyDaysAgo))),
      // Active clients
      db.select({ count: count() }).from(clientsTable).where(eq(clientsTable.company_id, companyId)),
      // Clients at risk: no job booked in 30 days
      db.select({ count: count() }).from(clientsTable)
        .where(and(eq(clientsTable.company_id, companyId)))
        .then(async () => {
          const scheduled = await db.select({ client_id: jobsTable.client_id }).from(jobsTable)
            .where(and(eq(jobsTable.company_id, companyId), gte(jobsTable.scheduled_date, thirtyDaysAgoStr)));
          const activeClientIds = new Set(scheduled.map(j => j.client_id));
          const allC = await db.select({ id: clientsTable.id }).from(clientsTable).where(eq(clientsTable.company_id, companyId));
          return [{ count: allC.filter(c => !activeClientIds.has(c.id)).length }];
        }),
      // Unassigned jobs today
      db.select({ count: count() }).from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.scheduled_date, todayStr), isNull(jobsTable.assigned_user_id))),
      // Flagged clock-ins today
      db.select({ count: count() }).from(timeclockTable)
        .where(and(eq(timeclockTable.company_id, companyId), eq(timeclockTable.flagged, true), gte(timeclockTable.clock_in_at, new Date(todayStr)))),
      // Overdue invoices
      db.select({ count: count() }).from(invoicesTable)
        .where(and(eq(invoicesTable.company_id, companyId), eq(invoicesTable.status, "overdue"))),
      // Jobs complete but not invoiced
      db.select({ count: count() }).from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete")))
        .then(async () => {
          const completedJobIds = await db.select({ id: jobsTable.id }).from(jobsTable)
            .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.status, "complete"), gte(jobsTable.scheduled_date, monthStartStr)));
          const invoicedJobIds = await db.select({ job_id: invoicesTable.job_id }).from(invoicesTable)
            .where(and(eq(invoicesTable.company_id, companyId), isNotNull(invoicesTable.job_id)));
          const invoicedSet = new Set(invoicedJobIds.map(i => i.job_id));
          return [{ count: completedJobIds.filter(j => !invoicedSet.has(j.id)).length }];
        }),
    ]);

    const weekRevNum = parseFloat(weekRev[0]?.total || "0");
    const prevWeekRevNum = parseFloat(prevWeekRev[0]?.total || "0");
    const weekDelta = prevWeekRevNum > 0 ? Math.round(((weekRevNum - prevWeekRevNum) / prevWeekRevNum) * 100) : null;

    const monthRevNum = parseFloat(monthRev[0]?.total || "0");
    const lastMonthRevNum = parseFloat(lastMonthRev[0]?.total || "0");
    const monthDelta = lastMonthRevNum > 0 ? Math.round(((monthRevNum - lastMonthRevNum) / lastMonthRevNum) * 100) : null;

    const jobCount = Number(monthJobs[0]?.count || 0);
    const feeSum = parseFloat(monthJobs[0]?.fee_sum || "0");
    const avgBill = jobCount > 0 ? feeSum / jobCount : 0;

    const qualityScore = avgScore[0]?.avg ? Math.round(parseFloat(avgScore[0].avg) * 25) : null;

    const atRisk = Number((atRiskClients as any)[0]?.count || 0);
    const unassigned = Number(unassignedToday[0]?.count || 0);
    const flagged = Number(flaggedToday[0]?.count || 0);
    const overdue = Number(overdueInvoices[0]?.count || 0);
    const notInvoiced = Number((completeNotInvoiced as any)[0]?.count || 0);

    // Build action items
    type ActionItem = { level: 'red' | 'amber' | 'blue'; text: string; action: string };
    const actions: ActionItem[] = [];
    if (flagged > 0) actions.push({ level: 'red', text: `${flagged} flagged clock-in${flagged > 1 ? 's' : ''} need review`, action: '/employees/clocks' });
    if (unassigned > 0) actions.push({ level: 'red', text: `${unassigned} job${unassigned > 1 ? 's' : ''} today ${unassigned > 1 ? 'are' : 'is'} unassigned`, action: '/jobs' });
    if (overdue > 0) actions.push({ level: 'red', text: `${overdue} invoice${overdue > 1 ? 's' : ''} overdue — review immediately`, action: '/invoices' });
    if (notInvoiced > 0) actions.push({ level: 'amber', text: `${notInvoiced} completed job${notInvoiced > 1 ? 's' : ''} this month not yet invoiced`, action: '/invoices' });
    if (atRisk > 0) actions.push({ level: 'amber', text: `${atRisk} client${atRisk > 1 ? 's' : ''} with no booking in 30+ days`, action: '/customers' });

    return res.json({
      week_revenue: weekRevNum,
      week_delta: weekDelta,
      month_revenue: monthRevNum,
      month_delta: monthDelta,
      avg_bill: avgBill,
      active_clients: Number(activeClients[0]?.count || 0),
      quality_score: qualityScore,
      clients_at_risk: atRisk,
      action_items: actions.slice(0, 5),
    });
  } catch (err) {
    console.error("Dashboard kpis error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/commercial-alerts", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const todayStr = new Date().toISOString().split("T")[0];

    const [chargeFailedJobs, noCardAccounts, hoursVarianceJobs] = await Promise.all([
      // Alert 1: Charge failed jobs
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
        isNull(jobsTable.charge_succeeded_at),
        isNotNull(jobsTable.account_id),
      )),

      // Alert 2: Accounts expecting auto-charge but no card on file
      db.select({
        id: accountsTable.id,
        account_name: accountsTable.account_name,
      })
      .from(accountsTable)
      .where(and(
        eq(accountsTable.company_id, companyId),
        eq(accountsTable.is_active, true),
        sql`${accountsTable.payment_method} = 'card_on_file'`,
        isNull(accountsTable.stripe_customer_id),
      )),

      // Alert 3: Today's completed commercial jobs with hours overrun > 0.5
      db.select({
        id: jobsTable.id,
        account_id: jobsTable.account_id,
        account_name: accountsTable.account_name,
        estimated_hours: jobsTable.estimated_hours,
        billed_hours: jobsTable.billed_hours,
        hourly_rate: jobsTable.hourly_rate,
        property_address: accountPropertiesTable.address,
        assigned_user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        charge_attempted_at: jobsTable.charge_attempted_at,
      })
      .from(jobsTable)
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(accountPropertiesTable, eq(jobsTable.account_property_id, accountPropertiesTable.id))
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.status, "complete"),
        eq(jobsTable.scheduled_date, todayStr),
        isNotNull(jobsTable.account_id),
        isNotNull(jobsTable.billed_hours),
        isNotNull(jobsTable.estimated_hours),
        isNull(jobsTable.charge_attempted_at),
        sql`${jobsTable.billing_method} = 'hourly'`,
        sql`${jobsTable.billed_hours}::numeric > ${jobsTable.estimated_hours}::numeric + 0.5`,
      )),
    ]);

    const alerts: { level: string; type: string; text: string; job_id?: number; account_id?: number }[] = [];

    for (const j of chargeFailedJobs) {
      const amt = j.billed_amount ? `$${parseFloat(j.billed_amount).toFixed(2)}` : "unknown amount";
      const date = j.charge_failed_at ? new Date(j.charge_failed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      const addr = j.property_address ? `${j.property_address}${j.property_city ? `, ${j.property_city}` : ""}` : "";
      alerts.push({
        level: "red",
        type: "charge_failed",
        text: `${j.account_name} — ${amt} charge failed on ${date}${addr ? ` · ${addr}` : ""}`,
        job_id: j.id,
        account_id: j.account_id ?? undefined,
      });
    }

    for (const j of hoursVarianceJobs) {
      const est = j.estimated_hours ? parseFloat(j.estimated_hours) : 0;
      const billed = j.billed_hours ? parseFloat(j.billed_hours) : 0;
      const rate = j.hourly_rate ? parseFloat(j.hourly_rate) : 0;
      const extra = Math.max(0, billed - est);
      const extraCost = extra * rate;
      const addr = j.property_address || "";
      alerts.push({
        level: "amber",
        type: "hours_variance",
        text: `${j.assigned_user_name} ran ${extra.toFixed(1)}h over at ${addr} · $${extraCost.toFixed(2)} additional billed`,
        job_id: j.id,
        account_id: j.account_id ?? undefined,
      });
    }

    for (const a of noCardAccounts) {
      alerts.push({
        level: "amber",
        type: "no_card_on_file",
        text: `${a.account_name} — no card on file. Account expects auto-charge.`,
        account_id: a.id,
      });
    }

    return res.json({ alerts });
  } catch (err) {
    console.error("Commercial alerts error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
