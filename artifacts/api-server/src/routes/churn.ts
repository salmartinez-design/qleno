import { Router } from "express";
import { db } from "@workspace/db";
import {
  churnScoresTable, clientsTable, jobsTable, invoicesTable,
  cancellationLogTable, satisfactionSurveysTable, communicationLogTable,
} from "@workspace/db/schema";
import { eq, and, desc, gte, sql, count } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

function riskLevel(score: number): "low" | "medium" | "high" | "critical" {
  if (score <= 25) return "low";
  if (score <= 50) return "medium";
  if (score <= 75) return "high";
  return "critical";
}

// POST /api/churn/calculate — score all active customers
router.post("/calculate", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const now = new Date();
    const day60 = new Date(now); day60.setDate(day60.getDate() - 60);
    const day90 = new Date(now); day90.setDate(day90.getDate() - 90);
    const day14 = new Date(now); day14.setDate(day14.getDate() - 14);
    const fmt = (d: Date) => d.toISOString().split("T")[0];

    const clients = await db.select({ id: clientsTable.id, client_since: clientsTable.client_since })
      .from(clientsTable)
      .where(and(eq(clientsTable.company_id, companyId), eq(clientsTable.is_active, true)));

    let scored = 0;

    for (const c of clients) {
      const signals: Record<string, any> = {};
      let score = 0;

      // Last job
      const lastJob = await db.select({ status: jobsTable.status, scheduled_date: jobsTable.scheduled_date })
        .from(jobsTable)
        .where(and(eq(jobsTable.company_id, companyId), eq(jobsTable.client_id, c.id)))
        .orderBy(desc(jobsTable.scheduled_date)).limit(1);

      if (lastJob[0]?.status === "cancelled") {
        score += 15; signals.last_job_cancelled = true;
      }

      // 2+ cancellations in last 60 days
      const recentCancels = await db.select({ cnt: count() }).from(cancellationLogTable)
        .where(and(
          eq(cancellationLogTable.company_id, companyId),
          eq(cancellationLogTable.customer_id, c.id),
          sql`${cancellationLogTable.cancelled_at} >= ${fmt(day60)}`,
        ));
      if ((recentCancels[0]?.cnt ?? 0) >= 2) {
        score += 20; signals.cancellations_60d = recentCancels[0].cnt;
      }

      // Invoice overdue > 14 days
      const overdueInvoice = await db.select({ id: invoicesTable.id }).from(invoicesTable)
        .where(and(
          eq(invoicesTable.company_id, companyId),
          eq(invoicesTable.client_id, c.id),
          eq(invoicesTable.status, "sent"),
          sql`${invoicesTable.due_date} <= ${fmt(day14)}`,
        )).limit(1);
      if (overdueInvoice.length > 0) {
        score += 10; signals.invoice_overdue = true;
      }

      // NPS detractor (0-6) — from latest survey
      const latestSurvey = await db.select({ nps_score: satisfactionSurveysTable.nps_score })
        .from(satisfactionSurveysTable)
        .where(and(
          eq(satisfactionSurveysTable.company_id, companyId),
          eq(satisfactionSurveysTable.customer_id, c.id),
          sql`${satisfactionSurveysTable.responded_at} is not null`,
        ))
        .orderBy(desc(satisfactionSurveysTable.responded_at)).limit(1);

      const nps = latestSurvey[0]?.nps_score;
      if (nps != null && nps <= 6) { score += 20; signals.nps_detractor = nps; }
      if (nps != null && nps >= 9) { score -= 10; signals.nps_promoter = nps; }

      // No communication in 60+ days
      const lastComm = await db.select({ logged_at: communicationLogTable.logged_at })
        .from(communicationLogTable)
        .where(and(
          eq(communicationLogTable.company_id, companyId),
          eq(communicationLogTable.customer_id, c.id),
        ))
        .orderBy(desc(communicationLogTable.logged_at)).limit(1);

      if (!lastComm[0] || new Date(lastComm[0].logged_at) < day60) {
        score += 10; signals.no_comm_60d = true;
      }

      // New client < 90 days
      if (c.client_since) {
        const since = new Date(c.client_since + "T00:00");
        if (since >= day90) { score += 10; signals.new_client = true; }
      }

      score = Math.max(0, Math.min(100, score));

      await db.insert(churnScoresTable)
        .values({ company_id: companyId, customer_id: c.id, score, risk_level: riskLevel(score), signals, calculated_at: new Date() })
        .onConflictDoNothing();

      // Upsert by deleting old and inserting new (simple approach)
      await db.delete(churnScoresTable).where(and(eq(churnScoresTable.company_id, companyId), eq(churnScoresTable.customer_id, c.id)));
      await db.insert(churnScoresTable).values({ company_id: companyId, customer_id: c.id, score, risk_level: riskLevel(score), signals, calculated_at: new Date() });

      scored++;
    }

    return res.json({ scored });
  } catch (err) {
    console.error("[churn/calculate]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/churn/scores
router.get("/scores", requireAuth, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: churnScoresTable.id,
        customer_id: churnScoresTable.customer_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        email: clientsTable.email,
        phone: clientsTable.phone,
        score: churnScoresTable.score,
        risk_level: churnScoresTable.risk_level,
        signals: churnScoresTable.signals,
        calculated_at: churnScoresTable.calculated_at,
      })
      .from(churnScoresTable)
      .leftJoin(clientsTable, eq(clientsTable.id, churnScoresTable.customer_id))
      .where(eq(churnScoresTable.company_id, req.auth!.companyId))
      .orderBy(desc(churnScoresTable.score));
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/churn/scores/:customer_id
router.get("/scores/:customer_id", requireAuth, async (req, res) => {
  try {
    const rows = await db.select().from(churnScoresTable)
      .where(and(
        eq(churnScoresTable.company_id, req.auth!.companyId),
        eq(churnScoresTable.customer_id, parseInt(req.params.customer_id)),
      )).limit(1);
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
