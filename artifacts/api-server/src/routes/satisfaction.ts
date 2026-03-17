import { Router } from "express";
import { db } from "@workspace/db";
import { satisfactionSurveysTable, jobsTable, clientsTable, usersTable, companiesTable } from "@workspace/db/schema";
import { eq, and, desc, isNotNull, avg, count, sql, gte, isNull } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import crypto from "crypto";

const router = Router();

// ── POST /api/satisfaction/send — with 30-day throttle ──
router.post("/send", requireAuth, async (req, res) => {
  try {
    const { job_id, customer_id } = req.body;
    if (!job_id || !customer_id) return res.status(400).json({ error: "job_id, customer_id required" });

    const companyId = req.auth!.companyId;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const recent = await db.select({ id: satisfactionSurveysTable.id })
      .from(satisfactionSurveysTable)
      .where(
        and(
          eq(satisfactionSurveysTable.company_id, companyId),
          eq(satisfactionSurveysTable.customer_id, parseInt(customer_id)),
          eq(satisfactionSurveysTable.suppressed, false),
          gte(satisfactionSurveysTable.sent_at, thirtyDaysAgo),
        )
      )
      .limit(1);

    const token = crypto.randomBytes(24).toString("hex");

    if (recent.length > 0) {
      const [survey] = await db.insert(satisfactionSurveysTable).values({
        company_id: companyId,
        job_id: parseInt(job_id),
        customer_id: parseInt(customer_id),
        token,
        sent_at: new Date(),
        suppressed: true,
        suppressed_reason: "throttled — sent within 30 days",
      }).returning();
      return res.json({ sent: false, reason: "throttled", survey });
    }

    const [survey] = await db.insert(satisfactionSurveysTable).values({
      company_id: companyId,
      job_id: parseInt(job_id),
      customer_id: parseInt(customer_id),
      token,
      sent_at: new Date(),
    }).returning();

    return res.status(201).json({ sent: true, ...survey, survey_url: `/survey/${token}` });
  } catch (err) {
    console.error("[satisfaction/send]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/satisfaction/respond — PUBLIC, no auth ──
router.post("/respond", async (req, res) => {
  try {
    const { token, nps_score, rating, comment } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    const survey = await db.select().from(satisfactionSurveysTable)
      .where(eq(satisfactionSurveysTable.token, token)).limit(1);

    if (!survey[0]) return res.status(404).json({ error: "Survey not found" });
    if (survey[0].responded_at) return res.status(409).json({ error: "Already responded" });

    const follow_up_required = nps_score != null && nps_score <= 6;

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

// ── GET /api/satisfaction/survey/:token — PUBLIC ──
router.get("/survey/:token", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: satisfactionSurveysTable.id,
        responded_at: satisfactionSurveysTable.responded_at,
        suppressed: satisfactionSurveysTable.suppressed,
        company_name: companiesTable.name,
        brand_color: companiesTable.brand_color,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        job_id: satisfactionSurveysTable.job_id,
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

// ── GET /api/satisfaction/results — full 30-day rolling stats ──
router.get("/results", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // 30-day sent (non-suppressed)
    const [sentRow] = await db
      .select({ cnt: count() })
      .from(satisfactionSurveysTable)
      .where(
        and(
          eq(satisfactionSurveysTable.company_id, companyId),
          eq(satisfactionSurveysTable.suppressed, false),
          gte(satisfactionSurveysTable.sent_at, thirtyDaysAgo),
        )
      );

    // 30-day responded
    const [respondedRow] = await db
      .select({ cnt: count() })
      .from(satisfactionSurveysTable)
      .where(
        and(
          eq(satisfactionSurveysTable.company_id, companyId),
          eq(satisfactionSurveysTable.suppressed, false),
          gte(satisfactionSurveysTable.sent_at, thirtyDaysAgo),
          isNotNull(satisfactionSurveysTable.responded_at),
        )
      );

    // 30-day NPS stats
    const [stats30] = await db
      .select({
        avg_nps: avg(satisfactionSurveysTable.nps_score),
        avg_rating: avg(satisfactionSurveysTable.rating),
        promoters: sql<number>`sum(case when ${satisfactionSurveysTable.nps_score} >= 9 then 1 else 0 end)::int`,
        detractors: sql<number>`sum(case when ${satisfactionSurveysTable.nps_score} <= 6 then 1 else 0 end)::int`,
        total_with_nps: sql<number>`count(${satisfactionSurveysTable.nps_score})::int`,
        follow_up_count: sql<number>`sum(case when ${satisfactionSurveysTable.follow_up_required} then 1 else 0 end)::int`,
      })
      .from(satisfactionSurveysTable)
      .where(
        and(
          eq(satisfactionSurveysTable.company_id, companyId),
          isNotNull(satisfactionSurveysTable.responded_at),
          gte(satisfactionSurveysTable.sent_at, thirtyDaysAgo),
        )
      );

    const totalWithNps = stats30?.total_with_nps ?? 0;
    const nps_rolling_30d = totalWithNps > 0
      ? Math.round(((stats30.promoters - stats30.detractors) / totalWithNps) * 100)
      : null;

    const sentCount = sentRow?.cnt ?? 0;
    const respondedCount = respondedRow?.cnt ?? 0;
    const response_rate_pct = sentCount > 0 ? Math.round((respondedCount / sentCount) * 100) : 0;

    // NPS by employee (tech assigned to job)
    const nps_by_employee = await db
      .select({
        employee_id: jobsTable.assigned_to,
        name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        avg_rating: sql<number>`round(avg(${satisfactionSurveysTable.rating})::numeric, 1)::float`,
        avg_nps: sql<number>`round(avg(${satisfactionSurveysTable.nps_score})::numeric, 1)::float`,
        response_count: count(),
      })
      .from(satisfactionSurveysTable)
      .leftJoin(jobsTable, eq(jobsTable.id, satisfactionSurveysTable.job_id))
      .leftJoin(usersTable, eq(usersTable.id, jobsTable.assigned_to))
      .where(
        and(
          eq(satisfactionSurveysTable.company_id, companyId),
          isNotNull(satisfactionSurveysTable.responded_at),
          gte(satisfactionSurveysTable.sent_at, thirtyDaysAgo),
        )
      )
      .groupBy(jobsTable.assigned_to, usersTable.first_name, usersTable.last_name)
      .orderBy(sql`avg(${satisfactionSurveysTable.rating}) desc`);

    // Follow-up queue
    const follow_ups = await db
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

    // All surveys for history table
    const history = await db
      .select({
        id: satisfactionSurveysTable.id,
        customer_id: satisfactionSurveysTable.customer_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        job_id: satisfactionSurveysTable.job_id,
        sent_at: satisfactionSurveysTable.sent_at,
        responded_at: satisfactionSurveysTable.responded_at,
        nps_score: satisfactionSurveysTable.nps_score,
        rating: satisfactionSurveysTable.rating,
        suppressed: satisfactionSurveysTable.suppressed,
        suppressed_reason: satisfactionSurveysTable.suppressed_reason,
      })
      .from(satisfactionSurveysTable)
      .leftJoin(clientsTable, eq(clientsTable.id, satisfactionSurveysTable.customer_id))
      .where(eq(satisfactionSurveysTable.company_id, companyId))
      .orderBy(desc(satisfactionSurveysTable.sent_at))
      .limit(100);

    return res.json({
      nps_rolling_30d,
      avg_rating_30d: stats30?.avg_rating ? parseFloat(stats30.avg_rating as any) : null,
      surveys_sent_30d: sentCount,
      surveys_responded_30d: respondedCount,
      response_rate_pct,
      follow_up_queue_count: stats30?.follow_up_count ?? 0,
      nps_by_employee,
      benchmark: {
        residential: { low: 38, high: 52 },
        commercial: { low: 28, high: 44 },
      },
      follow_ups,
      history,
    });
  } catch (err) {
    console.error("[satisfaction/results]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── GET /api/satisfaction?customer_id= ──
router.get("/", requireAuth, async (req, res) => {
  try {
    const { customer_id } = req.query;
    const conditions: any[] = [
      eq(satisfactionSurveysTable.company_id, req.auth!.companyId),
    ];
    if (customer_id) conditions.push(eq(satisfactionSurveysTable.customer_id, parseInt(customer_id as string)));

    const rows = await db.select().from(satisfactionSurveysTable)
      .where(and(...conditions))
      .orderBy(desc(satisfactionSurveysTable.sent_at));
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
