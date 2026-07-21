import { Router } from "express";
import { db } from "@workspace/db";
import {
  recurringSubscriptionsTable,
  subscriptionLifecycleEventsTable,
  salesAttributionTable,
  cancellationLogTable,
  clientsTable,
} from "@workspace/db/schema";
import { and, eq, sql, desc, isNull } from "drizzle-orm";
import { requireAuth, requireRole } from "../../lib/auth.js";
import { computeMrr, KNOWN_CADENCES, normalizePersonName } from "../../lib/recurring-mrr.js";
import reportsRouter from "./reports.js";

// [recurring-revenue 2026-07-12] Step 2 — GO-FORWARD CAPTURE.
// The capture layer for the native recurring-revenue engine: attribution on
// sign-up, loss reason on cancel, pause snapshots, and a queue that surfaces
// losses that came through Qleno's EXISTING cancel flow so a human can tag them.
//
// GUARDRAIL (enforced by code review + grep): this module writes ONLY to its
// own additive tables — recurring_subscriptions, subscription_lifecycle_events,
// sales_attribution. It SELECTs from clients / recurring_schedules / jobs /
// cancellation_log and never INSERT/UPDATE/DELETEs them.
//
// PHASE 1 = RESIDENTIAL. The type filter exists everywhere and is hard-set to
// 'residential'; Phase 2 flips RES_ONLY.

const router = Router();
const RES_ONLY = "residential" as const;   // Phase-1 hard-set; Phase 2 = read from req
const CAPTURE_ROLES = ["owner", "admin", "office"] as const;

// Read-only reporting (GET /overview → Data Health + Dashboard) lives in reports.ts.
router.use(reportsRouter);

// Small manual-validation helpers (house convention: no Zod).
const bad = (res: any, msg: string) => res.status(400).json({ error: "Bad Request", message: msg });
const numOrNull = (v: unknown) => (v == null || v === "" ? null : Number(v));

// ── POST /api/recurring/subscriptions ────────────────────────────────────────
// Add-Client "Recurring & Attribution". Writes recurring_subscriptions +
// sales_attribution, keyed by client_id. ZERO columns/writes on `clients`.
router.post("/subscriptions", requireAuth, requireRole(...CAPTURE_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const {
      client_id, branch_id, recurring_schedule_id,
      cadence, rate, price_basis, first_cleaning_date,
      salesperson, salesperson_user_id, subscribed_by,
      is_self_sourced, commission_eligible, no_commission_reason,
    } = req.body ?? {};

    if (!client_id) return bad(res, "client_id is required");
    if (!cadence || !KNOWN_CADENCES.includes(String(cadence))) {
      return bad(res, `cadence must be one of: ${KNOWN_CADENCES.join(", ")}`);
    }
    const eligible = commission_eligible !== false; // default true
    if (!eligible && !["reactivation", "marketing", "other"].includes(String(no_commission_reason))) {
      return bad(res, "no_commission_reason (reactivation|marketing|other) is required when commission_eligible is false");
    }

    // MRR is computed here; a non-computable cadence/rate stores mrr = NULL
    // (surfaced on Data Health), never silently treated as $0.
    const { multiplier, mrr } = computeMrr(cadence, rate);

    const [sub] = await db.insert(recurringSubscriptionsTable).values({
      company_id: companyId,
      branch_id: numOrNull(branch_id),
      client_id: Number(client_id),
      recurring_schedule_id: numOrNull(recurring_schedule_id),
      client_type: RES_ONLY,
      status: "active",
      cadence: String(cadence) as any,
      monthly_multiplier: multiplier != null ? String(multiplier) : null,
      rate: rate != null && rate !== "" ? String(rate) : null,
      price_basis: (["monthly", "per_visit", "unknown"].includes(String(price_basis)) ? String(price_basis) : "unknown") as any,
      mrr: mrr != null ? String(mrr) : null,
      first_cleaning_date: first_cleaning_date || null,
    }).returning();

    const [attr] = await db.insert(salesAttributionTable).values({
      company_id: companyId,
      branch_id: numOrNull(branch_id),
      subscription_id: sub.id,
      client_id: Number(client_id),
      salesperson: normalizePersonName(salesperson),
      salesperson_user_id: numOrNull(salesperson_user_id),
      subscribed_by: normalizePersonName(subscribed_by),
      is_self_sourced: is_self_sourced === true,
      commission_eligible: eligible,
      no_commission_reason: (!eligible ? String(no_commission_reason) : null) as any,
      created_by: req.auth!.userId ?? null,
    }).returning();

    return res.status(201).json({ subscription: sub, attribution: attr, mrr_computable: mrr != null });
  } catch (err) {
    console.error("[recurring/subscriptions POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/recurring/subscriptions/:id/classify-loss ───────────────────────
// Cancel → "Classify Loss". Writes a loss lifecycle event + flips OUR status.
router.post("/subscriptions/:id/classify-loss", requireAuth, requireRole(...CAPTURE_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id));
    const { loss_reason, loss_date, notice_given_date, final_service_date, attachment_url, notes } = req.body ?? {};
    const LOSS = ["price_budget_change", "moved_no_longer_needs", "internal_personal", "service_quality"];
    if (!LOSS.includes(String(loss_reason))) return bad(res, `loss_reason must be one of: ${LOSS.join(", ")}`);

    const [sub] = await db.select().from(recurringSubscriptionsTable)
      .where(and(eq(recurringSubscriptionsTable.id, id), eq(recurringSubscriptionsTable.company_id, companyId))).limit(1);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });

    const [ev] = await db.insert(subscriptionLifecycleEventsTable).values({
      company_id: companyId, branch_id: sub.branch_id, subscription_id: id,
      event_type: "loss",
      loss_reason: String(loss_reason) as any,
      loss_date: loss_date || null,
      notice_given_date: notice_given_date || null,
      final_service_date: final_service_date || null,
      attachment_url: attachment_url || null,
      notes: notes || null,
      source: "captured",
      created_by: req.auth!.userId ?? null,
    }).returning();
    await db.update(recurringSubscriptionsTable).set({ status: "lost", updated_at: new Date() })
      .where(and(eq(recurringSubscriptionsTable.id, id), eq(recurringSubscriptionsTable.company_id, companyId)));

    return res.status(201).json({ event: ev });
  } catch (err) {
    console.error("[recurring/classify-loss POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/recurring/subscriptions/:id/pause ───────────────────────────────
// Snapshots the current cadence + MRR so resume restores exactly.
router.post("/subscriptions/:id/pause", requireAuth, requireRole(...CAPTURE_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id));
    const { pause_reason, pause_end_date, notes } = req.body ?? {};
    if (!["seasonal_pause", "home_renovation"].includes(String(pause_reason))) {
      return bad(res, "pause_reason must be seasonal_pause | home_renovation");
    }
    const [sub] = await db.select().from(recurringSubscriptionsTable)
      .where(and(eq(recurringSubscriptionsTable.id, id), eq(recurringSubscriptionsTable.company_id, companyId))).limit(1);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });

    const [ev] = await db.insert(subscriptionLifecycleEventsTable).values({
      company_id: companyId, branch_id: sub.branch_id, subscription_id: id,
      event_type: "pause",
      pause_reason: String(pause_reason) as any,
      pause_end_date: pause_end_date || null,
      original_cadence: sub.cadence,
      original_mrr: sub.mrr,
      notes: notes || null,
      source: "captured",
      created_by: req.auth!.userId ?? null,
    }).returning();
    await db.update(recurringSubscriptionsTable).set({ status: "paused", updated_at: new Date() })
      .where(and(eq(recurringSubscriptionsTable.id, id), eq(recurringSubscriptionsTable.company_id, companyId)));

    return res.status(201).json({ event: ev });
  } catch (err) {
    console.error("[recurring/pause POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/recurring/subscriptions/:id/resume ──────────────────────────────
// Restores cadence + MRR from the most recent pause snapshot.
router.post("/subscriptions/:id/resume", requireAuth, requireRole(...CAPTURE_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id));
    const [sub] = await db.select().from(recurringSubscriptionsTable)
      .where(and(eq(recurringSubscriptionsTable.id, id), eq(recurringSubscriptionsTable.company_id, companyId))).limit(1);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });

    const [lastPause] = await db.select().from(subscriptionLifecycleEventsTable)
      .where(and(
        eq(subscriptionLifecycleEventsTable.subscription_id, id),
        eq(subscriptionLifecycleEventsTable.company_id, companyId),
        eq(subscriptionLifecycleEventsTable.event_type, "pause"),
      )).orderBy(desc(subscriptionLifecycleEventsTable.created_at)).limit(1);

    const [ev] = await db.insert(subscriptionLifecycleEventsTable).values({
      company_id: companyId, branch_id: sub.branch_id, subscription_id: id,
      event_type: "resume",
      original_cadence: lastPause?.original_cadence ?? sub.cadence,
      original_mrr: lastPause?.original_mrr ?? sub.mrr,
      source: "captured",
      created_by: req.auth!.userId ?? null,
    }).returning();
    await db.update(recurringSubscriptionsTable).set({
      status: "active",
      cadence: lastPause?.original_cadence ?? sub.cadence,
      mrr: lastPause?.original_mrr ?? sub.mrr,
      updated_at: new Date(),
    }).where(and(eq(recurringSubscriptionsTable.id, id), eq(recurringSubscriptionsTable.company_id, companyId)));

    return res.status(201).json({ event: ev });
  } catch (err) {
    console.error("[recurring/resume POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── GET /api/recurring/needs-classification ───────────────────────────────────
// Losses that came through Qleno's EXISTING cancel flow (cancellation_log,
// READ-ONLY) with no classified loss event yet. A human tags each — never
// guessed. Residential only (commercial cancels have null customer_id).
router.get("/needs-classification", requireAuth, requireRole(...CAPTURE_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const branchId = req.query.branch_id != null ? parseInt(String(req.query.branch_id)) : null;
    const rows = await db
      .select({
        cancellation_log_id: cancellationLogTable.id,
        client_id: cancellationLogTable.customer_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        cancelled_at: cancellationLogTable.cancelled_at,
        existing_reason: cancellationLogTable.cancel_reason,
        notes: cancellationLogTable.notes,
      })
      .from(cancellationLogTable)
      .innerJoin(clientsTable, eq(clientsTable.id, cancellationLogTable.customer_id))
      .leftJoin(subscriptionLifecycleEventsTable, eq(subscriptionLifecycleEventsTable.cancellation_log_id, cancellationLogTable.id))
      .where(and(
        eq(cancellationLogTable.company_id, companyId),
        eq(clientsTable.client_type, RES_ONLY),
        isNull(subscriptionLifecycleEventsTable.id),   // not yet classified
        // cancellation_log has no branch column — scope by the client's branch.
        branchId != null ? eq(clientsTable.branch_id, branchId) : sql`true`,
      ))
      .orderBy(desc(cancellationLogTable.cancelled_at))
      .limit(500);
    return res.json({ needs_classification: rows, count: rows.length });
  } catch (err) {
    console.error("[recurring/needs-classification GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── GET /api/recurring/unlinked-jobs-audit ────────────────────────────────────
// [rebooking-fix 2026-07-21] Read-only diagnostic sizing the rebooking bug: how
// many FUTURE scheduled jobs belong to a recurring target (client/account with
// an active-or-paused schedule) yet carry recurring_schedule_id NULL. Those are
// the jobs that — before the engine + cancel-route fixes — got silently rebooked
// when cancelled (the schedule-scoped dedup + skip-tombstone both key on the
// link). A high count means many MaidCentral-imported clients would benefit from
// a recurring_schedule_id backfill. Purely SELECTs; writes nothing.
router.get("/unlinked-jobs-audit", requireAuth, requireRole(...CAPTURE_ROLES), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const summary = await db.execute(sql`
      WITH sched AS (
        SELECT customer_id, account_id
          FROM recurring_schedules
         WHERE company_id = ${companyId} AND (is_active OR paused_by_suspension)
      )
      SELECT
        (SELECT COUNT(*) FROM recurring_schedules
          WHERE company_id = ${companyId} AND (is_active OR paused_by_suspension)) AS active_schedules,
        COUNT(*)                                                     AS future_jobs_for_recurring_targets,
        COUNT(*) FILTER (WHERE j.recurring_schedule_id IS NULL)      AS unlinked_future_jobs,
        COUNT(DISTINCT j.client_id) FILTER (WHERE j.recurring_schedule_id IS NULL AND j.client_id IS NOT NULL)  AS affected_clients
        FROM jobs j
       WHERE j.company_id = ${companyId}
         AND j.status::text IN ('scheduled','in_progress')
         AND COALESCE(j.occurrence_date, j.scheduled_date) >= CURRENT_DATE
         AND (
           j.client_id IN (SELECT customer_id FROM sched WHERE customer_id IS NOT NULL)
           OR j.account_id IN (SELECT account_id FROM sched WHERE account_id IS NOT NULL)
         )
    `);
    const perClient = await db.execute(sql`
      SELECT j.client_id,
             concat(c.first_name, ' ', COALESCE(c.last_name, '')) AS client_name,
             COUNT(*) AS unlinked_future_jobs,
             MIN(COALESCE(j.occurrence_date, j.scheduled_date))::text AS next_unlinked_date
        FROM jobs j
        JOIN clients c ON c.id = j.client_id
       WHERE j.company_id = ${companyId}
         AND j.recurring_schedule_id IS NULL
         AND j.status::text IN ('scheduled','in_progress')
         AND COALESCE(j.occurrence_date, j.scheduled_date) >= CURRENT_DATE
         AND j.client_id IN (
           SELECT customer_id FROM recurring_schedules
            WHERE company_id = ${companyId} AND (is_active OR paused_by_suspension) AND customer_id IS NOT NULL
         )
       GROUP BY j.client_id, c.first_name, c.last_name
       ORDER BY unlinked_future_jobs DESC
       LIMIT 100
    `);
    const s = (summary.rows[0] as any) || {};
    const num = (v: unknown) => parseInt(String(v ?? "0")) || 0;
    return res.json({
      active_schedules: num(s.active_schedules),
      future_jobs_for_recurring_targets: num(s.future_jobs_for_recurring_targets),
      unlinked_future_jobs: num(s.unlinked_future_jobs),
      affected_clients: num(s.affected_clients),
      by_client: perClient.rows,
    });
  } catch (err) {
    console.error("[recurring/unlinked-jobs-audit GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
