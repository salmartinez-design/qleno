import { Router } from "express";
import { db } from "@workspace/db";
import { satisfactionSurveysTable, jobsTable, clientsTable, usersTable, companiesTable } from "@workspace/db/schema";
import { eq, and, desc, isNotNull, avg, count, sql, gte, isNull } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { captureSurveyScore } from "../lib/scorecard-engine.js";
import { shortenUrl } from "../lib/short-link.js";
import { SURVEY_SMS } from "../lib/sms-copy.js";
import crypto from "crypto";

const router = Router();

// ── POST /api/satisfaction/send — with 30-day throttle ──
router.post("/send", requireAuth, async (req, res) => {
  try {
    // force=true (office "Resend" on Scorecard Results) bypasses the 30-day
    // throttle — an explicit human resend, not an automated repeat ask.
    const { job_id, customer_id, force } = req.body;
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

    if (recent.length > 0 && force !== true) {
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

    // Tenant survey config + customer phone. Twilio creds/number are resolved
    // below via the shared resolveSender() (env-var creds + branch numbers), NOT
    // the companies row — Phes stores them there, so reading the row directly
    // (the old behavior) falsely reported "twilio_unconfigured" for the survey
    // while every other message sent fine.
    const [company] = await db
      .select({
        name: companiesTable.name,
        survey_enabled: companiesTable.survey_enabled,
        survey_message_template: companiesTable.survey_message_template,
      })
      .from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1);
    const [client] = await db
      .select({ phone: clientsTable.phone, first_name: clientsTable.first_name, email: clientsTable.email })
      .from(clientsTable).where(eq(clientsTable.id, parseInt(customer_id))).limit(1);

    // [comms-opt-out] Never survey a client who texted STOP.
    const { isSmsOptedOut } = await import("../lib/opt-out.js");
    const smsOptedOut = client?.phone ? await isSmsOptedOut(companyId, client.phone) : false;

    // [survey-email] Send the survey by EMAIL too, reusing the review_request
    // email template with the TOKENIZED survey link so an email response
    // cascades to the tech scorecard exactly like the SMS path. sendNotification
    // applies its OWN gates — tenant comms, per-client channel preference
    // (prefClientId), and email opt-out — so this honors the customer's
    // which-channel choice. Independent of the Twilio gates below: email still
    // goes out even while SMS/Twilio is disabled. Non-fatal.
    const appBase = (process.env.APP_BASE_URL || "https://app.qleno.com").replace(/\/$/, "");
    const surveyUrl = `${appBase}/survey/${token}`;
    if (client?.email) {
      try {
        const { sendNotification } = await import("../services/notificationService.js");
        await sendNotification(
          "review_request", "email", companyId, client.email, null,
          { first_name: client.first_name || "there", review_link: surveyUrl },
          false, undefined, parseInt(customer_id),
        );
      } catch (e: any) {
        console.error("[satisfaction/send] survey email failed (non-fatal):", e?.message ?? e);
      }
    }
    // [survey-dedupe] Stamp survey_last_sent so the generic review_request cron
    // (notificationService) skips this client for 30 days — the on-completion
    // survey is the single feedback ask, so the customer never gets two emails.
    try {
      await db.execute(sql`UPDATE clients SET survey_last_sent = NOW() WHERE id = ${parseInt(customer_id)} AND company_id = ${companyId}`);
    } catch (e: any) {
      console.error("[satisfaction/send] survey_last_sent stamp failed (non-fatal):", e?.message ?? e);
    }

    // [survey-twilio-fix] Resolve the sender via the shared comms helper so the
    // survey uses the SAME Twilio config as every other message — env-var creds
    // + branch from-numbers. resolveSender's reason already covers the global
    // COMMS gate, per-tenant comms, twilio creds/number. The survey's own master
    // toggle (survey_enabled) gates on top.
    const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
    const sender = await resolveSender(companyId);
    // [survey-pref-gate 2026-07-07] Honor the per-client "Satisfaction Survey"
    // SMS toggle (review_request:sms in the preference grid). The grid offered
    // the switch but this path never consulted it — clients couldn't actually
    // opt out of the survey text. Email already goes through sendNotification,
    // which applies the same gate.
    const { isMessageEnabledForJob } = await import("../lib/notification-preferences.js");
    const smsPrefOn = await isMessageEnabledForJob({ companyId: companyId!, clientId: parseInt(customer_id) }, "review_request", "sms");
    const gate =
      !company?.survey_enabled ? "survey_disabled"
      : sender.reason ? sender.reason
      : !client?.phone ? "no_phone"
      : smsOptedOut ? "sms_opt_out"
      : !smsPrefOn ? "client_pref_off"
      : null;

    if (gate) {
      const [survey] = await db.insert(satisfactionSurveysTable).values({
        company_id: companyId, job_id: parseInt(job_id), customer_id: parseInt(customer_id),
        token, sent_at: new Date(), suppressed: true, suppressed_reason: gate,
      }).returning();
      return res.status(201).json({ sent: false, reason: gate, survey, survey_url: `/survey/${token}` });
    }

    // Clean short link instead of the long hex token URL.
    const link = (await shortenUrl(surveyUrl, companyId)) || surveyUrl;
    const body = (company.survey_message_template || SURVEY_SMS)
      .replace(/\{\{\s*company_name\s*\}\}/g, company.name || "We")
      .replace(/\{\{\s*first_name\s*\}\}/g, client!.first_name || "there")
      .replace(/\{\{\s*survey_link\s*\}\}/g, link);
    try {
      await sendSmsVia(sender, client!.phone!, body);
    } catch (e: any) {
      const [survey] = await db.insert(satisfactionSurveysTable).values({
        company_id: companyId, job_id: parseInt(job_id), customer_id: parseInt(customer_id),
        token, sent_at: new Date(), suppressed: true, suppressed_reason: `twilio_error: ${String(e?.message ?? e).slice(0, 120)}`,
      }).returning();
      return res.status(201).json({ sent: false, reason: "twilio_error", survey, survey_url: link });
    }

    const [survey] = await db.insert(satisfactionSurveysTable).values({
      company_id: companyId, job_id: parseInt(job_id), customer_id: parseInt(customer_id),
      token, sent_at: new Date(),
    }).returning();
    return res.status(201).json({ sent: true, ...survey, survey_url: link });
  } catch (err) {
    console.error("[satisfaction/send]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/satisfaction/respond — PUBLIC, no auth ──
router.post("/respond", async (req, res) => {
  try {
    // survey_score = MaidCentral 0–4 satisfaction (the scorecard input).
    // nps_score/rating still accepted for back-compat with the legacy page.
    const { token, survey_score, nps_score, rating, comment } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    const survey = await db.select().from(satisfactionSurveysTable)
      .where(eq(satisfactionSurveysTable.token, token)).limit(1);

    if (!survey[0]) return res.status(404).json({ error: "Survey not found" });
    if (survey[0].responded_at) return res.status(409).json({ error: "Already responded" });

    const score04 = survey_score != null && Number.isFinite(Number(survey_score))
      ? Math.max(0, Math.min(4, Math.round(Number(survey_score)))) : null;
    // Follow-up when the 0–4 score signals concerns (≤2), or legacy NPS ≤6.
    const follow_up_required = (score04 != null && score04 <= 2) || (nps_score != null && nps_score <= 6);

    const [updated] = await db.update(satisfactionSurveysTable)
      .set({
        survey_score: score04,
        nps_score: nps_score ?? null,
        rating: rating ?? null,
        comment: comment || null,
        responded_at: new Date(),
        follow_up_required,
      })
      .where(eq(satisfactionSurveysTable.token, token))
      .returning();

    // Attribute the 0–4 to the job's tech(s) → scorecard_entries → recompute.
    if (score04 != null && updated.job_id) {
      try {
        const [job] = await db.select({ dt: jobsTable.scheduled_date })
          .from(jobsTable).where(eq(jobsTable.id, updated.job_id)).limit(1);
        const entryDate = job?.dt ? String(job.dt).slice(0, 10) : new Date().toISOString().slice(0, 10);
        await captureSurveyScore({
          companyId: updated.company_id, jobId: updated.job_id, surveyId: updated.id,
          score: score04, entryDate, notes: comment || null,
        });
      } catch (e: any) {
        console.error("[satisfaction/respond] scorecard capture failed (non-fatal):", e?.message ?? e);
      }
    }

    return res.json(updated);
  } catch (err) {
    console.error("[satisfaction/respond]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/satisfaction/comment — PUBLIC, optional note after rating ──
// [seamless] The rating is recorded the instant the customer taps; a written
// note is a no-pressure follow-up. Updates the survey comment AND mirrors it
// onto the tech's scorecard entry so the office sees it next to the score.
router.post("/comment", async (req, res) => {
  try {
    const { token, comment } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });
    const text = (comment ?? "").toString().slice(0, 2000) || null;
    const [updated] = await db.update(satisfactionSurveysTable)
      .set({ comment: text })
      .where(eq(satisfactionSurveysTable.token, token))
      .returning();
    if (!updated) return res.status(404).json({ error: "Survey not found" });
    if (updated.job_id) {
      try {
        await db.execute(sql`
          UPDATE scorecard_entries SET notes = ${text}
           WHERE company_id = ${updated.company_id} AND job_id = ${updated.job_id} AND source = 'qleno'`);
      } catch (e: any) {
        console.error("[satisfaction/comment] scorecard note sync failed (non-fatal):", e?.message ?? e);
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("[satisfaction/comment]", err);
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
        // [review-funnel] Public Google review link (live-only column). Surfaced
        // so the survey thank-you can ask happy raters (3–4) for a Google review.
        google_review_link: sql<string | null>`companies.review_link`,
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
// ── GET /api/satisfaction/scorecard-results — MaidCentral-style report ──
// Per-survey rows over a date range with customer, job, techs, response,
// trend (vs the customer's previous responded score), plus header KPIs.
// Suppressed surveys are excluded (they never reached the customer).
router.get("/scorecard-results", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from)) ? String(req.query.from) : monthAgo;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to)) ? String(req.query.to) : today;
    const branchId = parseInt(String(req.query.branch_id)) || null;

    const result = await db.execute(sql`
      WITH responded AS (
        SELECT id, LAG(survey_score) OVER (PARTITION BY customer_id ORDER BY responded_at) AS prev_score
          FROM satisfaction_surveys
         WHERE company_id = ${companyId} AND responded_at IS NOT NULL AND survey_score IS NOT NULL
      )
      SELECT s.id, s.job_id, s.customer_id, s.sent_at, s.responded_at, s.survey_score,
             s.comment, s.follow_up_required,
             TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS customer_name,
             c.email AS client_email, c.phone AS client_phone,
             j.scheduled_date AS job_date, j.service_type,
             COALESCE(
               (SELECT string_agg(DISTINCT TRIM(COALESCE(tu.first_name,'') || ' ' || COALESCE(tu.last_name,'')), ', ')
                  FROM job_technicians jt JOIN users tu ON tu.id = jt.user_id
                 WHERE jt.job_id = s.job_id),
               TRIM(COALESCE(au.first_name,'') || ' ' || COALESCE(au.last_name,''))
             ) AS techs,
             r.prev_score
        FROM satisfaction_surveys s
        JOIN clients c ON c.id = s.customer_id
        LEFT JOIN jobs j ON j.id = s.job_id
        LEFT JOIN users au ON au.id = j.assigned_user_id
        LEFT JOIN responded r ON r.id = s.id
       WHERE s.company_id = ${companyId}
         AND s.suppressed = false
         AND s.sent_at >= ${from}::date
         AND s.sent_at < (${to}::date + INTERVAL '1 day')
         ${branchId ? sql`AND j.branch_id = ${branchId}` : sql``}
       ORDER BY s.sent_at DESC`);

    const rows = (result.rows as any[]).map(r => ({
      ...r,
      trend: r.prev_score == null || r.survey_score == null ? null
        : r.survey_score > r.prev_score ? "up"
        : r.survey_score < r.prev_score ? "down" : "flat",
    }));
    const returned = rows.filter(r => r.responded_at).length;
    const scored = rows.filter(r => r.survey_score != null);
    return res.json({
      from, to,
      kpis: {
        sent: rows.length,
        returned,
        response_rate: rows.length ? Math.round((returned / rows.length) * 100) : 0,
        avg_score_pct: scored.length
          ? Math.round((scored.reduce((a, r) => a + Number(r.survey_score), 0) / scored.length / 4) * 100)
          : null,
      },
      data: rows,
    });
  } catch (err) {
    console.error("[satisfaction/scorecard-results]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

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
