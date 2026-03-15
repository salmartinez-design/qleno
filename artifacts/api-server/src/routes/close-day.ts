import { Router } from "express";
import { db } from "@workspace/db";
import {
  jobsTable, invoicesTable, paymentsTable, timeclockTable,
  clientsTable, usersTable, dailySummariesTable, notificationLogTable
} from "@workspace/db/schema";
import { eq, and, sql, isNull, count, sum, lt, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const todayStr = new Date().toISOString().split("T")[0];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [todayJobs, completedJobs, inProgressJobs, scheduledJobs, flaggedEntries] = await Promise.all([
      db.select({ id: jobsTable.id, status: jobsTable.status, client_id: jobsTable.client_id })
        .from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.scheduled_date, todayStr))),
      db.select({ cnt: count() })
        .from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.scheduled_date, todayStr), eq(jobsTable.status, "complete"))),
      db.select({ cnt: count() })
        .from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.scheduled_date, todayStr), eq(jobsTable.status, "in_progress"))),
      db.select({ cnt: count() })
        .from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.scheduled_date, todayStr), eq(jobsTable.status, "scheduled"))),
      db.select({ cnt: count() })
        .from(timeclockTable)
        .where(and(
          eq(timeclockTable.company_id, companyId),
          eq(timeclockTable.flagged, true),
          sql`${timeclockTable.clock_in_at} >= ${today.toISOString()}`,
          sql`${timeclockTable.clock_in_at} < ${tomorrow.toISOString()}`
        )),
    ]);

    const todayJobIds = todayJobs.map(j => j.id);

    let invoicedCount = 0;
    if (todayJobIds.length > 0) {
      const invoicedRes = await db.select({ cnt: count() })
        .from(invoicesTable)
        .where(and(
          eq(invoicesTable.company_id, companyId),
          inArray(invoicesTable.job_id, todayJobIds),
          inArray(invoicesTable.status, ["sent", "paid"])
        ));
      invoicedCount = invoicedRes[0]?.cnt || 0;
    }

    const uninvoicedCount = completedJobs[0]?.cnt ? completedJobs[0].cnt - invoicedCount : 0;

    const [paymentsToday, sentInvoices, overdueInvoices, timeclockToday] = await Promise.all([
      db.select({ total: sum(paymentsTable.amount) })
        .from(paymentsTable)
        .where(and(
          eq(paymentsTable.company_id, companyId),
          sql`${paymentsTable.created_at} >= ${today.toISOString()}`,
          sql`${paymentsTable.created_at} < ${tomorrow.toISOString()}`
        )),
      db.select({ cnt: count(), total: sum(invoicesTable.total) })
        .from(invoicesTable)
        .where(and(eq(invoicesTable.company_id, companyId), inArray(invoicesTable.status, ["sent", "overdue"]))),
      db.select({ cnt: count(), total: sum(invoicesTable.total) })
        .from(invoicesTable)
        .where(and(
          eq(invoicesTable.company_id, companyId),
          eq(invoicesTable.status, "sent"),
          lt(invoicesTable.due_date as any, todayStr)
        )),
      db.select({
        id: timeclockTable.id,
        user_id: timeclockTable.user_id,
        clock_in_at: timeclockTable.clock_in_at,
        clock_out_at: timeclockTable.clock_out_at,
        flagged: timeclockTable.flagged,
        user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
      })
        .from(timeclockTable)
        .leftJoin(usersTable, eq(timeclockTable.user_id, usersTable.id))
        .where(and(
          eq(timeclockTable.company_id, companyId),
          sql`${timeclockTable.clock_in_at} >= ${today.toISOString()}`,
          sql`${timeclockTable.clock_in_at} < ${tomorrow.toISOString()}`
        )),
    ]);

    const missingClockOut = timeclockToday.filter(e => !e.clock_out_at);

    return res.json({
      date: todayStr,
      jobs: {
        complete: completedJobs[0]?.cnt || 0,
        in_progress: inProgressJobs[0]?.cnt || 0,
        scheduled: scheduledJobs[0]?.cnt || 0,
        flagged: 0,
        total: todayJobs.length,
      },
      invoicing: {
        invoiced: invoicedCount,
        total_complete: completedJobs[0]?.cnt || 0,
        uninvoiced: Math.max(0, uninvoicedCount),
      },
      payments: {
        collected_today: parseFloat(paymentsToday[0]?.total || "0"),
        awaiting_payment: sentInvoices[0]?.cnt || 0,
        overdue_count: overdueInvoices[0]?.cnt || 0,
        overdue_total: parseFloat(overdueInvoices[0]?.total || "0"),
      },
      timeclock: {
        total: timeclockToday.length,
        missing_clock_out: missingClockOut.map(e => ({
          id: e.id,
          user_id: e.user_id,
          user_name: e.user_name,
          clock_in_at: e.clock_in_at,
        })),
        flagged: flaggedEntries[0]?.cnt || 0,
      },
    });
  } catch (err) {
    console.error("Close day get error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to load close day data" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const todayStr = new Date().toISOString().split("T")[0];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [completeJobs, flaggedJobs, invoicesCreated, invoicesSent, paidToday, outstanding, missingClock] = await Promise.all([
      db.select({ cnt: count() }).from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.scheduled_date, todayStr), eq(jobsTable.status, "complete"))),
      db.select({ cnt: count() }).from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.scheduled_date, todayStr))),
      db.select({ cnt: count() }).from(invoicesTable)
        .where(and(eq(invoicesTable.company_id, companyId), sql`date(${invoicesTable.created_at}) = ${todayStr}`)),
      db.select({ cnt: count() }).from(invoicesTable)
        .where(and(eq(invoicesTable.company_id, companyId), sql`date(${invoicesTable.sent_at}) = ${todayStr}`)),
      db.select({ total: sum(paymentsTable.amount) }).from(paymentsTable)
        .where(and(eq(paymentsTable.company_id, companyId),
          sql`${paymentsTable.created_at} >= ${today.toISOString()}`,
          sql`${paymentsTable.created_at} < ${tomorrow.toISOString()}`)),
      db.select({ total: sum(invoicesTable.total) }).from(invoicesTable)
        .where(and(eq(invoicesTable.company_id, companyId), inArray(invoicesTable.status, ["sent", "overdue"]))),
      db.select({ cnt: count() }).from(timeclockTable)
        .where(and(eq(timeclockTable.company_id, companyId),
          isNull(timeclockTable.clock_out_at),
          sql`${timeclockTable.clock_in_at} >= ${today.toISOString()}`,
          sql`${timeclockTable.clock_in_at} < ${tomorrow.toISOString()}`)),
    ]);

    const existing = await db.select({ id: dailySummariesTable.id })
      .from(dailySummariesTable)
      .where(and(eq(dailySummariesTable.company_id, companyId), eq(dailySummariesTable.summary_date, todayStr)))
      .limit(1);

    const summaryData = {
      company_id: companyId,
      summary_date: todayStr,
      jobs_complete: completeJobs[0]?.cnt || 0,
      jobs_flagged: 0,
      invoices_created: invoicesCreated[0]?.cnt || 0,
      invoices_sent: invoicesSent[0]?.cnt || 0,
      revenue_collected: parseFloat(paidToday[0]?.total || "0").toFixed(2),
      revenue_outstanding: parseFloat(outstanding[0]?.total || "0").toFixed(2),
      clock_entries_missing: missingClock[0]?.cnt || 0,
      marked_complete_by: req.auth!.userId,
      marked_complete_at: new Date(),
    };

    if (existing[0]) {
      await db.update(dailySummariesTable).set(summaryData).where(eq(dailySummariesTable.id, existing[0].id));
    } else {
      await db.insert(dailySummariesTable).values(summaryData);
    }

    await db.insert(notificationLogTable).values({
      company_id: companyId,
      recipient: "system",
      channel: "system",
      trigger: "day_closed",
      status: "sent",
      metadata: { date: todayStr, revenue: summaryData.revenue_collected } as any,
    });

    return res.json({ ok: true, date: todayStr });
  } catch (err) {
    console.error("Close day post error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to mark day complete" });
  }
});

router.post("/timeclock/:id/clock-out", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const entryId = parseInt(req.params.id);
    const { clock_out_at } = req.body;

    await db.update(timeclockTable)
      .set({ clock_out_at: clock_out_at ? new Date(clock_out_at) : new Date() })
      .where(and(eq(timeclockTable.id, entryId), eq(timeclockTable.company_id, req.auth!.companyId)));

    return res.json({ ok: true });
  } catch (err) {
    console.error("Clock out error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to set clock out" });
  }
});

export default router;
