import { Router } from "express";
import { db } from "@workspace/db";
import { satisfactionSurveysTable, jobsTable, clientsTable, usersTable, companiesTable } from "@workspace/db/schema";
import { eq, and, desc, isNotNull, avg, count, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import crypto from "crypto";

const router = Router();

// POST /api/satisfaction/send — create and queue survey
router.post("/send", requireAuth, async (req, res) => {
  try {
    const { job_id, customer_id } = req.body;
    if (!job_id || !customer_id) return res.status(400).json({ error: "job_id, customer_id required" });

    const token = crypto.randomBytes(24).toString("hex");

    const [survey] = await db.insert(satisfactionSurveysTable).values({
      company_id: req.auth!.companyId,
      job_id,
      customer_id,
      token,
      sent_at: new Date(),
    }).returning();

    return res.status(201).json({ ...survey, survey_url: `/survey/${token}` });
  } catch (err) {
    console.error("[satisfaction/send]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/satisfaction/respond — public, no auth (uses token)
router.post("/respond", async (req, res) => {
  try {
    const { token, nps_score, rating, comment } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    const survey = await db.select().from(satisfactionSurveysTable)
      .where(eq(satisfactionSurveysTable.token, token)).limit(1);

    if (!survey[0]) return res.status(404).json({ error: "Survey not found" });
    if (survey[0].responded_at) return res.status(409).json({ error: "Already responded" });

    const follow_up_required = nps_score != null && nps_score < 7;

    const [updated] = await db.update(satisfactionSurveysTable)
      .set({
        nps_score: nps_score ?? null,
        rating: rating ?? null,
        comment: comment || null,
        responded_at: new Date(),
        follow_up_required,
      })
      .where(eq(satisfactionSurveysTable.token, token))
      .returning();

    return res.json(updated);
  } catch (err) {
    console.error("[satisfaction/respond]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/satisfaction/survey/:token — get survey context for public page
router.get("/survey/:token", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: satisfactionSurveysTable.id,
        responded_at: satisfactionSurveysTable.responded_at,
        company_name: companiesTable.name,
        brand_color: companiesTable.brand_color,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
      })
      .from(satisfactionSurveysTable)
      .leftJoin(companiesTable, eq(companiesTable.id, satisfactionSurveysTable.company_id))
      .leftJoin(clientsTable, eq(clientsTable.id, satisfactionSurveysTable.customer_id))
      .where(eq(satisfactionSurveysTable.token, req.params.token))
      .limit(1);

    if (!rows[0]) return res.status(404).json({ error: "Survey not found" });
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/satisfaction/results — aggregated scores
router.get("/results", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;

    const totals = await db
      .select({
        avg_nps: avg(satisfactionSurveysTable.nps_score),
        avg_rating: avg(satisfactionSurveysTable.rating),
        total_responses: count(),
        follow_up_count: sql<number>`sum(case when ${satisfactionSurveysTable.follow_up_required} then 1 else 0 end)::int`,
      })
      .from(satisfactionSurveysTable)
      .where(
        and(
          eq(satisfactionSurveysTable.company_id, companyId),
          isNotNull(satisfactionSurveysTable.responded_at),
        )
      );

    const followUps = await db
      .select({
        id: satisfactionSurveysTable.id,
        customer_id: satisfactionSurveysTable.customer_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        nps_score: satisfactionSurveysTable.nps_score,
        rating: satisfactionSurveysTable.rating,
        comment: satisfactionSurveysTable.comment,
        responded_at: satisfactionSurveysTable.responded_at,
      })
      .from(satisfactionSurveysTable)
      .leftJoin(clientsTable, eq(clientsTable.id, satisfactionSurveysTable.customer_id))
      .where(
        and(
          eq(satisfactionSurveysTable.company_id, companyId),
          eq(satisfactionSurveysTable.follow_up_required, true),
          isNotNull(satisfactionSurveysTable.responded_at),
        )
      )
      .orderBy(desc(satisfactionSurveysTable.responded_at));

    return res.json({ ...totals[0], follow_ups: followUps });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/satisfaction?customer_id= — per-client history
router.get("/", requireAuth, async (req, res) => {
  try {
    const { customer_id } = req.query;
    const conditions: any[] = [
      eq(satisfactionSurveysTable.company_id, req.auth!.companyId),
      isNotNull(satisfactionSurveysTable.responded_at),
    ];
    if (customer_id) conditions.push(eq(satisfactionSurveysTable.customer_id, parseInt(customer_id as string)));

    const rows = await db.select().from(satisfactionSurveysTable)
      .where(and(...conditions))
      .orderBy(desc(satisfactionSurveysTable.responded_at));
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
