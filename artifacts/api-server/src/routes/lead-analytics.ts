/**
 * Lead Analytics + Cost/KPI API
 *  GET    /api/lead-analytics/report?period=&from=&to=  — funnel, conversion,
 *         speed-to-lead, source/partner/rep performance, pipeline $, aging,
 *         booked revenue, CPL/CPA/ROI, actual-vs-target.
 *  GET/PUT /api/lead-analytics/settings                 — headline cards.
 *  GET/POST/PATCH/DELETE /api/lead-analytics/spend      — marketing spend.
 *  GET/PUT /api/lead-analytics/targets                  — KPI targets.
 *
 * Booked revenue convention (approved 2026-06-15): sum of actual booked jobs'
 * value (billed_amount ?? base_fee) for lead-sourced jobs, attributed to the
 * period the lead was BOOKED in (booked_at, falling back to created_at) — not
 * the job's scheduled_date. Matches standard sales-report attribution.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { resolveWindow } from "../lib/report-periods.js";

const router = Router();

const LOST = ["no_response", "not_interested"];
const num = (v: any) => Number(v) || 0;
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

// ── GET /report ─────────────────────────────────────────────────────────────────
router.get("/report", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { period = "rolling_90d", from, to, anchor } = req.query as Record<string, string>;
    const w = resolveWindow(period, { anchor, from, to });
    const inWin = sql`l.created_at >= ${w.from}::date AND l.created_at < (${w.to}::date + interval '1 day')`;

    // Funnel + totals (cohort = leads created in window, by current status)
    const funnelRows = await db.execute(sql`
      SELECT status, COUNT(*)::int AS c
      FROM leads l WHERE l.company_id = ${companyId} AND ${inWin}
      GROUP BY status`);
    const funnel: Record<string, number> = {};
    for (const r of funnelRows.rows as any[]) funnel[r.status] = num(r.c);

    const leads = Object.values(funnel).reduce((a, b) => a + b, 0);
    const booked = funnel["booked"] || 0;
    const lost = (funnel["no_response"] || 0) + (funnel["not_interested"] || 0);
    const contactedPlus = leads - (funnel["needs_contacted"] || 0);
    const quotedPlus = booked + (funnel["quoted"] || 0) + (funnel["follow_up"] || 0);

    // Speed-to-lead + quote→book (hours)
    const speedRows = await db.execute(sql`
      SELECT
        AVG(EXTRACT(EPOCH FROM (contacted_at - created_at)))
          FILTER (WHERE contacted_at IS NOT NULL) AS to_contact_secs,
        AVG(EXTRACT(EPOCH FROM (booked_at - quoted_at)))
          FILTER (WHERE booked_at IS NOT NULL AND quoted_at IS NOT NULL) AS quote_book_secs
      FROM leads l WHERE l.company_id = ${companyId} AND ${inWin}`);
    const sp = (speedRows.rows[0] || {}) as any;
    const speed = {
      avg_hours_to_contact: sp.to_contact_secs != null ? Math.round((num(sp.to_contact_secs) / 3600) * 10) / 10 : null,
      avg_hours_quote_to_book: sp.quote_book_secs != null ? Math.round((num(sp.quote_book_secs) / 3600) * 10) / 10 : null,
    };

    // Conversion by source
    const bySourceRows = await db.execute(sql`
      SELECT source,
        COUNT(*)::int AS leads,
        COUNT(*) FILTER (WHERE status = 'booked')::int AS booked,
        COALESCE(SUM(quote_amount) FILTER (WHERE status = 'booked'), 0) AS booked_value
      FROM leads l WHERE l.company_id = ${companyId} AND ${inWin}
      GROUP BY source ORDER BY leads DESC`);
    const by_source = (bySourceRows.rows as any[]).map(r => ({
      source: r.source, leads: num(r.leads), booked: num(r.booked),
      booked_value: num(r.booked_value), rate: pct(num(r.booked), num(r.leads)),
    }));

    // [referral-vocabulary 2026-07-23] Conversion by REFERRAL SOURCE — how the
    // customer heard about us (Google, Yelp, a friend), which is a different
    // question from `by_source` above (how the lead ENTERED: office quote vs
    // website widget). The dashboard shows both and they must never be merged;
    // an office-keyed quote from a Yelp caller is `quote` on one axis and
    // `yelp` on the other.
    //
    // NULL rolls up as 'unasked' rather than being dropped, because coverage is
    // the real story right now: most office-created quotes never filled the
    // field in, and a card that hid those would overstate how much we know.
    const byReferralRows = await db.execute(sql`
      SELECT COALESCE(referral_source::text, 'unasked') AS referral,
        COUNT(*)::int AS leads,
        COUNT(*) FILTER (WHERE status = 'booked')::int AS booked,
        COALESCE(SUM(quote_amount) FILTER (WHERE status = 'booked'), 0) AS booked_value
      FROM leads l WHERE l.company_id = ${companyId} AND ${inWin}
      GROUP BY 1 ORDER BY leads DESC`);
    const by_referral = (byReferralRows.rows as any[]).map(r => ({
      referral: r.referral, leads: num(r.leads), booked: num(r.booked),
      booked_value: num(r.booked_value), rate: pct(num(r.booked), num(r.leads)),
    }));

    // Partner performance
    const byPartnerRows = await db.execute(sql`
      SELECT p.id AS partner_id, p.name,
        COUNT(l.id)::int AS leads,
        COUNT(l.id) FILTER (WHERE l.status = 'booked')::int AS booked,
        COALESCE(SUM(l.quote_amount) FILTER (WHERE l.status = 'booked'), 0) AS booked_value
      FROM referral_partners p
      LEFT JOIN leads l ON l.referral_partner_id = p.id AND l.company_id = p.company_id AND ${inWin}
      WHERE p.company_id = ${companyId}
      GROUP BY p.id, p.name
      HAVING COUNT(l.id) > 0
      ORDER BY leads DESC`);
    const by_partner = (byPartnerRows.rows as any[]).map(r => ({
      partner_id: r.partner_id, name: r.name, leads: num(r.leads), booked: num(r.booked),
      booked_value: num(r.booked_value), rate: pct(num(r.booked), num(r.leads)),
    }));

    // Per-rep (owner) performance
    const byRepRows = await db.execute(sql`
      SELECT u.id AS user_id, u.first_name, u.last_name,
        COUNT(l.id)::int AS leads,
        COUNT(l.id) FILTER (WHERE l.status = 'booked')::int AS booked
      FROM leads l
      JOIN users u ON u.id = l.assigned_to
      WHERE l.company_id = ${companyId} AND ${inWin}
      GROUP BY u.id, u.first_name, u.last_name
      ORDER BY leads DESC`);
    const by_rep = (byRepRows.rows as any[]).map(r => ({
      user_id: r.user_id, name: `${r.first_name} ${r.last_name || ""}`.trim(),
      leads: num(r.leads), booked: num(r.booked), rate: pct(num(r.booked), num(r.leads)),
    }));

    // Open pipeline value + aging (open = not booked/lost), age-independent of window
    const pipeRows = await db.execute(sql`
      SELECT
        COALESCE(SUM(quote_amount), 0) AS pipeline_value,
        COUNT(*) FILTER (WHERE NOW() - created_at < interval '3 days')::int AS age_0_2,
        COUNT(*) FILTER (WHERE NOW() - created_at >= interval '3 days' AND NOW() - created_at < interval '8 days')::int AS age_3_7,
        COUNT(*) FILTER (WHERE NOW() - created_at >= interval '8 days' AND NOW() - created_at < interval '15 days')::int AS age_8_14,
        COUNT(*) FILTER (WHERE NOW() - created_at >= interval '15 days' AND NOW() - created_at < interval '31 days')::int AS age_15_30,
        COUNT(*) FILTER (WHERE NOW() - created_at >= interval '31 days')::int AS age_31p
      FROM leads l
      WHERE l.company_id = ${companyId}
        AND l.status NOT IN ('booked','no_response','not_interested')`);
    const pr = (pipeRows.rows[0] || {}) as any;
    const pipeline_value = num(pr.pipeline_value);
    const aging = [
      { bucket: "0–2 days", count: num(pr.age_0_2) },
      { bucket: "3–7 days", count: num(pr.age_3_7) },
      { bucket: "8–14 days", count: num(pr.age_8_14) },
      { bucket: "15–30 days", count: num(pr.age_15_30) },
      { bucket: "31+ days", count: num(pr.age_31p) },
    ];

    // Booked revenue = actual job value of leads BOOKED in the window.
    // [revenue-attribution 2026-06-15] Attribute the won deal to WHEN it was
    // booked (the conversion event), not when the job is scheduled — standard
    // sales-report convention, and it stops future-dated jobs from
    // understating the current period. Value still comes from the real job
    // (billed_amount ?? base_fee). booked_at falls back to created_at for
    // bookings made without a stage-change timestamp.
    const revRows = await db.execute(sql`
      SELECT COALESCE(SUM(COALESCE(j.billed_amount, j.base_fee, 0)), 0) AS rev
      FROM leads l
      JOIN jobs j ON j.id = l.job_id
      WHERE l.company_id = ${companyId}
        AND l.status = 'booked'
        AND COALESCE(l.booked_at, l.created_at) >= ${w.from}::date
        AND COALESCE(l.booked_at, l.created_at) < (${w.to}::date + interval '1 day')`);
    const booked_revenue = num((revRows.rows[0] as any)?.rev);

    // Marketing spend overlapping the window → CPL / CPA / ROI
    const spendRows = await db.execute(sql`
      SELECT COALESCE(SUM(amount), 0) AS spend
      FROM marketing_spend
      WHERE company_id = ${companyId}
        AND period_start <= ${w.to}::date
        AND period_end >= ${w.from}::date`);
    const total_spend = num((spendRows.rows[0] as any)?.spend);
    const cost = {
      total_spend,
      cpl: leads > 0 ? Math.round((total_spend / leads) * 100) / 100 : null,
      cpa: booked > 0 ? Math.round((total_spend / booked) * 100) / 100 : null,
      roi: total_spend > 0 ? Math.round(((booked_revenue - total_spend) / total_spend) * 1000) / 10 : null,
    };

    const rates = {
      lead_to_book: pct(booked, leads),
      close_rate: pct(booked, booked + lost),
      contact_rate: pct(contactedPlus, leads),
      quote_rate: pct(quotedPlus, leads),
    };

    // Targets (actual-vs-target)
    const targetRows = await db.execute(sql`
      SELECT metric, target_value, period FROM kpi_targets WHERE company_id = ${companyId}`);
    const actualByMetric: Record<string, number> = {
      leads, booked, booked_revenue,
      lead_to_book: rates.lead_to_book, close_rate: rates.close_rate,
      contact_rate: rates.contact_rate, pipeline_value,
    };
    const targets = (targetRows.rows as any[]).map(r => ({
      metric: r.metric, target: num(r.target_value), period: r.period,
      actual: actualByMetric[r.metric] ?? null,
    }));

    return res.json({
      window: w,
      totals: { leads, booked, lost, pipeline_value, booked_revenue },
      funnel, rates, speed,
      by_source, by_referral, by_partner, by_rep,
      aging, cost, targets,
    });
  } catch (err) {
    console.error("GET /lead-analytics/report:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET/PUT /settings (headline cards) ───────────────────────────────────────────
router.get("/settings", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const rows = await db.execute(sql`SELECT headline_cards FROM lead_report_settings WHERE company_id = ${companyId} LIMIT 1`);
    const cards = (rows.rows[0] as any)?.headline_cards ?? ["leads", "lead_to_book", "close_rate"];
    return res.json({ headline_cards: cards });
  } catch (err) {
    console.error("GET /lead-analytics/settings:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/settings", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const cards: string[] = Array.isArray(req.body?.headline_cards) ? req.body.headline_cards.slice(0, 4) : [];
    if (!cards.length) return res.status(400).json({ error: "headline_cards[] required" });
    const arr = `ARRAY[${cards.map(c => `'${String(c).replace(/'/g, "''")}'`).join(",")}]::text[]`;
    await db.execute(sql.raw(`
      INSERT INTO lead_report_settings (company_id, headline_cards, updated_at)
      VALUES (${companyId}, ${arr}, NOW())
      ON CONFLICT (company_id) DO UPDATE SET headline_cards = ${arr}, updated_at = NOW()`));
    return res.json({ ok: true });
  } catch (err) {
    console.error("PUT /lead-analytics/settings:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Marketing spend CRUD ─────────────────────────────────────────────────────────
router.get("/spend", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const rows = await db.execute(sql`
      SELECT * FROM marketing_spend WHERE company_id = ${companyId} ORDER BY period_start DESC, id DESC`);
    return res.json(rows.rows);
  } catch (err) {
    console.error("GET /lead-analytics/spend:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/spend", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { source, amount, period_start, period_end, notes } = req.body;
    if (!source || !period_start || !period_end) return res.status(400).json({ error: "source, period_start, period_end required" });
    const result = await db.execute(sql`
      INSERT INTO marketing_spend (company_id, source, amount, period_start, period_end, notes, created_at)
      VALUES (${companyId}, ${source}, ${amount != null ? parseFloat(amount) : 0},
              ${period_start}::date, ${period_end}::date, ${notes || null}, NOW())
      RETURNING id`);
    return res.status(201).json({ id: (result.rows[0] as any).id });
  } catch (err) {
    console.error("POST /lead-analytics/spend:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/spend/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    const { source, amount, period_start, period_end, notes } = req.body;
    await db.execute(sql`
      UPDATE marketing_spend SET
        source = COALESCE(${source ?? null}, source),
        amount = COALESCE(${amount != null ? parseFloat(amount) : null}, amount),
        period_start = COALESCE(${period_start ?? null}::date, period_start),
        period_end = COALESCE(${period_end ?? null}::date, period_end),
        notes = ${notes !== undefined ? (notes || null) : sql`notes`}
      WHERE id = ${id} AND company_id = ${companyId}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /lead-analytics/spend/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/spend/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    await db.execute(sql`DELETE FROM marketing_spend WHERE id = ${parseInt(req.params.id)} AND company_id = ${companyId}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /lead-analytics/spend/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── KPI targets ──────────────────────────────────────────────────────────────────
router.get("/targets", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const rows = await db.execute(sql`SELECT metric, target_value, period FROM kpi_targets WHERE company_id = ${companyId}`);
    return res.json(rows.rows);
  } catch (err) {
    console.error("GET /lead-analytics/targets:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// PUT body: { targets: [{ metric, target_value, period? }] } — upserts each.
router.put("/targets", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const targets = Array.isArray(req.body?.targets) ? req.body.targets : [];
    for (const t of targets) {
      if (!t?.metric) continue;
      await db.execute(sql`
        INSERT INTO kpi_targets (company_id, metric, target_value, period, updated_at)
        VALUES (${companyId}, ${t.metric}, ${t.target_value != null ? parseFloat(t.target_value) : 0}, ${t.period || "monthly"}, NOW())
        ON CONFLICT (company_id, metric) DO UPDATE SET
          target_value = EXCLUDED.target_value, period = EXCLUDED.period, updated_at = NOW()`);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("PUT /lead-analytics/targets:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
