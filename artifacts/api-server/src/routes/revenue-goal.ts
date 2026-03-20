import { Router } from "express";
import { db } from "@workspace/db";
import { companiesTable, jobsTable, clientsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, count, sum, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();
const OWNER_ADMIN = requireRole("owner", "admin");

function ytdStart(year?: number) {
  const y = year ?? new Date().getFullYear();
  return `${y}-01-01`;
}
function ytdEnd(year?: number) {
  const y = year ?? new Date().getFullYear();
  return `${y}-12-31`;
}
function todayStr() {
  return new Date().toISOString().split("T")[0];
}

// ─── GET /api/revenue-goal ────────────────────────────────────────────────────
// Returns the company's annual revenue goal + real-time YTD stats
router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const now = new Date();
    const year = now.getFullYear();
    const today = todayStr();
    const start = ytdStart(year);
    const end = ytdEnd(year);

    // Fetch company goal
    const [company] = await db
      .select({ annual_revenue_goal: companiesTable.annual_revenue_goal })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));

    const goalCents = company?.annual_revenue_goal ?? null;

    // Completed revenue YTD (complete jobs scheduled this year)
    const [completedRow] = await db
      .select({ total: sum(jobsTable.base_fee) })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.status, "complete"),
          gte(jobsTable.scheduled_date, start),
          lte(jobsTable.scheduled_date, end),
        )
      );
    const completedRevenue = parseFloat(completedRow?.total ?? "0");

    // Scheduled revenue YTD (future booked jobs: scheduled or in_progress, scheduled_date >= today, still this year)
    const [scheduledRow] = await db
      .select({ total: sum(jobsTable.base_fee) })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          sql`${jobsTable.status} IN ('scheduled','in_progress')`,
          gte(jobsTable.scheduled_date, today),
          lte(jobsTable.scheduled_date, end),
        )
      );
    const scheduledRevenue = parseFloat(scheduledRow?.total ?? "0");

    // Total completed jobs YTD
    const [completedJobsRow] = await db
      .select({ cnt: count() })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.status, "complete"),
          gte(jobsTable.scheduled_date, start),
          lte(jobsTable.scheduled_date, end),
        )
      );
    const completedJobs = Number(completedJobsRow?.cnt ?? 0);

    // Total scheduled jobs (remaining YTD, not yet done)
    const [scheduledJobsRow] = await db
      .select({ cnt: count() })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          sql`${jobsTable.status} IN ('scheduled','in_progress')`,
          gte(jobsTable.scheduled_date, today),
          lte(jobsTable.scheduled_date, end),
        )
      );
    const scheduledJobs = Number(scheduledJobsRow?.cnt ?? 0);

    // New clients this year (created_at YTD)
    const ytdStartDate = new Date(`${year}-01-01T00:00:00.000Z`);
    const [newClientsThisYearRow] = await db
      .select({ cnt: count() })
      .from(clientsTable)
      .where(
        and(
          eq(clientsTable.company_id, companyId),
          gte(clientsTable.created_at, ytdStartDate),
        )
      );
    const newClientsThisYear = Number(newClientsThisYearRow?.cnt ?? 0);

    // New clients same period last year (Jan 1 to today's date, last year)
    const lastYear = year - 1;
    const lastYearStart = new Date(`${lastYear}-01-01T00:00:00.000Z`);
    const lastYearEnd = new Date(`${lastYear}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T23:59:59.000Z`);
    const [newClientsLastYearRow] = await db
      .select({ cnt: count() })
      .from(clientsTable)
      .where(
        and(
          eq(clientsTable.company_id, companyId),
          gte(clientsTable.created_at, lastYearStart),
          lte(clientsTable.created_at, lastYearEnd),
        )
      );
    const newClientsLastYear = Number(newClientsLastYearRow?.cnt ?? 0);

    // Average invoice for completed jobs (YTD)
    const avgInvoice = completedJobs > 0 ? completedRevenue / completedJobs : 0;

    // Projection logic
    const projection = completedRevenue + scheduledRevenue;
    const gap = goalCents != null ? goalCents - projection : null;

    // Required avg invoice to hit goal at current job pace
    // Days elapsed / total days in year = pace factor
    const daysElapsed = Math.floor((now.getTime() - new Date(`${year}-01-01`).getTime()) / 86400000) + 1;
    const daysInYear = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365;
    const paceFactor = daysElapsed / daysInYear;
    const targetJobsYTD = goalCents != null ? Math.round((goalCents / (avgInvoice || 300)) * paceFactor) : null;
    const requiredAvgInvoice =
      goalCents != null && completedJobs + scheduledJobs > 0
        ? Math.max(0, (goalCents - completedRevenue) / (scheduledJobs || 1))
        : null;

    // Status
    let status: "on_track" | "at_risk" | "behind" = "on_track";
    if (goalCents != null && goalCents > 0) {
      const pct = (projection / goalCents) * 100;
      if (pct >= 95) status = "on_track";
      else if (pct >= 85) status = "at_risk";
      else status = "behind";
    }

    return res.json({
      goal: goalCents,
      year,
      completed_revenue: completedRevenue,
      scheduled_revenue: scheduledRevenue,
      projection,
      gap,
      completed_jobs: completedJobs,
      scheduled_jobs: scheduledJobs,
      avg_invoice: avgInvoice,
      required_avg_invoice: requiredAvgInvoice,
      target_jobs_ytd: targetJobsYTD,
      new_clients_this_year: newClientsThisYear,
      new_clients_last_year: newClientsLastYear,
      status,
    });
  } catch (err) {
    console.error("revenue-goal GET error:", err);
    return res.status(500).json({ error: "Failed to load revenue goal data" });
  }
});

// ─── PUT /api/revenue-goal ────────────────────────────────────────────────────
// Set the annual revenue goal for the company
router.put("/", requireAuth, OWNER_ADMIN, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { goal } = req.body;
    if (typeof goal !== "number" || !Number.isInteger(goal) || goal < 0) {
      return res.status(400).json({ error: "goal must be a non-negative integer (in dollars)" });
    }

    await db
      .update(companiesTable)
      .set({ annual_revenue_goal: goal })
      .where(eq(companiesTable.id, companyId));

    return res.json({ ok: true, goal });
  } catch (err) {
    console.error("revenue-goal PUT error:", err);
    return res.status(500).json({ error: "Failed to save revenue goal" });
  }
});

export default router;
