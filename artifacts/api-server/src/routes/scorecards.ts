import { Router } from "express";
import { db } from "@workspace/db";
import { scorecardsTable, scorecardEntriesTable, usersTable, clientsTable } from "@workspace/db/schema";
import { eq, and, avg, count, desc, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { resolveWindow } from "../lib/report-periods.js";
import { recomputeAllScorecards, recomputeEmployeeScorecard } from "../lib/scorecard-engine.js";
import { computeCompositeForEmployee, recomputeAllComposites, recomputeCompositeScore } from "../lib/scorecard-composite.js";

const router = Router();

// GET /api/scorecards/report — time-bucketed scorecard over a window.
//   ?scope=employee|company &period=rolling_90d|month|quarter|year|custom
//   &date= (anchor) &from=&to= (custom) &employee_id= (employee scope)
// MC formula: score % = unweighted MEAN of non-excluded 0–4 responses ÷ max ×100.
// Company = unweighted mean of ALL responses (entry-level — NOT avg of tech
// averages). Computed from live source='qleno' dated entries.
router.get("/report", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const scope = req.query.scope === "company" ? "company" : "employee";
    const win = resolveWindow(String(req.query.period ?? "rolling_90d"), {
      anchor: req.query.date, from: req.query.from, to: req.query.to,
    });
    // Column-qualified WHERE so the company byTech JOIN (users also has
    // company_id) isn't ambiguous. `a` is a literal alias prefix we control.
    const cond = (a: string) => sql`${sql.raw(a)}source = 'qleno' AND ${sql.raw(a)}excluded = false
      AND ${sql.raw(a)}dismissed_at IS NULL
      AND ${sql.raw(a)}company_id = ${companyId}
      AND ${sql.raw(a)}entry_date >= ${win.from} AND ${sql.raw(a)}entry_date <= ${win.to}`;

    if (scope === "employee") {
      const employeeId = parseInt(String(req.query.employee_id ?? ""));
      if (isNaN(employeeId)) return res.status(400).json({ error: "employee_id required for scope=employee" });
      const r = await db.execute(sql`
        SELECT ROUND(AVG(score_value / NULLIF(max_value, 0)) * 100, 2) AS score_pct, COUNT(*)::int AS responses
          FROM scorecard_entries WHERE ${cond("")} AND employee_id = ${employeeId}`);
      const row: any = r.rows[0] ?? {};
      // [90d-composite] Persisted composite columns so the report can show the
      // displayed headline next to the satisfaction-only score_pct.
      const cr = await db.execute(sql`
        SELECT scorecard_composite_90d, score_satisfaction_90d, score_attendance_90d, score_complaint_free_90d
          FROM users WHERE id = ${employeeId} AND company_id = ${companyId} LIMIT 1`);
      const c: any = cr.rows[0] ?? {};
      return res.json({
        scope, employee_id: employeeId, window: win,
        score_pct: row.score_pct != null ? parseFloat(row.score_pct) : null,
        responses: Number(row.responses ?? 0),
        composite_pct: c.scorecard_composite_90d != null ? parseFloat(c.scorecard_composite_90d) : null,
        satisfaction_pct: c.score_satisfaction_90d != null ? parseFloat(c.score_satisfaction_90d) : null,
        attendance_pct: c.score_attendance_90d != null ? parseFloat(c.score_attendance_90d) : null,
        complaint_free_pct: c.score_complaint_free_90d != null ? parseFloat(c.score_complaint_free_90d) : null,
      });
    }

    // Company: overall (unweighted mean of all responses) + per-tech breakdown.
    const overall = await db.execute(sql`
      SELECT ROUND(AVG(score_value / NULLIF(max_value, 0)) * 100, 2) AS score_pct, COUNT(*)::int AS responses
        FROM scorecard_entries WHERE ${cond("")}`);
    const byTech = await db.execute(sql`
      SELECT e.employee_id, (u.first_name || ' ' || u.last_name) AS name,
             ROUND(AVG(e.score_value / NULLIF(e.max_value, 0)) * 100, 2) AS score_pct, COUNT(*)::int AS responses,
             u.scorecard_composite_90d AS composite_pct
        FROM scorecard_entries e LEFT JOIN users u ON u.id = e.employee_id
       WHERE ${cond("e.")} GROUP BY e.employee_id, u.first_name, u.last_name, u.scorecard_composite_90d
       ORDER BY score_pct DESC NULLS LAST`);
    const o: any = overall.rows[0] ?? {};
    return res.json({
      scope: "company", window: win,
      score_pct: o.score_pct != null ? parseFloat(o.score_pct) : null,
      responses: Number(o.responses ?? 0),
      employees: (byTech.rows as any[]).map(r => ({ employee_id: r.employee_id, name: r.name, score_pct: r.score_pct != null ? parseFloat(r.score_pct) : null, responses: Number(r.responses), composite_pct: r.composite_pct != null ? parseFloat(r.composite_pct) : null })),
    });
  } catch (err) {
    console.error("Scorecard report error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to build scorecard report" });
  }
});

// GET /api/scorecards/company-report — the consolidated company-wide Scorecard
// Report powering /reports/scorecard-report. One payload for the whole page:
// KPI row, composite breakdown (60/25/15), weekly trend, per-tech table, by-branch
// + by-channel tables, score distribution, efficiency, and the verbatim comment
// feed. Owner/admin/office only (techs never see this report — 403).
//   ?from=&to=  (or ?period=rolling_90d|month|quarter|year)  &branch_id=
// Two time bases coexist, matching the design:
//  • WINDOW (the selected period) governs surveys, trend, distribution, comments,
//    efficiency, and the per-tech Responses / response-rate columns.
//  • COMPOSITE is the trailing-90-day standing read from the persisted per-tech
//    score_*_90d columns (nightly cron); company sub-scores = mean of the
//    non-null per-tech values, blended with the tenant 60/25/15 weights.
// All queries are company_id-scoped. branch_id (when set) filters the
// survey/entry/window metrics via jobs.branch_id; the composite columns and the
// by-branch breakdown are always company-wide.
router.get("/company-report", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const win = resolveWindow(String(req.query.period ?? "custom"), {
      anchor: req.query.date, from: req.query.from, to: req.query.to,
    });
    const branchId = Number.isFinite(Number(req.query.branch_id)) && req.query.branch_id
      ? parseInt(String(req.query.branch_id)) : null;
    // Reusable branch predicate against an already-joined `jobs j`.
    const bj = branchId ? sql`AND j.branch_id = ${branchId}` : sql``;
    // Window predicate on satisfaction_surveys.sent_at (inclusive of the whole `to` day).
    const sentWin = sql`s.sent_at >= ${win.from}::date AND s.sent_at < (${win.to}::date + INTERVAL '1 day')`;
    const num = (v: any) => (v == null ? null : parseFloat(v));
    const int = (v: any) => Number(v ?? 0);

    // Tenant composite weights (60/25/15 default).
    const wRow = await db.execute(sql`
      SELECT COALESCE(score_weight_satisfaction, 60) AS s, COALESCE(score_weight_attendance, 25) AS a,
             COALESCE(score_weight_complaint_free, 15) AS c FROM companies WHERE id = ${companyId} LIMIT 1`);
    const weights = {
      satisfaction: int((wRow.rows[0] as any)?.s ?? 60),
      attendance: int((wRow.rows[0] as any)?.a ?? 25),
      complaint_free: int((wRow.rows[0] as any)?.c ?? 15),
    };
    const blend = (sat: number | null, att: number | null, cf: number | null): number | null => {
      const parts: Array<{ v: number; w: number }> = [];
      if (sat != null) parts.push({ v: sat, w: weights.satisfaction });
      if (att != null) parts.push({ v: att, w: weights.attendance });
      if (cf != null) parts.push({ v: cf, w: weights.complaint_free });
      const tw = parts.reduce((a, p) => a + p.w, 0);
      // Satisfaction is required for a meaningful composite (mirrors scorecard-composite.ts).
      return sat != null && parts.length && tw > 0
        ? Math.round((parts.reduce((a, p) => a + p.v * p.w, 0) / tw) * 100) / 100 : null;
    };

    // ── Per-tech persisted composite columns (trailing-90d standing) ──
    // [roster 2026-08-11] This listed EVERY technician row the company has ever
    // had — no is_active check at all — so terminated staff kept appearing on a
    // live performance report (Sal: Norma Puga, Juan Salazar, Anissa Bello). It
    // also had no show_on_dispatch check, which is why the "Trainee Placeholder"
    // QA account sat near the top of the rankings. Both predicates now match the
    // dispatch board's canonical roster filter (routes/dispatch.ts) so the two
    // surfaces agree on who counts as staff. IS NOT FALSE keeps legacy rows
    // (pre-migration NULL) visible.
    //
    // 'trainee' added to the role list to match recomputeAllComposites
    // (lib/scorecard-composite.ts), which has always COMPUTED a composite for
    // trainees — this report just never displayed them. Trainee is a real role
    // with technician-equivalent work, so it belongs here.
    //
    // Deliberately NOT branch-filtered: the dispatch rail doesn't filter techs by
    // home_branch_id either, and a tech who covered the other branch this period
    // would silently vanish. The branch toggle still scopes the survey and
    // efficiency numbers via the job join.
    const techRows = await db.execute(sql`
      SELECT id AS user_id, TRIM(first_name || ' ' || COALESCE(last_name, '')) AS name,
             scorecard_composite_90d AS composite, score_satisfaction_90d AS sat,
             score_attendance_90d AS att, score_complaint_free_90d AS cf
        FROM users
       WHERE company_id = ${companyId}
         AND role IN ('technician', 'trainee', 'team_lead')
         AND is_active = true
         AND show_on_dispatch IS NOT FALSE`);

    // ── Per-tech window survey counts (attributed to the job's primary tech) ──
    const techSurvey = await db.execute(sql`
      SELECT j.assigned_user_id AS user_id,
             COUNT(*)::int AS sent,
             COUNT(*) FILTER (WHERE s.responded_at IS NOT NULL)::int AS responses
        FROM satisfaction_surveys s
        JOIN jobs j ON j.id = s.job_id AND j.company_id = s.company_id
       WHERE s.company_id = ${companyId} AND s.suppressed = false AND ${sentWin}
         AND j.assigned_user_id IS NOT NULL ${bj}
       GROUP BY j.assigned_user_id`);
    const surveyByTech = new Map<number, { sent: number; responses: number }>();
    for (const r of techSurvey.rows as any[]) surveyByTech.set(int(r.user_id), { sent: int(r.sent), responses: int(r.responses) });

    // ── Per-tech window efficiency (Allowed ÷ Actual job hours — canonical) ──
    const techEff = await db.execute(sql`
      SELECT employee_id AS user_id,
             ROUND(100 * SUM(allowed_share) / NULLIF(SUM(actual_hours), 0), 2) AS efficiency_pct
        FROM efficiency_entries
       WHERE company_id = ${companyId} AND source = 'qleno'
         AND entry_date >= ${win.from} AND entry_date <= ${win.to}
       GROUP BY employee_id`);
    const effByTech = new Map<number, number | null>();
    for (const r of techEff.rows as any[]) effByTech.set(int(r.user_id), num(r.efficiency_pct));

    const technicians = (techRows.rows as any[])
      .map(r => {
        const sv = surveyByTech.get(int(r.user_id)) ?? { sent: 0, responses: 0 };
        return {
          user_id: int(r.user_id), name: r.name || "—",
          composite_pct: num(r.composite), satisfaction_pct: num(r.sat),
          attendance_pct: num(r.att), complaint_free_pct: num(r.cf),
          responses: sv.responses,
          response_rate_pct: sv.sent > 0 ? Math.round((sv.responses / sv.sent) * 100) : null,
          efficiency_pct: effByTech.get(int(r.user_id)) ?? null,
        };
      })
      .filter(t => t.composite_pct != null || t.responses > 0 || t.efficiency_pct != null)
      .sort((a, b) => (b.composite_pct ?? -1) - (a.composite_pct ?? -1));

    // Company sub-scores = mean of the non-null per-tech persisted values.
    const meanOf = (key: "satisfaction_pct" | "attendance_pct" | "complaint_free_pct"): number | null => {
      const vals = technicians.map(t => t[key]).filter((v): v is number => v != null);
      return vals.length ? Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 100) / 100 : null;
    };
    const coSat = meanOf("satisfaction_pct"), coAtt = meanOf("attendance_pct"), coCf = meanOf("complaint_free_pct");
    const coComposite = blend(coSat, coAtt, coCf);

    // ── Company window KPIs from satisfaction_surveys ──
    const kpiRow = await db.execute(sql`
      SELECT COUNT(*)::int AS sent,
             COUNT(*) FILTER (WHERE s.responded_at IS NOT NULL)::int AS returned,
             COUNT(*) FILTER (WHERE s.follow_up_required = true AND s.responded_at IS NOT NULL)::int AS follow_ups,
             ROUND(AVG(s.survey_score) FILTER (WHERE s.survey_score IS NOT NULL)::numeric, 2) AS avg_score
        FROM satisfaction_surveys s
        LEFT JOIN jobs j ON j.id = s.job_id AND j.company_id = s.company_id
       WHERE s.company_id = ${companyId} AND s.suppressed = false AND ${sentWin} ${bj}`);
    const k: any = kpiRow.rows[0] ?? {};
    const sent = int(k.sent), returned = int(k.returned);
    const avgScore = num(k.avg_score);

    // Dismissed ratings in the window (surfaced separately from scored aggregates).
    const dismissRow = await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM scorecard_entries e
        LEFT JOIN jobs j ON j.id = e.job_id AND j.company_id = e.company_id
       WHERE e.company_id = ${companyId} AND e.dismissed_at IS NOT NULL
         AND e.entry_date >= ${win.from} AND e.entry_date <= ${win.to} ${bj}`);
    const dismissedCount = int((dismissRow.rows[0] as any)?.n);

    // ── By branch (Oak Lawn / Schaumburg) — always company-wide breakdown ──
    const branchRows = await db.execute(sql`
      SELECT b.name AS branch,
             ROUND(AVG(s.survey_score) FILTER (WHERE s.survey_score IS NOT NULL) / 4.0 * 100) AS satisfaction_pct,
             ROUND(100.0 * COUNT(*) FILTER (WHERE s.responded_at IS NOT NULL) / NULLIF(COUNT(*), 0)) AS response_rate_pct,
             COUNT(*)::int AS surveys
        FROM satisfaction_surveys s
        JOIN jobs j ON j.id = s.job_id AND j.company_id = s.company_id
        JOIN branches b ON b.id = j.branch_id AND b.company_id = s.company_id
       WHERE s.company_id = ${companyId} AND s.suppressed = false AND ${sentWin}
       GROUP BY b.name ORDER BY b.name`);

    // ── By channel — INFERRED from the customer's contact info (no channel is
    // stored on the survey). phone → SMS, else email → Email. Labeled inferred. ──
    const channelRows = await db.execute(sql`
      SELECT CASE WHEN c.phone IS NOT NULL AND c.phone <> '' THEN 'SMS'
                  WHEN c.email IS NOT NULL AND c.email <> '' THEN 'Email'
                  ELSE 'Unknown' END AS channel,
             COUNT(*)::int AS sent,
             COUNT(*) FILTER (WHERE s.responded_at IS NOT NULL)::int AS returned
        FROM satisfaction_surveys s
        JOIN clients c ON c.id = s.customer_id AND c.company_id = s.company_id
        LEFT JOIN jobs j ON j.id = s.job_id AND j.company_id = s.company_id
       WHERE s.company_id = ${companyId} AND s.suppressed = false AND ${sentWin} ${bj}
       GROUP BY 1 ORDER BY sent DESC`);

    // ── Score distribution 0..4 (responded surveys in window) ──
    const distRows = await db.execute(sql`
      SELECT s.survey_score AS score, COUNT(*)::int AS count
        FROM satisfaction_surveys s
        LEFT JOIN jobs j ON j.id = s.job_id AND j.company_id = s.company_id
       WHERE s.company_id = ${companyId} AND s.responded_at IS NOT NULL
         AND s.survey_score IS NOT NULL AND ${sentWin} ${bj}
       GROUP BY s.survey_score`);
    const distMap = new Map<number, number>();
    for (const r of distRows.rows as any[]) distMap.set(int(r.score), int(r.count));
    const distribution = [0, 1, 2, 3, 4].map(score => ({ score, count: distMap.get(score) ?? 0 }));

    // ── By job type & cadence (the cut Sal called out) ──
    // A job is RECURRING when it has a recurring-schedule link, a real cadence
    // (frequency <> on_demand), or a recurring service slug; else one-time. The
    // summary (by_work_type) is the 2-row One-time vs Recurring split; the detail
    // (by_job_type) buckets one-time work by service_type (Move In/Out and the
    // commercial slugs collapsed to single labels) and recurring work by cadence.
    const recurringExpr = sql`(j.recurring_schedule_id IS NOT NULL
        OR j.frequency::text <> 'on_demand'
        OR j.service_type::text IN ('recurring', 'recurring_commercial_cleaning'))`;
    const rowMetrics = sql`
      COUNT(*)::int AS sent,
      COUNT(*) FILTER (WHERE s.responded_at IS NOT NULL)::int AS returned,
      ROUND(100.0 * COUNT(*) FILTER (WHERE s.responded_at IS NOT NULL) / NULLIF(COUNT(*), 0)) AS response_rate_pct,
      ROUND(AVG(s.survey_score) FILTER (WHERE s.survey_score IS NOT NULL)::numeric, 2) AS avg_score`;
    const workTypeRows = await db.execute(sql`
      SELECT CASE WHEN ${recurringExpr} THEN 'Recurring' ELSE 'One-time' END AS type, ${rowMetrics}
        FROM satisfaction_surveys s
        JOIN jobs j ON j.id = s.job_id AND j.company_id = s.company_id
       WHERE s.company_id = ${companyId} AND s.suppressed = false AND ${sentWin} ${bj}
       GROUP BY 1 ORDER BY 1`);
    const jobTypeRows = await db.execute(sql`
      SELECT CASE
               WHEN ${recurringExpr} THEN 'Recurring · ' || CASE WHEN j.frequency::text = 'on_demand'
                    THEN 'Other' ELSE INITCAP(REPLACE(j.frequency::text, '_', ' ')) END
               WHEN j.service_type::text IN ('move_in', 'move_out') THEN 'Move In/Out'
               WHEN j.service_type::text IN ('commercial_cleaning', 'office_cleaning', 'common_areas',
                    'retail_store', 'medical_office', 'ppm_turnover', 'ppm_common_areas', 'post_event') THEN 'Commercial'
               ELSE INITCAP(REPLACE(j.service_type::text, '_', ' '))
             END AS type, ${rowMetrics}
        FROM satisfaction_surveys s
        JOIN jobs j ON j.id = s.job_id AND j.company_id = s.company_id
       WHERE s.company_id = ${companyId} AND s.suppressed = false AND ${sentWin} ${bj}
       GROUP BY 1 ORDER BY sent DESC`);
    const shapeType = (rows: any[]) => rows.map(r => ({
      type: r.type, sent: int(r.sent), returned: int(r.returned),
      response_rate_pct: num(r.response_rate_pct) ?? 0, avg_score: num(r.avg_score),
    }));

    // ── Weekly trend: satisfaction% + response-rate% across the window ──
    const trendRows = await db.execute(sql`
      SELECT to_char(date_trunc('week', s.sent_at), 'YYYY-MM-DD') AS week_start,
             ROUND(AVG(s.survey_score) FILTER (WHERE s.survey_score IS NOT NULL) / 4.0 * 100) AS satisfaction_pct,
             ROUND(100.0 * COUNT(*) FILTER (WHERE s.responded_at IS NOT NULL) / NULLIF(COUNT(*), 0)) AS response_rate_pct
        FROM satisfaction_surveys s
        LEFT JOIN jobs j ON j.id = s.job_id AND j.company_id = s.company_id
       WHERE s.company_id = ${companyId} AND s.suppressed = false AND ${sentWin} ${bj}
       GROUP BY 1 ORDER BY 1`);

    // ── Efficiency by package (canonical Allowed ÷ Actual) ──
    const effRows = await db.execute(sql`
      SELECT package,
             ROUND(100 * SUM(allowed_share) / NULLIF(SUM(actual_hours), 0), 2) AS efficiency_pct,
             SUM(allowed_share)::numeric AS allowed, SUM(actual_hours)::numeric AS actual,
             COUNT(*)::int AS jobs, COUNT(DISTINCT employee_id)::int AS techs
        FROM efficiency_entries
       WHERE company_id = ${companyId} AND source = 'qleno'
         AND entry_date >= ${win.from} AND entry_date <= ${win.to}
       GROUP BY package ORDER BY efficiency_pct DESC NULLS LAST`);
    const effAllowed = (effRows.rows as any[]).reduce((a, r) => a + parseFloat(r.allowed || 0), 0);
    const effActual = (effRows.rows as any[]).reduce((a, r) => a + parseFloat(r.actual || 0), 0);
    const efficiency = {
      overall_pct: effActual > 0 ? Math.round((100 * effAllowed / effActual) * 100) / 100 : null,
      packages: (effRows.rows as any[]).map(r => ({
        package: r.package, efficiency_pct: num(r.efficiency_pct), jobs: int(r.jobs), techs: int(r.techs),
      })),
    };

    // ── Verbatim comment feed — recent scored entries carrying a comment ──
    const commentRows = await db.execute(sql`
      SELECT e.id, e.job_id, e.employee_id, e.score_value AS score, e.max_value AS max,
             e.notes AS comment, e.office_reply, e.dismissed_at, e.entry_date,
             TRIM(tu.first_name || ' ' || COALESCE(tu.last_name, '')) AS tech,
             cl.id AS customer_id, TRIM(cl.first_name || ' ' || COALESCE(cl.last_name, '')) AS customer,
             COALESCE(ss.follow_up_required, false) AS follow_up_required
        FROM scorecard_entries e
        LEFT JOIN users tu ON tu.id = e.employee_id AND tu.company_id = e.company_id
        LEFT JOIN jobs j ON j.id = e.job_id AND j.company_id = e.company_id
        LEFT JOIN clients cl ON cl.id = j.client_id AND cl.company_id = e.company_id
        LEFT JOIN satisfaction_surveys ss ON ss.id = e.survey_id AND ss.company_id = e.company_id
       WHERE e.company_id = ${companyId}
         AND e.entry_date >= ${win.from} AND e.entry_date <= ${win.to}
         AND e.notes IS NOT NULL AND TRIM(e.notes) <> '' ${bj}
       ORDER BY e.entry_date DESC, e.id DESC
       LIMIT 30`);
    const comments = (commentRows.rows as any[]).map(r => ({
      id: int(r.id), job_id: r.job_id != null ? int(r.job_id) : null,
      customer: r.customer || "—", customer_id: r.customer_id != null ? int(r.customer_id) : null,
      tech: r.tech || "—", score: num(r.score), max: num(r.max) ?? 4,
      comment: r.comment || "", follow_up_required: r.follow_up_required === true,
      office_reply: r.office_reply || null, dismissed_at: r.dismissed_at ?? null,
    }));

    return res.json({
      window: win,
      composite_window_days: 90,
      weights,
      branch_id: branchId,
      kpis: {
        composite_pct: coComposite,
        satisfaction_pct: coSat,
        avg_score: avgScore,
        surveys_sent: sent,
        surveys_returned: returned,
        response_rate_pct: sent > 0 ? Math.round((returned / sent) * 100) : 0,
        follow_ups_flagged: int(k.follow_ups),
        dismissed_count: dismissedCount,
        efficiency_pct: efficiency.overall_pct,
      },
      composite: {
        composite_pct: coComposite, satisfaction_pct: coSat,
        attendance_pct: coAtt, complaint_free_pct: coCf, weights,
      },
      technicians,
      company_totals: {
        composite_pct: coComposite, satisfaction_pct: coSat, attendance_pct: coAtt,
        complaint_free_pct: coCf, responses: returned,
        response_rate_pct: sent > 0 ? Math.round((returned / sent) * 100) : 0,
      },
      by_branch: (branchRows.rows as any[]).map(r => ({
        branch: r.branch, satisfaction_pct: num(r.satisfaction_pct),
        response_rate_pct: num(r.response_rate_pct), surveys: int(r.surveys),
      })),
      by_channel: (channelRows.rows as any[]).map(r => ({
        channel: r.channel, sent: int(r.sent), returned: int(r.returned),
        response_rate_pct: int(r.sent) > 0 ? Math.round((int(r.returned) / int(r.sent)) * 100) : 0,
      })),
      by_work_type: shapeType(workTypeRows.rows as any[]),
      by_job_type: shapeType(jobTypeRows.rows as any[]),
      distribution,
      trend: (trendRows.rows as any[]).map(r => ({
        week_start: r.week_start, satisfaction_pct: num(r.satisfaction_pct),
        response_rate_pct: num(r.response_rate_pct),
      })),
      efficiency,
      comments,
    });
  } catch (err) {
    console.error("Scorecard company-report error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to build scorecard company report" });
  }
});

// PATCH /api/scorecards/entries/:id/exclude { excluded } — office "Exclude from
// employee" action; recomputes the affected tech's headline.
router.patch("/entries/:id/exclude", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const excluded = req.body?.excluded !== false;
    const [row] = await db.update(scorecardEntriesTable)
      .set({ excluded })
      .where(and(eq(scorecardEntriesTable.id, id), eq(scorecardEntriesTable.company_id, companyId)))
      .returning({ employee_id: scorecardEntriesTable.employee_id });
    if (!row) return res.status(404).json({ error: "Entry not found" });
    await recomputeEmployeeScorecard(companyId, row.employee_id);
    return res.json({ ok: true, excluded, employee_id: row.employee_id });
  } catch (err) {
    console.error("Scorecard exclude error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to update entry" });
  }
});

// POST /api/scorecards/entries/:id/dismiss { reason } — owner/office "Dismiss
// erroneous rating" action. Soft-voids a scorecard_entries row: it stays in the
// history (shown muted / struck-through) but drops out of the Customer
// Satisfaction average AND the survey count feeding the rolling composite, so
// the tech's Performance Score lifts immediately. A non-empty `reason` is
// REQUIRED. The who/when/job#/rating/reason are logged to the CUSTOMER's audit
// trail (communication_log, channel='note') so the void is visible on the
// client's record. Owner/admin/office only; tenant-scoped.
router.post("/entries/:id/dismiss", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const id = parseInt(String(req.params.id));
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) return res.status(400).json({ error: "Bad Request", message: "A dismissal reason is required" });

    // Fetch first so we can capture the rating value + job for the audit trail.
    const [entry] = await db
      .select({
        id: scorecardEntriesTable.id,
        employee_id: scorecardEntriesTable.employee_id,
        job_id: scorecardEntriesTable.job_id,
        score_value: scorecardEntriesTable.score_value,
        max_value: scorecardEntriesTable.max_value,
        dismissed_at: scorecardEntriesTable.dismissed_at,
      })
      .from(scorecardEntriesTable)
      .where(and(eq(scorecardEntriesTable.id, id), eq(scorecardEntriesTable.company_id, companyId)))
      .limit(1);
    if (!entry) return res.status(404).json({ error: "Not Found", message: "Scorecard entry not found" });

    const [updated] = await db
      .update(scorecardEntriesTable)
      .set({
        dismissed_at: new Date(),
        dismissed_by_user_id: userId,
        dismiss_reason: reason.slice(0, 2000),
      })
      .where(and(eq(scorecardEntriesTable.id, id), eq(scorecardEntriesTable.company_id, companyId)))
      .returning();

    // Recompute the affected tech's satisfaction headline AND rolling composite
    // so the dismissed rating stops counting right away. Both are best-effort
    // side effects — the dismissal itself (the UPDATE above) has already
    // committed, and the DISPLAYED Performance Score is computed live from
    // scorecard_entries (dismissed_at IS NULL), so a recompute hiccup must never
    // fail the request. (Previously recomputeEmployeeScorecard was unguarded,
    // turning a missing users.scorecard_pct_source column into a 500.)
    try { await recomputeEmployeeScorecard(companyId, entry.employee_id); } catch (e) { console.error("dismiss recomputeEmployeeScorecard (non-fatal):", e); }
    try { await recomputeCompositeScore(companyId, entry.employee_id); } catch { /* non-fatal */ }

    // Customer audit trail — write to the client's Communication timeline
    // (communication_log, channel='note') when the rating maps to a job we can
    // resolve to a customer. Non-fatal: the dismissal itself still succeeds.
    let audit_logged = false;
    try {
      if (entry.job_id != null) {
        const jr = await db.execute(sql`
          SELECT client_id FROM jobs WHERE id = ${entry.job_id} AND company_id = ${companyId} LIMIT 1`);
        const clientId = (jr.rows[0] as any)?.client_id ?? null;
        if (clientId != null) {
          const nr = await db.execute(sql`
            SELECT NULLIF(trim(first_name || ' ' || coalesce(last_name, '')), '') AS n
              FROM users WHERE id = ${userId} AND company_id = ${companyId} LIMIT 1`);
          const staffName = (nr.rows[0] as any)?.n ?? "Office";
          const val = Number(entry.score_value);
          const max = Number(entry.max_value) || 4;
          const ratingLabel = max === 100 ? `${val.toFixed(0)}%` : `${val} / ${max}`;
          const summary = `Scorecard rating dismissed — Job #${entry.job_id}, rating ${ratingLabel}. Reason: ${reason}`;
          await db.execute(sql`
            INSERT INTO communication_log
              (company_id, customer_id, job_id, direction, channel, summary, body,
               source, sent_by, logged_by, delivery_status)
            VALUES
              (${companyId}, ${clientId}, ${entry.job_id}, 'internal', 'note', ${summary}, ${summary},
               'system', ${staffName}, ${userId}, 'logged')`);
          audit_logged = true;
        }
      }
    } catch (auditErr) {
      console.error("Scorecard dismiss audit-log error (non-fatal):", auditErr);
    }

    return res.json({ ok: true, entry: updated, employee_id: entry.employee_id, audit_logged });
  } catch (err) {
    console.error("Scorecard dismiss error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to dismiss rating" });
  }
});

// POST /api/scorecards/entries/:id/undismiss — reverse a dismissal (cheap undo).
// Clears the dismiss columns and recomputes so the rating counts again.
router.post("/entries/:id/undismiss", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id));
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [updated] = await db
      .update(scorecardEntriesTable)
      .set({ dismissed_at: null, dismissed_by_user_id: null, dismiss_reason: null })
      .where(and(eq(scorecardEntriesTable.id, id), eq(scorecardEntriesTable.company_id, companyId)))
      .returning({ employee_id: scorecardEntriesTable.employee_id });
    if (!updated) return res.status(404).json({ error: "Not Found", message: "Scorecard entry not found" });
    // Best-effort recompute — see the dismiss handler above. The undismiss UPDATE
    // has already committed, so a recompute failure must not fail the request.
    try { await recomputeEmployeeScorecard(companyId, updated.employee_id); } catch (e) { console.error("undismiss recomputeEmployeeScorecard (non-fatal):", e); }
    try { await recomputeCompositeScore(companyId, updated.employee_id); } catch { /* non-fatal */ }
    return res.json({ ok: true, employee_id: updated.employee_id });
  } catch (err) {
    console.error("Scorecard undismiss error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to restore rating" });
  }
});

// POST /api/scorecards/recompute — backfill qleno scorecard headlines from
// non-excluded survey responses. MC baseline preserved.
router.post("/recompute", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const result = await recomputeAllScorecards(req.auth!.companyId!);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Scorecard recompute error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to recompute scorecards" });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const { user_id, client_id } = req.query;
    const conditions: any[] = [eq(scorecardsTable.company_id, req.auth!.companyId)];
    if (user_id) conditions.push(eq(scorecardsTable.user_id, parseInt(user_id as string)));
    if (client_id) conditions.push(eq(scorecardsTable.client_id, parseInt(client_id as string)));

    const scorecards = await db
      .select({
        id: scorecardsTable.id,
        job_id: scorecardsTable.job_id,
        user_id: scorecardsTable.user_id,
        user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        client_id: scorecardsTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        score: scorecardsTable.score,
        comments: scorecardsTable.comments,
        excluded: scorecardsTable.excluded,
        created_at: scorecardsTable.created_at,
      })
      .from(scorecardsTable)
      .leftJoin(usersTable, eq(scorecardsTable.user_id, usersTable.id))
      .leftJoin(clientsTable, eq(scorecardsTable.client_id, clientsTable.id))
      .where(and(...conditions))
      .orderBy(desc(scorecardsTable.created_at));

    const avgResult = await db
      .select({ avg: avg(scorecardsTable.score) })
      .from(scorecardsTable)
      .where(and(...conditions, eq(scorecardsTable.excluded, false)));

    return res.json({
      data: scorecards,
      total: scorecards.length,
      average_score: avgResult[0].avg ? parseFloat(avgResult[0].avg) : null,
    });
  } catch (err) {
    console.error("List scorecards error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to list scorecards" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const { job_id, user_id, client_id, score, comments, excluded = false } = req.body;

    const newScorecard = await db
      .insert(scorecardsTable)
      .values({
        company_id: req.auth!.companyId,
        job_id,
        user_id,
        client_id,
        score,
        comments,
        excluded,
      })
      .returning();

    const user = await db
      .select({ first_name: usersTable.first_name, last_name: usersTable.last_name })
      .from(usersTable)
      .where(eq(usersTable.id, user_id))
      .limit(1);

    const client = await db
      .select({ first_name: clientsTable.first_name, last_name: clientsTable.last_name })
      .from(clientsTable)
      .where(eq(clientsTable.id, client_id))
      .limit(1);

    return res.status(201).json({
      ...newScorecard[0],
      user_name: `${user[0]?.first_name || ""} ${user[0]?.last_name || ""}`.trim(),
      client_name: `${client[0]?.first_name || ""} ${client[0]?.last_name || ""}`.trim(),
    });
  } catch (err) {
    console.error("Create scorecard error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to create scorecard" });
  }
});

// Per-employee scorecard detail: the authoritative % + the per-job history
// rows (scorecard_entries) for the employee profile Scorecards tab.
router.get("/entries/:employee_id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const employeeId = parseInt(req.params.employee_id);
    if (isNaN(employeeId)) return res.status(400).json({ error: "Invalid employee_id" });

    const [emp] = await db
      .select({ scorecard_pct: usersTable.scorecard_pct })
      .from(usersTable)
      .where(and(eq(usersTable.id, employeeId), eq(usersTable.company_id, companyId)))
      .limit(1);

    const entries = await db
      .select()
      .from(scorecardEntriesTable)
      .where(and(
        eq(scorecardEntriesTable.company_id, companyId),
        eq(scorecardEntriesTable.employee_id, employeeId),
      ))
      .orderBy(desc(scorecardEntriesTable.entry_date));

    // [dismiss-rating] Resolve the dismisser's display name so the UI can show
    // "Dismissed by <name>" without a second round-trip.
    const dismisserIds = [...new Set(entries.map(e => e.dismissed_by_user_id).filter((v): v is number => v != null))];
    let nameById = new Map<number, string>();
    if (dismisserIds.length) {
      const names = await db.execute(sql`
        SELECT id, NULLIF(trim(first_name || ' ' || coalesce(last_name, '')), '') AS n
          FROM users WHERE company_id = ${companyId} AND id IN (${sql.join(dismisserIds, sql`, `)})`);
      nameById = new Map((names.rows as any[]).map(r => [Number(r.id), r.n as string]));
    }
    const enriched = entries.map(e => ({
      ...e,
      dismissed_by_name: e.dismissed_by_user_id != null ? (nameById.get(e.dismissed_by_user_id) ?? null) : null,
    }));

    return res.json({ scorecard_pct: emp?.scorecard_pct ?? null, entries: enriched });
  } catch (err) {
    console.error("Scorecard entries error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to fetch scorecard entries" });
  }
});

// [90d-composite] Live 90-day rolling composite for one tech: the three
// sub-scores (satisfaction / attendance / complaint-free), the blended
// composite (the displayed headline), the per-tenant weights, the window, and
// the underlying counts for drill-down on the employee profile. Computed fresh
// (not just the persisted snapshot) so the profile always reflects "as of now".
router.get("/composite/:employee_id", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const employeeId = parseInt(req.params.employee_id);
    if (isNaN(employeeId)) return res.status(400).json({ error: "Invalid employee_id" });
    const result = await computeCompositeForEmployee(companyId, employeeId);
    return res.json(result);
  } catch (err) {
    console.error("Scorecard composite error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to compute composite" });
  }
});

// [90d-composite] Office backfill — recompute + persist every tech's composite.
router.post("/recompute-composite", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const result = await recomputeAllComposites(req.auth!.companyId!);
    return res.json(result);
  } catch (err) {
    console.error("Scorecard recompute-composite error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to recompute composites" });
  }
});

// [GAP3] Office/owner reply to the customer's feedback on a scorecard entry.
// Surfaces on the employee profile Scorecards tab next to the customer comment.
// Owner/admin/office only; tenant-scoped. Send reply: "" to clear.
router.post("/entries/:entryId/reply", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const entryId = parseInt(req.params.entryId);
    if (isNaN(entryId)) return res.status(400).json({ error: "Invalid entryId" });
    const reply = typeof req.body?.reply === "string" ? req.body.reply.trim() : "";
    const cleared = reply.length === 0;

    const updated = await db
      .update(scorecardEntriesTable)
      .set({
        office_reply: cleared ? null : reply.slice(0, 2000),
        office_reply_by_user_id: cleared ? null : req.auth!.userId,
        office_reply_at: cleared ? null : new Date(),
      })
      .where(and(
        eq(scorecardEntriesTable.id, entryId),
        eq(scorecardEntriesTable.company_id, companyId),
      ))
      .returning();

    if (!updated[0]) return res.status(404).json({ error: "Not Found", message: "Scorecard entry not found" });
    return res.json({ entry: updated[0] });
  } catch (err) {
    console.error("Scorecard reply error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to save reply" });
  }
});

// ── MaidCentral scorecard import (bulk) ──────────────────────────────────────
// Loads (a) each employee's authoritative MC scorecard % into users.scorecard_pct
// (stored as-is, NOT recomputed) and (b) per-job history into scorecard_entries.
// Employees resolved by user_id, else email, else exact "First Last" (case-insensitive).
// Idempotent for %s (upsert). Entries: pass replace=true to clear existing
// source='mc' rows for the matched employees before inserting (safe re-runs).
//
// Body: {
//   replace?: boolean,
//   employee_pcts?: [{ user_id?, email?, name?, pct }],
//   entries?: [{ user_id?, email?, name?, job_id?, entry_date, score_value, max_value?, source?, notes? }]
// }
router.post("/import", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { employee_pcts = [], entries = [], replace = false } = req.body ?? {};

    // Resolver: build a lookup of this company's users by id / email / name.
    const users = await db
      .select({ id: usersTable.id, email: usersTable.email, first_name: usersTable.first_name, last_name: usersTable.last_name })
      .from(usersTable)
      .where(eq(usersTable.company_id, companyId));
    const byId = new Map(users.map(u => [u.id, u]));
    const byEmail = new Map(users.filter(u => u.email).map(u => [u.email!.toLowerCase(), u]));
    const byName = new Map(users.map(u => [`${u.first_name} ${u.last_name}`.trim().toLowerCase(), u]));
    const resolve = (r: any): number | null => {
      if (r.user_id != null && byId.has(Number(r.user_id))) return Number(r.user_id);
      if (r.email && byEmail.has(String(r.email).toLowerCase())) return byEmail.get(String(r.email).toLowerCase())!.id;
      if (r.name && byName.has(String(r.name).trim().toLowerCase())) return byName.get(String(r.name).trim().toLowerCase())!.id;
      return null;
    };

    const unresolved: any[] = [];
    let pctsUpdated = 0;

    // (a) per-employee authoritative %
    for (const p of employee_pcts) {
      const uid = resolve(p);
      if (uid == null) { unresolved.push({ kind: "pct", ref: p.email ?? p.name ?? p.user_id }); continue; }
      const pct = Number(p.pct);
      if (!Number.isFinite(pct)) { unresolved.push({ kind: "pct_value", ref: p.email ?? p.name }); continue; }
      await db.update(usersTable).set({ scorecard_pct: String(pct) })
        .where(and(eq(usersTable.id, uid), eq(usersTable.company_id, companyId)));
      pctsUpdated++;
    }

    // (b) per-job history
    const resolvedEntryEmps = new Set<number>();
    const rows: any[] = [];
    for (const e of entries) {
      const uid = resolve(e);
      if (uid == null) { unresolved.push({ kind: "entry", ref: e.email ?? e.name ?? e.user_id, date: e.entry_date }); continue; }
      if (!e.entry_date || e.score_value == null) { unresolved.push({ kind: "entry_fields", ref: e.email ?? e.name }); continue; }
      resolvedEntryEmps.add(uid);
      rows.push({
        company_id: companyId,
        employee_id: uid,
        job_id: e.job_id != null ? Number(e.job_id) : null,
        entry_date: String(e.entry_date),
        score_value: String(Number(e.score_value)),
        max_value: e.max_value != null ? String(Number(e.max_value)) : "100",
        source: e.source === "qleno" ? "qleno" : "mc",
        notes: e.notes ?? null,
      });
    }

    if (replace && resolvedEntryEmps.size > 0) {
      await db.delete(scorecardEntriesTable).where(and(
        eq(scorecardEntriesTable.company_id, companyId),
        eq(scorecardEntriesTable.source, "mc"),
        inArray(scorecardEntriesTable.employee_id, [...resolvedEntryEmps]),
      ));
    }

    let entriesInserted = 0;
    // Chunked insert to stay well under parameter limits for 781 rows.
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      if (chunk.length) { await db.insert(scorecardEntriesTable).values(chunk); entriesInserted += chunk.length; }
    }

    return res.json({ ok: true, pcts_updated: pctsUpdated, entries_inserted: entriesInserted, unresolved });
  } catch (err) {
    console.error("Scorecard import error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to import scorecards" });
  }
});

export default router;
