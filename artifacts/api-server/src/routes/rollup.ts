/**
 * Cross-tenant owner roll-up — "All locations".
 * Aggregates KPIs across ONLY the companies the caller OWNS (user_companies
 * role='owner'). A user who owns one tenant sees only that tenant; a
 * Schaumburg-only owner can never see Oak Lawn. Read-only.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

const num = (v: any) => Number(v) || 0;

// GET /api/rollup — combined KPIs across the caller's owned tenants.
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;

    // Companies this user OWNS (the gate). Fall back to the home company only
    // when the caller is its owner and has no explicit membership rows.
    const ownedRows = await db.execute(sql`
      SELECT company_id FROM user_companies WHERE user_id = ${userId} AND role = 'owner'`);
    let owned = (ownedRows.rows as any[]).map(r => Number(r.company_id));
    if (owned.length === 0 && req.auth!.role === "owner" && req.auth!.companyId != null) {
      owned = [Number(req.auth!.companyId)];
    }
    if (owned.length === 0) {
      return res.json({ eligible: false, owned_count: 0, companies: [], combined: null });
    }
    const idsCsv = owned.join(",");

    const comps = await db.execute(sql`SELECT id, name FROM companies WHERE id = ANY(ARRAY[${sql.raw(idsCsv)}]::int[]) ORDER BY id`);

    // [rollup-fix 2026-06-15] JOBS + REVENUE are COMPLETED work only — the old
    // query counted every job (future scheduled + cancelled) and summed their
    // base_fee as "revenue", which inflated both figures. Completed-only matches
    // how revenue is defined everywhere else (dashboard, payroll, job_history).
    // UPCOMING stays the forward pipeline of scheduled jobs.
    const jobsAgg = await db.execute(sql`
      SELECT company_id,
        COUNT(*) FILTER (WHERE status='complete')::int AS jobs_total,
        COUNT(*) FILTER (WHERE status='scheduled' AND scheduled_date >= CURRENT_DATE)::int AS jobs_upcoming,
        COALESCE(SUM(COALESCE(billed_amount, base_fee, 0)) FILTER (WHERE status='complete'), 0) AS revenue
      FROM jobs WHERE company_id = ANY(ARRAY[${sql.raw(idsCsv)}]::int[]) GROUP BY company_id`);

    const leadsAgg = await db.execute(sql`
      SELECT company_id,
        COUNT(*)::int AS leads_total,
        COUNT(*) FILTER (WHERE status NOT IN ('booked','no_response','not_interested'))::int AS leads_open,
        COALESCE(SUM(quote_amount) FILTER (WHERE status NOT IN ('booked','no_response','not_interested')), 0) AS pipeline_value
      FROM leads WHERE company_id = ANY(ARRAY[${sql.raw(idsCsv)}]::int[]) GROUP BY company_id`);

    const jBy: Record<number, any> = {}; for (const r of jobsAgg.rows as any[]) jBy[Number(r.company_id)] = r;
    const lBy: Record<number, any> = {}; for (const r of leadsAgg.rows as any[]) lBy[Number(r.company_id)] = r;

    const companies = (comps.rows as any[]).map(c => {
      const j = jBy[Number(c.id)] || {}; const l = lBy[Number(c.id)] || {};
      return {
        company_id: Number(c.id), name: c.name,
        jobs_total: num(j.jobs_total), jobs_upcoming: num(j.jobs_upcoming),
        revenue: Math.round(num(j.revenue) * 100) / 100,
        leads_total: num(l.leads_total), leads_open: num(l.leads_open),
        pipeline_value: Math.round(num(l.pipeline_value) * 100) / 100,
      };
    });

    const combined = companies.reduce((a, c) => ({
      jobs_total: a.jobs_total + c.jobs_total,
      jobs_upcoming: a.jobs_upcoming + c.jobs_upcoming,
      revenue: Math.round((a.revenue + c.revenue) * 100) / 100,
      leads_total: a.leads_total + c.leads_total,
      leads_open: a.leads_open + c.leads_open,
      pipeline_value: Math.round((a.pipeline_value + c.pipeline_value) * 100) / 100,
    }), { jobs_total: 0, jobs_upcoming: 0, revenue: 0, leads_total: 0, leads_open: 0, pipeline_value: 0 });

    return res.json({ eligible: owned.length >= 2, owned_count: owned.length, companies, combined });
  } catch (err) {
    console.error("GET /rollup:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
