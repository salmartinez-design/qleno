import { Router } from "express";
import { db } from "@workspace/db";
import { recurringSchedulesTable, clientsTable, usersTable, jobsTable } from "@workspace/db/schema";
import { eq, and, isNull, lte, sql, inArray } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { requireRole } from "../lib/auth.js";
import { generateRecurringJobs, computeOccurrencesForSchedule, generateJobsFromSchedule, DAYS_AHEAD } from "../lib/recurring-jobs.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: recurringSchedulesTable.id,
        customer_id: recurringSchedulesTable.customer_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        frequency: recurringSchedulesTable.frequency,
        day_of_week: recurringSchedulesTable.day_of_week,
        scheduled_time: recurringSchedulesTable.scheduled_time,
        start_date: recurringSchedulesTable.start_date,
        end_date: recurringSchedulesTable.end_date,
        assigned_employee_id: recurringSchedulesTable.assigned_employee_id,
        employee_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        service_type: recurringSchedulesTable.service_type,
        duration_minutes: recurringSchedulesTable.duration_minutes,
        base_fee: recurringSchedulesTable.base_fee,
        notes: recurringSchedulesTable.notes,
        is_active: recurringSchedulesTable.is_active,
        last_generated_date: recurringSchedulesTable.last_generated_date,
        created_at: recurringSchedulesTable.created_at,
      })
      .from(recurringSchedulesTable)
      .leftJoin(clientsTable, eq(clientsTable.id, recurringSchedulesTable.customer_id))
      .leftJoin(usersTable, eq(usersTable.id, recurringSchedulesTable.assigned_employee_id))
      .where(
        and(
          eq(recurringSchedulesTable.company_id, req.auth!.companyId),
          eq(recurringSchedulesTable.is_active, true),
        )
      );
    return res.json(rows);
  } catch (err) {
    console.error("[recurring GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Bulk set the time-of-day across many recurring schedules at once. Imported
// schedules came in with no start time (and clumped on one day), so the office
// needs to fix them in batches instead of one profile at a time. Time-only is
// the safe, high-value bulk op: it sets the template time, cascades to existing
// future scheduled (unlocked) jobs, and generates any missing upcoming visits.
router.patch("/bulk", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { ids, scheduled_time } = req.body as { ids?: number[]; scheduled_time?: string | null };
    const cleanIds = Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) as number[] : [];
    if (cleanIds.length === 0) return res.status(400).json({ error: "ids required" });
    const timeVal = scheduled_time === "" || scheduled_time == null ? null : scheduled_time;

    // 1. Update the schedule templates.
    await db.update(recurringSchedulesTable)
      .set({ scheduled_time: timeVal as any })
      .where(and(eq(recurringSchedulesTable.company_id, companyId), inArray(recurringSchedulesTable.id, cleanIds)));

    // 2. Cascade the time onto existing future scheduled (unlocked) jobs.
    const today = new Date().toISOString().slice(0, 10);
    await db.execute(sql`
      UPDATE jobs SET scheduled_time = ${timeVal}
      WHERE company_id = ${companyId}
        AND recurring_schedule_id = ANY(${sql.raw(`ARRAY[${cleanIds.join(",")}]`)})
        AND scheduled_date >= ${today}
        AND status = 'scheduled'
        AND locked_at IS NULL
    `);

    // 3. Generate any missing upcoming occurrences (idempotent — engine dedupes).
    let generated = 0;
    const schedRows = await db.select().from(recurringSchedulesTable)
      .where(and(eq(recurringSchedulesTable.company_id, companyId), inArray(recurringSchedulesTable.id, cleanIds)));
    const now = new Date();
    const horizon = new Date(now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
    for (const s of schedRows) {
      try {
        const cl = await db.select({ zip: clientsTable.zip }).from(clientsTable)
          .where(eq(clientsTable.id, s.customer_id)).limit(1);
        const gen = await generateJobsFromSchedule(s as any, now, horizon, null, (cl[0]?.zip as any) ?? null);
        generated += gen.created;
      } catch (genErr: any) {
        console.warn("[recurring bulk] generation failed for schedule", s.id, genErr?.message ?? genErr);
      }
    }

    return res.json({ updated: cleanIds.length, jobs_generated: generated });
  } catch (err) {
    console.error("[recurring bulk]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { customer_id, frequency, day_of_week, start_date, end_date, assigned_employee_id, service_type, duration_minutes, base_fee, notes } = req.body;
    if (!customer_id || !frequency || !start_date) {
      return res.status(400).json({ error: "customer_id, frequency, start_date required" });
    }
    const [row] = await db.insert(recurringSchedulesTable).values({
      company_id: req.auth!.companyId,
      customer_id,
      frequency,
      day_of_week: day_of_week || null,
      start_date,
      end_date: end_date || null,
      assigned_employee_id: assigned_employee_id || null,
      service_type: service_type || null,
      duration_minutes: duration_minutes || null,
      base_fee: base_fee || null,
      notes: notes || null,
    }).returning();

    // [scheduling-engine 2026-04-29] Synchronously generate the next
    // 90 days of occurrences so the dispatch board, the client
    // calendar, and the routing system all see the schedule
    // immediately — not after the 2 AM cron. Without this, Sal
    // creates a recurring schedule and stares at an empty board for
    // hours wondering if the engine is broken. The engine's own
    // dedupe (recurring_schedule_id + scheduled_date) makes the
    // sync run idempotent if the cron also fires for these dates.
    let generated = { created: 0, skipped: 0 };
    try {
      const cl = await db.select({ zip: clientsTable.zip })
        .from(clientsTable)
        .where(eq(clientsTable.id, customer_id))
        .limit(1);
      const clientZip = (cl[0]?.zip as any) ?? null;
      const today = new Date();
      const horizon = new Date(today.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
      generated = await generateJobsFromSchedule(
        row as any,
        today,
        horizon,
        null,
        clientZip,
      );
    } catch (genErr: any) {
      // Don't fail the schedule creation if generation hiccups —
      // the nightly cron will catch it. But surface the error in
      // the response so the operator knows to check logs.
      console.warn("[recurring POST] sync generation failed:", genErr?.message ?? genErr);
    }

    return res.status(201).json({ ...row, jobs_generated: generated.created, jobs_skipped: generated.skipped });
  } catch (err) {
    console.error("[recurring POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.put("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { frequency, day_of_week, start_date, end_date, assigned_employee_id, service_type, duration_minutes, base_fee, notes } = req.body;
    const [row] = await db.update(recurringSchedulesTable)
      .set({ frequency, day_of_week, start_date, end_date, assigned_employee_id, service_type, duration_minutes, base_fee, notes })
      .where(and(eq(recurringSchedulesTable.id, id), eq(recurringSchedulesTable.company_id, req.auth!.companyId)))
      .returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (err) {
    console.error("[recurring PUT]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PATCH /api/recurring/:id/monthly-charge — configure monthly-batch billing for
// commercial accounts that bill one lump per month (e.g. Bill Azzarello
// $761.25/mo). Body: { amount?: number|null, mode: 'manual'|'auto_first_visit' }.
//   'manual'           — generated visits are $0; office adds the lump by hand.
//   'auto_first_visit' — engine drops `amount` on the first visit of each month.
// This is the toggle behind Option A (manual, default) ↔ Option B (automatic).
router.patch("/:id/monthly-charge", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { amount, mode } = req.body as { amount?: number | string | null; mode?: string };
    if (mode && mode !== "manual" && mode !== "auto_first_visit") {
      return res.status(400).json({ error: "mode must be 'manual' or 'auto_first_visit'" });
    }
    const [row] = await db.update(recurringSchedulesTable)
      // cast: @workspace/db dist types lag the source schema add of these two
      // columns; runtime (tsx / Railway build) compiles the source fresh.
      .set({
        monthly_charge_amount: amount == null || amount === "" ? null : String(parseFloat(String(amount)).toFixed(2)),
        ...(mode ? { monthly_charge_mode: mode } : {}),
      } as any)
      .where(and(eq(recurringSchedulesTable.id, id), eq(recurringSchedulesTable.company_id, req.auth!.companyId)))
      .returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (err) {
    console.error("[recurring monthly-charge PATCH]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/recurring/:id/occurrence-counts?exclude_job_id=N — counts of past
// vs future jobs in the series, used by the edit-job-modal cascade picker
// to show "Affects this + 63 future + 4 past" previews on each option.
// Future = scheduled_date >= CURRENT_DATE. Past = scheduled_date < CURRENT_DATE.
// Cancelled jobs excluded both ways (they're not "affected" by any cascade).
// exclude_job_id is the anchor (the job the user has open) so it doesn't
// double-count toward future or past — the picker labels treat the anchor
// as "this" separately.
router.get("/:id/occurrence-counts", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    const excludeRaw = req.query.exclude_job_id;
    const excludeJobId = excludeRaw != null ? parseInt(String(excludeRaw)) : null;

    const r = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE j.scheduled_date >= CURRENT_DATE)::int AS future_count,
        COUNT(*) FILTER (WHERE j.scheduled_date <  CURRENT_DATE)::int AS past_count
      FROM jobs j
      WHERE j.recurring_schedule_id = ${id}
        AND j.company_id = ${req.auth!.companyId}
        AND j.status != 'cancelled'
        ${excludeJobId != null && Number.isFinite(excludeJobId)
            ? sql`AND j.id != ${excludeJobId}`
            : sql``}
    `);
    const row = (r.rows[0] ?? {}) as { future_count?: number; past_count?: number };
    return res.json({
      future_count: Number(row.future_count ?? 0),
      past_count: Number(row.past_count ?? 0),
    });
  } catch (err) {
    console.error("[recurring GET occurrence-counts]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.update(recurringSchedulesTable)
      .set({ is_active: false })
      .where(and(eq(recurringSchedulesTable.id, id), eq(recurringSchedulesTable.company_id, req.auth!.companyId)));
    return res.json({ success: true });
  } catch (err) {
    console.error("[recurring DELETE]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/recurring/trigger — admin-triggered job generation (60-day horizon).
//
// Pass ?dry_run=true (or body.dry_run=true) to compute occurrences without
// inserting; response includes planned_inserts, skipped_schedules, and
// would-have-been counts for NULL/zero-fee schedules.
//
// [AI] Pass ?schedule_id=X (or body.schedule_id) to scope the run to a single
// recurring schedule. Useful for smoke-testing AI's multi-day generation
// without re-enabling the engine globally. Both dry-run and live modes
// supported. Live single-schedule mode bypasses the per-tenant engine flag
// (intentional — the user is explicitly opting that schedule into generation).
router.post("/trigger", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const daysAhead = typeof req.body?.days_ahead === "number" ? req.body.days_ahead : 60;
    const dryRun = req.query.dry_run === "true" || req.body?.dry_run === true;
    const scheduleIdRaw = req.query.schedule_id ?? req.body?.schedule_id;
    const scheduleId = scheduleIdRaw != null ? parseInt(String(scheduleIdRaw)) : null;

    // Per-schedule path
    if (scheduleId != null && Number.isFinite(scheduleId)) {
      const rows = await db.select().from(recurringSchedulesTable)
        .where(and(
          eq(recurringSchedulesTable.id, scheduleId),
          eq(recurringSchedulesTable.company_id, companyId),
        ))
        .limit(1);
      if (!rows.length) return res.status(404).json({ error: "Schedule not found" });
      const sched = rows[0] as any;

      const today = new Date();
      const horizon = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);

      // Look up client zip + booking location for compute helper
      let clientZip: string | null = null;
      if (sched.customer_id) {
        const cl = await db.select({ zip: clientsTable.zip })
          .from(clientsTable)
          .where(eq(clientsTable.id, sched.customer_id))
          .limit(1);
        clientZip = (cl[0]?.zip as any) ?? null;
      }

      if (dryRun) {
        const { rows: planned, skipped } = await computeOccurrencesForSchedule(
          sched, today, horizon, null, clientZip,
        );
        return res.json({
          mode: "dry_run",
          schedule_id: scheduleId,
          frequency: sched.frequency,
          day_of_week: sched.day_of_week,
          days_of_week: sched.days_of_week,
          custom_frequency_weeks: sched.custom_frequency_weeks,
          planned_count: planned.length,
          skipped_dedupe: skipped,
          planned: planned.map((r: any) => ({
            scheduled_date: String(r.scheduled_date),
            base_fee: String(r.base_fee),
            // [AI.6] Surface per-occurrence parking decision in dry-run so
            // operators can verify Mon-only / M/W/F / etc. patterns before
            // flipping the engine flag on.
            parking_fee: Boolean(r._parking_fee_applies),
          })),
        });
      }

      const { created, skipped } = await generateJobsFromSchedule(
        sched, today, horizon, null, clientZip,
      );
      return res.json({
        mode: "live",
        schedule_id: scheduleId,
        created,
        skipped_dedupe: skipped,
      });
    }

    // Company-wide path (existing)
    const result = await generateRecurringJobs(companyId, daysAhead, { dryRun });
    return res.json(result);
  } catch (err) {
    console.error("[recurring/trigger]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
