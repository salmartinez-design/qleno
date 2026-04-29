import { Router } from "express";
import { db, pool } from "@workspace/db";
import {
  usersTable,
  companiesTable,
  auditLogTable,
  articlesTable,
} from "@workspace/db/schema";
import { eq, sql, and, inArray, gte, desc } from "drizzle-orm";
import { requireAuth, requireRole, signToken } from "../lib/auth.js";
import { runSmokeTests } from "../lib/smoke-test.js";
import type { Request, Response, NextFunction } from "express";

const router = Router();

const PLAN_MRR: Record<string, number> = {
  starter: 49,
  growth: 149,
  enterprise: 299,
};

function requireSuperAdminAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Unauthorized", message: "Not authenticated" });
    return;
  }
  if (req.auth.role === "super_admin" || req.auth.isSuperAdmin === true) {
    next();
    return;
  }
  res.status(403).json({ error: "Forbidden", message: "Super admin access required" });
}

const isSuperAdmin = [requireAuth, requireSuperAdminAccess];

/* ── DASHBOARD ────────────────────────────────────────────────── */
router.get("/dashboard", ...isSuperAdmin, async (_req, res) => {
  try {
    const companies = await db.select().from(companiesTable);

    const totalCompanies = companies.length;
    const activeSubs = companies.filter(
      (c) => c.subscription_status === "active"
    ).length;
    const trialSubs = companies.filter(
      (c) => c.subscription_status === "trialing"
    ).length;
    const pastDueSubs = companies.filter(
      (c) => c.subscription_status === "past_due"
    ).length;
    const canceledSubs = companies.filter(
      (c) => c.subscription_status === "canceled"
    ).length;

    const mrr = companies
      .filter((c) => c.subscription_status === "active")
      .reduce((sum, c) => sum + (PLAN_MRR[c.plan] || 0), 0);

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const newThisWeek = companies.filter(
      (c) => new Date(c.created_at) >= oneWeekAgo
    ).length;

    const flagged = companies.filter((c) =>
      ["past_due", "canceled"].includes(c.subscription_status)
    );

    return res.json({
      totalCompanies,
      activeSubs,
      trialSubs,
      pastDueSubs,
      canceledSubs,
      mrr,
      arr: mrr * 12,
      newThisWeek,
      platformFeeRevenue: Math.round(mrr * 0.05),
      flagged: flagged.map((c) => ({ id: c.id, name: c.name, status: c.subscription_status })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── COMPANIES LIST ───────────────────────────────────────────── */
router.get("/companies", ...isSuperAdmin, async (req, res) => {
  try {
    const { status } = req.query as { status?: string };

    const allCompanies = await db.select().from(companiesTable);

    const filtered = status && status !== "all"
      ? allCompanies.filter((c) => c.subscription_status === status)
      : allCompanies;

    const companyIds = filtered.map((c) => c.id);
    const owners = companyIds.length
      ? await db
          .select({
            company_id: usersTable.company_id,
            email: usersTable.email,
            first_name: usersTable.first_name,
            last_name: usersTable.last_name,
          })
          .from(usersTable)
          .where(
            and(
              inArray(usersTable.company_id as any, companyIds),
              inArray(usersTable.role, ["owner"])
            )
          )
      : [];

    const ownerMap: Record<number, typeof owners[0]> = {};
    for (const o of owners) {
      if (o.company_id != null) ownerMap[o.company_id] = o;
    }

    const result = filtered.map((c) => ({
      ...c,
      owner: ownerMap[c.id] || null,
      mrr: c.subscription_status === "active" ? PLAN_MRR[c.plan] || 0 : 0,
    }));

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── TENANT SUMMARY LIST ──────────────────────────────────────── */
router.get("/tenants", ...isSuperAdmin, async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        c.id, c.name, c.subscription_status, c.plan, c.early_tenant,
        c.trial_ends_at, c.stripe_customer_id, c.created_at,
        t.name AS tier_name, t.slug AS tier_slug, t.price_monthly,
        (SELECT COUNT(*)::int FROM users u WHERE u.company_id=c.id AND u.role='technician' AND u.is_active=true) AS active_techs,
        (SELECT COUNT(*)::int FROM users u WHERE u.company_id=c.id AND u.role IN ('office','admin') AND u.is_active=true) AS active_office,
        (SELECT COUNT(*)::int FROM users u WHERE u.company_id=c.id AND u.is_active=true) AS total_users,
        CASE WHEN c.subscription_status='active' THEN COALESCE(t.price_monthly::numeric, 0) ELSE 0 END AS mrr
      FROM companies c
      LEFT JOIN subscription_tiers t ON t.id=c.tier_id
      ORDER BY c.id
    `);
    return res.json({ data: (rows as any).rows ?? [] });
  } catch (err) {
    console.error("GET admin/tenants error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── COMPANY UPDATE ───────────────────────────────────────────── */
router.patch("/companies/:id", ...isSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { plan, brand_color, subscription_status } = req.body;

    const updates: Record<string, unknown> = {};
    if (plan) updates.plan = plan;
    if (brand_color) updates.brand_color = brand_color;
    if (subscription_status) updates.subscription_status = subscription_status;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const updated = await db
      .update(companiesTable)
      .set(updates as any)
      .where(eq(companiesTable.id, id))
      .returning();

    return res.json(updated[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── SUSPEND COMPANY ──────────────────────────────────────────── */
router.post("/companies/:id/suspend", ...isSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    await db
      .update(companiesTable)
      .set({ subscription_status: "canceled" } as any)
      .where(eq(companiesTable.id, id));

    await db.update(usersTable)
      .set({ is_active: false })
      .where(eq(usersTable.company_id as any, id));

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── IMPERSONATE COMPANY ──────────────────────────────────────── */
router.post("/companies/:id/impersonate", ...isSuperAdmin, async (req, res) => {
  try {
    const companyId = parseInt(req.params.id);
    const adminUserId = req.auth!.userId;

    const ownerUsers = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.company_id as any, companyId),
          inArray(usersTable.role, ["owner", "admin"])
        )
      )
      .limit(1);

    if (!ownerUsers[0]) {
      return res.status(404).json({ error: "No owner found for this company" });
    }

    const target = ownerUsers[0];

    await db.insert(auditLogTable).values({
      admin_user_id: adminUserId,
      action: "impersonate",
      target_company_id: companyId,
      target_user_id: target.id,
      metadata: JSON.stringify({ timestamp: new Date().toISOString() }),
    });

    const impersonationToken = signToken({
      userId: target.id,
      companyId: target.company_id,
      role: target.role,
      email: target.email,
    });

    return res.json({ token: impersonationToken, user: { email: target.email, role: target.role } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── BILLING ──────────────────────────────────────────────────── */
router.get("/billing", ...isSuperAdmin, async (_req, res) => {
  try {
    const companies = await db.select().from(companiesTable);

    const byPlan = { starter: 0, growth: 0, enterprise: 0 };
    let mrr = 0;

    for (const c of companies) {
      if (c.subscription_status === "active") {
        const key = c.plan as keyof typeof byPlan;
        byPlan[key] = (byPlan[key] || 0) + 1;
        mrr += PLAN_MRR[c.plan] || 0;
      }
    }

    const upcomingRenewals = companies.filter(
      (c) => c.subscription_status === "active"
    ).length;

    const failedPayments = companies.filter(
      (c) => c.subscription_status === "past_due"
    ).length;

    const mrrHistory = Array.from({ length: 6 }, (_, i) => {
      const d = new Date();
      d.setMonth(d.getMonth() - (5 - i));
      return {
        month: d.toLocaleString("default", { month: "short" }),
        mrr: Math.round(mrr * (0.7 + i * 0.06)),
      };
    });

    return res.json({
      mrr,
      arr: mrr * 12,
      platformFees: Math.round(mrr * 0.05),
      byPlan,
      upcomingRenewals,
      failedPayments,
      mrrHistory,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── ARTICLES ─────────────────────────────────────────────────── */
router.get("/articles", ...isSuperAdmin, async (req, res) => {
  try {
    const articles = await db
      .select()
      .from(articlesTable)
      .orderBy(desc(articlesTable.created_at));
    return res.json(articles);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/articles", ...isSuperAdmin, async (req, res) => {
  try {
    const { title_en, title_es, content_en, content_es, category, published, slug } = req.body;
    if (!title_en || !slug) {
      return res.status(400).json({ error: "title_en and slug are required" });
    }
    const created = await db.insert(articlesTable).values({
      slug,
      title_en,
      title_es: title_es || null,
      content_en: content_en || "",
      content_es: content_es || null,
      category: category || null,
      published: published || false,
    }).returning();
    return res.status(201).json(created[0]);
  } catch (err: any) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Slug already exists" });
    }
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/articles/:id", ...isSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { title_en, title_es, content_en, content_es, category, published } = req.body;
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (title_en !== undefined) updates.title_en = title_en;
    if (title_es !== undefined) updates.title_es = title_es;
    if (content_en !== undefined) updates.content_en = content_en;
    if (content_es !== undefined) updates.content_es = content_es;
    if (category !== undefined) updates.category = category;
    if (published !== undefined) updates.published = published;

    const updated = await db
      .update(articlesTable)
      .set(updates as any)
      .where(eq(articlesTable.id, id))
      .returning();
    return res.json(updated[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/articles/:id", ...isSuperAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(articlesTable).where(eq(articlesTable.id, id));
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* ── SMOKE TEST RESULTS ──────────────────────────────────────────── */
router.get("/smoke-tests", ...isSuperAdmin, async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, run_at, environment, total_tests, passed, failed, results, duration_ms
      FROM smoke_test_results
      ORDER BY run_at DESC
      LIMIT 5
    `);
    return res.json({ runs: r.rows });
  } catch (err: any) {
    // Table may not exist yet (first deploy)
    if (err.code === "42P01") return res.json({ runs: [] });
    console.error("[admin] smoke-tests fetch error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/smoke-tests/run", ...isSuperAdmin, async (_req, res) => {
  try {
    const result = await runSmokeTests(true);
    return res.json(result);
  } catch (err: any) {
    console.error("[admin] smoke-tests/run error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
});

/* ── JOBS DEDUPE — DIAGNOSTIC + FORCE-RUN ──────────────────────────
 * GET  /api/admin/jobs-duplicates       → returns current duplicates
 *                                          without modifying anything
 *                                          (pre-flight check Sal can
 *                                          hit before deciding to
 *                                          dedupe)
 * POST /api/admin/jobs-dedupe-run       → executes the same dedupe +
 *                                          unique-index logic that
 *                                          phes-data-migration runs
 *                                          on cold-start, but
 *                                          on-demand. Returns a JSON
 *                                          report (rows removed, ids,
 *                                          index status) so Sal can
 *                                          verify the migration
 *                                          actually did its job.
 *
 * Both endpoints only return rows that look like real duplicates:
 * same (company_id, client_id, scheduled_date, scheduled_time)
 * tuple — including NULL-time matches via COALESCE — and not
 * cancelled. The dedupe matches the migration's deletion logic
 * exactly so the report previews what's about to happen.
 */
router.get("/jobs-duplicates", ...isSuperAdmin, async (_req, res) => {
  try {
    const dupes = await db.execute(sql`
      WITH partitioned AS (
        SELECT id, company_id, client_id, scheduled_date,
               scheduled_time, status, billed_amount,
               assigned_user_id, created_at,
               ROW_NUMBER() OVER (
                 PARTITION BY company_id, client_id, scheduled_date,
                              COALESCE(scheduled_time::text, '00:00:00')
                 ORDER BY created_at DESC NULLS LAST, id DESC
               ) AS rn,
               COUNT(*) OVER (
                 PARTITION BY company_id, client_id, scheduled_date,
                              COALESCE(scheduled_time::text, '00:00:00')
               ) AS slot_size
        FROM jobs
        WHERE status NOT IN ('cancelled')
      )
      SELECT id, company_id, client_id, scheduled_date,
             scheduled_time, status, billed_amount,
             assigned_user_id, created_at,
             rn, slot_size
      FROM partitioned
      WHERE slot_size > 1
      ORDER BY scheduled_date DESC, client_id, rn ASC
      LIMIT 500
    `);
    const rows = dupes.rows as any[];
    return res.json({
      total_rows_in_collisions: rows.length,
      distinct_slots: new Set(rows.map(r => `${r.company_id}|${r.client_id}|${r.scheduled_date}|${r.scheduled_time ?? "null"}`)).size,
      rows,
    });
  } catch (err: any) {
    console.error("[admin] jobs-duplicates error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
});

router.post("/jobs-dedupe-run", ...isSuperAdmin, async (_req, res) => {
  try {
    // Snapshot which rows would be deleted, then delete them and
    // (re)create the partial unique index. Returns the deleted ids
    // so Sal can verify after the call.
    const preview = await db.execute(sql`
      WITH dupes AS (
        SELECT id, scheduled_date, scheduled_time, client_id,
               ROW_NUMBER() OVER (
                 PARTITION BY company_id, client_id, scheduled_date,
                              COALESCE(scheduled_time::text, '00:00:00')
                 ORDER BY created_at DESC NULLS LAST, id DESC
               ) AS rn
        FROM jobs
        WHERE status NOT IN ('cancelled')
      )
      SELECT id, scheduled_date, scheduled_time, client_id
      FROM dupes
      WHERE rn > 1
      ORDER BY scheduled_date DESC, client_id, id
    `);
    const previewRows = preview.rows as any[];

    const deleted = await db.execute(sql`
      WITH dupes AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY company_id, client_id, scheduled_date,
                              COALESCE(scheduled_time::text, '00:00:00')
                 ORDER BY created_at DESC NULLS LAST, id DESC
               ) AS rn
        FROM jobs
        WHERE status NOT IN ('cancelled')
      )
      DELETE FROM jobs
      WHERE id IN (SELECT id FROM dupes WHERE rn > 1)
      RETURNING id
    `);

    await db.execute(sql`DROP INDEX IF EXISTS uq_jobs_no_double_book`);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_no_double_book
        ON jobs (
          company_id,
          client_id,
          scheduled_date,
          (COALESCE(scheduled_time::text, '00:00:00'))
        )
        WHERE status NOT IN ('cancelled')
    `);

    return res.json({
      deleted_count: (deleted.rows ?? []).length,
      deleted_ids: (deleted.rows as any[]).map(r => r.id),
      preview_rows: previewRows,
      index: "uq_jobs_no_double_book recreated",
    });
  } catch (err: any) {
    console.error("[admin] jobs-dedupe-run error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
});

/* ── PAY-MATRIX BACKPAY AUDIT ──────────────────────────────────
 * GET /api/admin/commission-backpay-audit?since=YYYY-MM-DD
 *
 * Returns the financial impact of the pre-pay-matrix bug where
 * commercial jobs (clients.client_type='commercial') with
 * jobs.account_id = NULL were paid at the residential 35% rate
 * instead of commercial $20/hr. Default since-date 2026-01-01.
 *
 * Output:
 *   {
 *     window: { since, scope: 'commercial-completed' },
 *     jobs_affected: int,
 *     paid_out_at_old_rate:    numeric,  // billed_amount × 0.35
 *     should_have_been_paid:   numeric,  // est_hours × 20.00
 *     backpay_owed:            numeric,  // delta (positive = owed to techs)
 *   }
 *
 * Counts jobs with actual_end_time set (i.e., truly completed).
 * Does NOT modify any data — read-only audit. Sal can hand the
 * number to payroll for a one-off correction or run additional_pay
 * entries by hand.
 */
router.get("/commission-backpay-audit", ...isSuperAdmin, async (req, res) => {
  try {
    const since = String(req.query.since ?? "2026-01-01");
    const out = await db.execute(sql`
      SELECT
        COUNT(*)::int                                       AS jobs_affected,
        COALESCE(SUM(j.billed_amount * 0.35), 0)::numeric    AS paid_out_at_old_rate,
        COALESCE(SUM(COALESCE(j.estimated_hours, j.allowed_hours, 0) * 20.00), 0)::numeric
                                                            AS should_have_been_paid,
        COALESCE(SUM(
          (COALESCE(j.estimated_hours, j.allowed_hours, 0) * 20.00)
          - (j.billed_amount * 0.35)
        ), 0)::numeric                                       AS backpay_owed
      FROM jobs j
      JOIN clients c ON c.id = j.client_id
      WHERE c.client_type = 'commercial'
        AND j.account_id IS NULL  -- the routing bug only fired when account_id was missing
        AND j.actual_end_time IS NOT NULL
        AND j.scheduled_date >= ${since}
    `);
    const row = (out.rows[0] as any) ?? {};
    return res.json({
      window: { since, scope: "commercial-completed-no-account" },
      jobs_affected: Number(row.jobs_affected ?? 0),
      paid_out_at_old_rate: Number(row.paid_out_at_old_rate ?? 0),
      should_have_been_paid: Number(row.should_have_been_paid ?? 0),
      backpay_owed: Number(row.backpay_owed ?? 0),
      note: "Backpay = should_have_been_paid - paid_out_at_old_rate. Positive means techs were under-paid; negative means over-paid.",
    });
  } catch (err: any) {
    console.error("[admin] commission-backpay-audit error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
});

/* ── AUDIT LOG HEALTH CHECK ──────────────────────────────────────── */
router.post("/audit-test", ...isSuperAdmin, async (req, res) => {
  try {
    const { logAudit } = await import("../lib/audit.js");
    await logAudit(req, "SMOKE_TEST", "system", "0", null, { test: true, timestamp: new Date().toISOString() });

    const verify = await pool.query(
      `SELECT id, company_id, performed_by, action, target_type, performed_at
       FROM app_audit_log
       WHERE action = 'SMOKE_TEST'
       ORDER BY performed_at DESC LIMIT 1`
    );

    if (!verify.rows[0]) {
      return res.json({ written: false, audit_logging_healthy: false, error: "Row not found after insert" });
    }

    return res.json({
      written: true,
      row: verify.rows[0],
      audit_logging_healthy: true,
    });
  } catch (err: any) {
    console.error("[admin] audit-test error:", err);
    return res.status(500).json({ audit_logging_healthy: false, error: err.message });
  }
});

/* ── [AI.12] Manual zip backfill ──────────────────────────────────
 *
 * AI.10's silent boot-time backfill never ran — Sal saw no log line
 * from the migration. AI.12 replaces it with a manual-trigger
 * endpoint owners can hit directly. No UI, no polling, no batching:
 * synchronous loop, runs all NULL-zip clients in the caller's
 * company, returns full JSON with succeeded / failed / skipped
 * details + sample results + last 10 errors.
 *
 * Auth: owner role only. Scoped to req.auth.companyId so a Phes
 * owner only ever geocodes Phes clients (the spec hardcodes
 * company_id=1; we use req.auth.companyId for future-proof
 * multi-tenancy — same effect for Sal).
 *
 * Cost: ~576 × $0.005 = $2.88 ceiling, and Google's first
 * 10k/month is free. No hard cap per spec.
 *
 * POST /api/admin/run-zip-backfill
 *   curl from browser console (logged in as owner):
 *     fetch('/api/admin/run-zip-backfill', {
 *       method: 'POST',
 *       headers: { Authorization: 'Bearer ' + <token from localStorage> }
 *     }).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2)))
 */
router.post(
  "/run-zip-backfill",
  requireAuth,
  requireRole("owner"),
  async (req, res) => {
    const startedAt = new Date();
    const companyId = req.auth!.companyId!;

    if (!process.env.GOOGLE_MAPS_API_KEY) {
      const msg = "GOOGLE_MAPS_API_KEY not set in env — cannot geocode";
      console.error("[AI.12]", msg);
      return res.status(503).json({ error: "Service Unavailable", message: msg });
    }

    try {
      // Pull every NULL-zip client with their candidate address text.
      // Note: recurring_schedules has no address columns in this schema,
      // so the spec's step 2c is a no-op — we walk clients.address first,
      // then fall back to the most recent jobs.address_street for each
      // client_id. If neither has text, the row gets bucketed as
      // 'no_address_skipped' with no API call attempted.
      const candidates = await db.execute(sql`
        SELECT
          c.id,
          c.first_name, c.last_name,
          c.address AS clients_address,
          c.city    AS clients_city,
          c.state   AS clients_state,
          c.zip     AS clients_zip,
          c.lat     AS clients_lat,
          c.lng     AS clients_lng,
          (SELECT j.address_street FROM jobs j
             WHERE j.client_id = c.id AND j.address_street IS NOT NULL
             ORDER BY j.scheduled_date DESC NULLS LAST, j.id DESC LIMIT 1) AS recent_job_street,
          (SELECT j.address_city FROM jobs j
             WHERE j.client_id = c.id AND j.address_street IS NOT NULL
             ORDER BY j.scheduled_date DESC NULLS LAST, j.id DESC LIMIT 1) AS recent_job_city,
          (SELECT j.address_state FROM jobs j
             WHERE j.client_id = c.id AND j.address_street IS NOT NULL
             ORDER BY j.scheduled_date DESC NULLS LAST, j.id DESC LIMIT 1) AS recent_job_state
        FROM clients c
        WHERE c.company_id = ${companyId} AND c.zip IS NULL
        ORDER BY c.id
      `);

      type SampleRow = {
        client_id: number;
        name: string;
        before: { address: string | null; city: string | null; state: string | null; zip: string | null };
        after: { address: string; zip: string; city: string | null; state: string | null; lat: number; lng: number; formatted_address: string };
      };
      type ErrorRow = { client_id: number; name: string; address_attempted: string; error: string; google_status?: string | null };

      const sampleResults: SampleRow[] = [];
      const errors: ErrorRow[] = [];

      let geocodedSuccess = 0;
      let noAddressSkipped = 0;
      let geocodeFailed = 0;
      let firstCall = true;

      for (const row of candidates.rows as any[]) {
        const id = Number(row.id);
        const name = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
        const street = (row.clients_address ?? row.recent_job_street ?? "")?.trim() || null;
        const city = (row.clients_city ?? row.recent_job_city ?? "")?.trim() || null;
        const state = (row.clients_state ?? row.recent_job_state ?? "")?.trim() || null;

        if (!street && !city) {
          noAddressSkipped++;
          continue;
        }

        const candidateString = [street, city, state].filter(Boolean).join(", ");

        // 100ms throttle between API calls. First call has no preceding wait.
        if (!firstCall) await new Promise(r => setTimeout(r, 100));
        firstCall = false;

        // Inline geocode call — we want full Google response visibility
        // for error reporting. The shared geocodeWithComponents helper
        // swallows the response status, which is exactly what we need
        // to STOP doing per Sal's spec ("we need to SEE failures").
        let googleStatus: string | null = null;
        let geo: {
          lat: number; lng: number; zip: string | null; city: string | null;
          state: string | null; street: string | null; formatted_address: string;
        } | null = null;
        try {
          const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(candidateString)}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
          const r = await fetch(url);
          if (!r.ok) {
            const errMsg = `HTTP ${r.status}`;
            console.error(`[AI.12] HTTP ${r.status} from Google for client_id=${id} address='${candidateString}'`);
            errors.push({ client_id: id, name, address_attempted: candidateString, error: errMsg, google_status: null });
            geocodeFailed++;
            continue;
          }
          const data = await r.json() as any;
          googleStatus = data?.status ?? null;
          if (data.status !== "OK" || !data.results?.length) {
            const errMsg = `Google status=${data.status ?? "unknown"}${data.error_message ? ` msg='${data.error_message}'` : ""}`;
            console.error(`[AI.12] geocode failed for client_id=${id} address='${candidateString}': ${errMsg}`);
            errors.push({ client_id: id, name, address_attempted: candidateString, error: errMsg, google_status: googleStatus });
            geocodeFailed++;
            continue;
          }
          const result = data.results[0];
          const components: Array<{ long_name: string; short_name: string; types: string[] }> = result.address_components ?? [];
          const find = (...types: string[]) => {
            for (const t of types) {
              const c = components.find(x => x.types.includes(t));
              if (c) return c;
            }
            return null;
          };
          const zipComp = find("postal_code");
          if (!zipComp) {
            const errMsg = `Google returned no postal_code component`;
            console.error(`[AI.12] no postal_code for client_id=${id} address='${candidateString}' formatted='${result.formatted_address}'`);
            errors.push({ client_id: id, name, address_attempted: candidateString, error: errMsg, google_status: googleStatus });
            geocodeFailed++;
            continue;
          }
          const cityComp = find("locality", "sublocality", "postal_town");
          const stateComp = find("administrative_area_level_1");
          const numberComp = find("street_number");
          const routeComp = find("route");
          geo = {
            lat: Number(result.geometry.location.lat),
            lng: Number(result.geometry.location.lng),
            zip: String(zipComp.short_name).slice(0, 5),
            city: cityComp?.long_name ?? null,
            state: stateComp?.short_name ?? null,
            street: [numberComp?.long_name, routeComp?.long_name].filter(Boolean).join(" ") || null,
            formatted_address: result.formatted_address,
          };
        } catch (err: any) {
          const errMsg = err?.message ?? String(err);
          console.error(`[AI.12] exception during geocode for client_id=${id} address='${candidateString}':`, err);
          errors.push({ client_id: id, name, address_attempted: candidateString, error: errMsg, google_status: googleStatus });
          geocodeFailed++;
          continue;
        }

        if (!geo || !geo.zip) {
          // Defensive — shouldn't reach here given the early continues above
          geocodeFailed++;
          continue;
        }

        // UPDATE clients. COALESCE(NULLIF(...)) preserves any existing
        // non-empty values. lat/lng overwritten only if currently NULL.
        try {
          await db.execute(sql`
            UPDATE clients
            SET zip   = ${geo.zip},
                city  = COALESCE(NULLIF(city,  ''), ${geo.city ?? city}),
                state = COALESCE(NULLIF(state, ''), ${geo.state ?? state}),
                lat   = COALESCE(lat, ${geo.lat}),
                lng   = COALESCE(lng, ${geo.lng}),
                address = COALESCE(NULLIF(address, ''), ${geo.street ?? geo.formatted_address ?? street})
            WHERE id = ${id} AND company_id = ${companyId} AND zip IS NULL
          `);
          geocodedSuccess++;
          console.log(`[AI.12] client_id=${id} zip_resolved=${geo.zip} from_address='${candidateString}'`);
          if (sampleResults.length < 10) {
            sampleResults.push({
              client_id: id,
              name,
              before: {
                address: row.clients_address ?? null,
                city: row.clients_city ?? null,
                state: row.clients_state ?? null,
                zip: row.clients_zip ?? null,
              },
              after: {
                address: geo.street ?? geo.formatted_address ?? street!,
                zip: geo.zip,
                city: geo.city ?? city,
                state: geo.state ?? state,
                lat: geo.lat,
                lng: geo.lng,
                formatted_address: geo.formatted_address,
              },
            });
          }
        } catch (err: any) {
          const cause = err?.cause ?? err;
          const errMsg = `db_update: ${err?.message ?? String(err)}${cause?.code ? ` code=${cause.code}` : ""}${cause?.detail ? ` detail='${cause.detail}'` : ""}`;
          console.error(`[AI.12] db update failed for client_id=${id}:`, err);
          errors.push({ client_id: id, name, address_attempted: candidateString, error: errMsg, google_status: googleStatus });
          geocodeFailed++;
        }
      }

      const finishedAt = new Date();
      const durationSeconds = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);

      console.log(
        `[AI.12] zip backfill complete company_id=${companyId} ` +
        `processed=${candidates.rows.length} succeeded=${geocodedSuccess} ` +
        `no_address=${noAddressSkipped} failed=${geocodeFailed} ` +
        `duration=${durationSeconds}s`
      );

      return res.json({
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_seconds: durationSeconds,
        clients_processed: candidates.rows.length,
        geocoded_success: geocodedSuccess,
        no_address_skipped: noAddressSkipped,
        geocode_failed: geocodeFailed,
        sample_results: sampleResults,
        errors: errors.slice(-10),
      });
    } catch (err: any) {
      const cause = err?.cause ?? err;
      console.error("[AI.12] fatal error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: err?.message ?? String(err),
        pg_code: cause?.code ?? null,
        pg_detail: cause?.detail ?? null,
      });
    }
  },
);

// [AI.12] Boot-time mount confirmation. If this line doesn't appear in
// Railway logs after a deploy, the route file didn't load → check the
// import chain in routes/index.ts.
console.log("[AI.12] geocode endpoint mounted at POST /api/admin/run-zip-backfill");

export default router;
