import { Router } from "express";
import { db } from "@workspace/db";
import { techRetentionSnapshotsTable, usersTable, jobsTable, scorecardsTable } from "@workspace/db/schema";
import { eq, and, desc, gte, count, avg, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

function retentionRisk(score: number): "low" | "medium" | "high" | "critical" {
  if (score <= 25) return "low";
  if (score <= 50) return "medium";
  if (score <= 75) return "high";
  return "critical";
}

// POST /api/retention/calculate
router.post("/calculate", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const day30 = new Date(now); day30.setDate(day30.getDate() - 30);
    const day45 = new Date(now); day45.setDate(day45.getDate() - 45);
    const day60 = new Date(now); day60.setDate(day60.getDate() - 60);
    const day90 = new Date(now); day90.setDate(day90.getDate() - 90);
    const fmt = (d: Date) => d.toISOString().split("T")[0];

    const employees = await db.select({ id: usersTable.id, hire_date: usersTable.hire_date })
      .from(usersTable)
      .where(and(eq(usersTable.company_id, companyId), eq(usersTable.is_active, true)));

    let snapped = 0;

    for (const emp of employees) {
      let score = 0;
      const tenure = emp.hire_date
        ? Math.floor((now.getTime() - new Date(emp.hire_date + "T00:00").getTime()) / 86400000)
        : 0;

      if (tenure < 90) score += 20;
      if (tenure > 365) score -= 15;

      // Jobs last 30d
      const jobs30d = await db.select({ cnt: count() }).from(jobsTable)
        .where(and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.assigned_user_id, emp.id),
          eq(jobsTable.status, "complete"),
          sql`${jobsTable.scheduled_date} >= ${fmt(day30)}`,
        ));
      const jobCount = jobs30d[0]?.cnt ?? 0;

      // Rating last 30d
      const ratings30d = await db.select({ avg_r: avg(scorecardsTable.rating) }).from(scorecardsTable)
        .where(and(
          eq(scorecardsTable.company_id, companyId),
          eq(scorecardsTable.employee_id, emp.id),
          sql`${scorecardsTable.created_at} >= ${fmt(day30)}`,
        ));
      const avgRating = parseFloat(ratings30d[0]?.avg_r ?? "0");

      if (avgRating > 0 && avgRating < 3.5) score += 20;
      if (jobCount === 0) score += 15;

      score = Math.max(0, Math.min(100, score));

      await db.delete(techRetentionSnapshotsTable)
        .where(and(
          eq(techRetentionSnapshotsTable.company_id, companyId),
          eq(techRetentionSnapshotsTable.employee_id, emp.id),
          eq(techRetentionSnapshotsTable.snapshot_date, todayStr),
        ));

      await db.insert(techRetentionSnapshotsTable).values({
        company_id: companyId,
        employee_id: emp.id,
        snapshot_date: todayStr,
        tenure_days: tenure,
        jobs_completed_30d: jobCount,
        avg_rating_30d: avgRating > 0 ? String(avgRating) : null,
        cancellations_30d: 0,
        attendance_score: null,
        flight_risk_score: score,
      });

      snapped++;
    }

    return res.json({ snapped });
  } catch (err) {
    console.error("[retention/calculate]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/retention/scores
router.get("/scores", requireAuth, async (req, res) => {
  try {
    const subq = db
      .selectDistinctOn([techRetentionSnapshotsTable.employee_id], {
        employee_id: techRetentionSnapshotsTable.employee_id,
        tenure_days: techRetentionSnapshotsTable.tenure_days,
        jobs_completed_30d: techRetentionSnapshotsTable.jobs_completed_30d,
        avg_rating_30d: techRetentionSnapshotsTable.avg_rating_30d,
        flight_risk_score: techRetentionSnapshotsTable.flight_risk_score,
        snapshot_date: techRetentionSnapshotsTable.snapshot_date,
      })
      .from(techRetentionSnapshotsTable)
      .where(eq(techRetentionSnapshotsTable.company_id, req.auth!.companyId))
      .orderBy(techRetentionSnapshotsTable.employee_id, desc(techRetentionSnapshotsTable.snapshot_date))
      .as("latest");

    const rows = await db
      .select({
        employee_id: subq.employee_id,
        employee_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        avatar_url: usersTable.avatar_url,
        role: usersTable.role,
        hire_date: usersTable.hire_date,
        tenure_days: subq.tenure_days,
        jobs_completed_30d: subq.jobs_completed_30d,
        avg_rating_30d: subq.avg_rating_30d,
        flight_risk_score: subq.flight_risk_score,
        snapshot_date: subq.snapshot_date,
        risk_level: sql<string>`case
          when ${subq.flight_risk_score} <= 25 then 'low'
          when ${subq.flight_risk_score} <= 50 then 'medium'
          when ${subq.flight_risk_score} <= 75 then 'high'
          else 'critical'
        end`,
      })
      .from(subq)
      .innerJoin(usersTable, eq(usersTable.id, subq.employee_id))
      .orderBy(desc(subq.flight_risk_score));

    return res.json(rows);
  } catch (err) {
    console.error("[retention/scores]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/retention/:employee_id
router.get("/:employee_id", requireAuth, async (req, res) => {
  try {
    const rows = await db.select().from(techRetentionSnapshotsTable)
      .where(and(
        eq(techRetentionSnapshotsTable.company_id, req.auth!.companyId),
        eq(techRetentionSnapshotsTable.employee_id, parseInt(req.params.employee_id)),
      ))
      .orderBy(desc(techRetentionSnapshotsTable.snapshot_date))
      .limit(90);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
