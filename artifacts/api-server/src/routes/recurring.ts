import { Router } from "express";
import { db } from "@workspace/db";
import { recurringSchedulesTable, clientsTable, usersTable, jobsTable } from "@workspace/db/schema";
import { eq, and, isNull, lte, sql } from "drizzle-orm";
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
