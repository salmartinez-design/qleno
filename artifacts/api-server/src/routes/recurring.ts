import { Router } from "express";
import { db } from "@workspace/db";
import { recurringSchedulesTable, clientsTable, usersTable, jobsTable } from "@workspace/db/schema";
import { eq, and, isNull, lte, sql, inArray } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { requireRole } from "../lib/auth.js";
import { generateRecurringJobs, computeOccurrencesForSchedule, generateJobsFromSchedule, DAYS_AHEAD } from "../lib/recurring-jobs.js";
import { createRecurringSchedule } from "../lib/recurring-create.js";
import { commercialPricingMismatch, describeCommercialPricingMismatch, hoursFromMinutes } from "@workspace/pricing-rules";

const router = Router();

// GET /api/recurring
//
// [recurring-scope 2026-08-20] `?customer_id=` was accepted by every caller
// and honored by none — this handler only ever filtered on company. So the
// client profile's Recurring tab asked for one client's schedules and got all
// 103 in the company back, every row wearing whatever client the join landed
// on. Pausing a row from that tab paused a stranger's schedule. Filter on it.
//
// `?include_inactive=1` also returns turned-off schedules. Default stays
// active-only so the company-wide Recurring Schedules page is unchanged; the
// client tab opts in, because a schedule you cannot see is a schedule you
// cannot turn back on.
router.get("/", requireAuth, async (req, res) => {
  try {
    const customerIdRaw = req.query.customer_id;
    const customerId = customerIdRaw != null && String(customerIdRaw).trim() !== ""
      ? parseInt(String(customerIdRaw))
      : null;
    if (customerIdRaw != null && String(customerIdRaw).trim() !== "" && !Number.isInteger(customerId)) {
      return res.status(400).json({ error: "Bad customer_id" });
    }
    const includeInactive = req.query.include_inactive === "1" || req.query.include_inactive === "true";

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
        paused_by_suspension: recurringSchedulesTable.paused_by_suspension,
        last_generated_date: recurringSchedulesTable.last_generated_date,
        created_at: recurringSchedulesTable.created_at,
      })
      .from(recurringSchedulesTable)
      .leftJoin(clientsTable, eq(clientsTable.id, recurringSchedulesTable.customer_id))
      .leftJoin(usersTable, eq(usersTable.id, recurringSchedulesTable.assigned_employee_id))
      .where(
        and(
          eq(recurringSchedulesTable.company_id, req.auth!.companyId),
          ...(includeInactive ? [] : [eq(recurringSchedulesTable.is_active, true)]),
          ...(customerId != null ? [eq(recurringSchedulesTable.customer_id, customerId)] : []),
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
    const {
      customer_id, frequency, day_of_week, days_of_week, start_date, end_date,
      scheduled_time, assigned_employee_id, service_type, duration_minutes, base_fee, notes,
    } = req.body;
    if (!customer_id || !frequency || !start_date) {
      return res.status(400).json({ error: "customer_id, frequency, start_date required" });
    }

    // [mcp-writes 2026-08-19] The body of this handler moved to
    // lib/recurring-create.ts UNCHANGED, so the office UI and the machine
    // surface (/api/v1 -> the MCP tool) create schedules by the same rules:
    // one active schedule per client, the cadence canonicalized, days_of_week
    // clearing day_of_week, and 90 days of visits generated synchronously.
    const result = await createRecurringSchedule({
      companyId: req.auth!.companyId!,
      customer_id, frequency, day_of_week, days_of_week, start_date, end_date,
      scheduled_time, assigned_employee_id, service_type, duration_minutes, base_fee, notes,
    });

    return res.status(201).json({
      ...result.row,
      jobs_generated: result.jobs_generated,
      jobs_skipped: result.jobs_skipped,
    });
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

// GET /api/recurring/:id/anchor — the visit to open when the office wants to
// EDIT this recurring schedule.
//
// [edit-recurring 2026-08-20] Maribel: "We should be able to modify the
// recurrence of a client without having to delete it and create a new one."
//
// She was right, and the reason was a missing door, not a missing engine. The
// client profile's Recurring tab only ever offered Add and Pause, so changing a
// client from Wednesday to Friday meant deleting the schedule and rebuilding it.
// Meanwhile the edit-job modal has done exactly this for months: change the
// frequency / day / time / price on a recurring visit, pick "this and all
// future", and PATCH /api/jobs/:id rewrites the schedule template AND rewrites
// the visits already on the calendar (the hybrid cascade — UPDATE the ones the
// new pattern still wants, DELETE the ones it doesn't, INSERT the dates it now
// needs). That path is tested, it honors locked and in-progress visits, and it
// carries add-ons, parking and techs across.
//
// So the fix is a door onto the engine we already have, NOT a second engine.
// This returns the visit for the modal to open on; the modal cascades from
// there. Duplicating the cascade here would be the second copy that drifts.
//
// Anchor choice: the next visit still on the books. Falls back to the most
// recent past one so a series whose future is empty is still editable —
// 'this_and_future' filters on CURRENT_DATE, not on the anchor's own date, so
// a past anchor still rewrites the right visits.
router.get("/:id/anchor", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    const companyId = req.auth!.companyId;

    const sched = await db.select({ id: recurringSchedulesTable.id })
      .from(recurringSchedulesTable)
      .where(and(eq(recurringSchedulesTable.id, id), eq(recurringSchedulesTable.company_id, companyId)))
      .limit(1);
    if (!sched[0]) return res.status(404).json({ error: "Not found" });

    // Shape matches EditableJob in components/edit-job-modal.tsx.
    //
    // `amount` is only ever read as a fallback for `base_fee` (which is NOT
    // NULL on jobs), so it is sent as the same figure rather than re-deriving
    // dispatch's add-on/rate-mod/discount math here. Two copies of that sum is
    // how displayed totals drift apart.
    const rows = await db.execute(sql`
      SELECT j.id,
             j.client_id,
             concat(c.first_name, ' ', c.last_name)      AS client_name,
             j.recurring_schedule_id,
             rs.days_of_week                             AS recurring_schedule_days_of_week,
             j.service_type,
             j.frequency,
             to_char(j.scheduled_date, 'YYYY-MM-DD')     AS scheduled_date,
             j.scheduled_time,
             COALESCE(ROUND(j.allowed_hours * 60), 0)    AS duration_minutes,
             j.base_fee,
             j.base_fee                                  AS amount,
             j.manual_rate_override,
             j.notes,
             j.status,
             j.locked_at,
             j.assigned_user_id,
             j.hourly_rate,
             j.account_id,
             (j.scheduled_date >= CURRENT_DATE)          AS is_upcoming
        FROM jobs j
        JOIN recurring_schedules rs ON rs.id = j.recurring_schedule_id
        LEFT JOIN clients c ON c.id = j.client_id
       WHERE j.company_id = ${companyId}
         AND j.recurring_schedule_id = ${id}
         AND j.status = 'scheduled'
       ORDER BY (j.scheduled_date >= CURRENT_DATE) DESC,
                CASE WHEN j.scheduled_date >= CURRENT_DATE
                     THEN j.scheduled_date END ASC,
                j.scheduled_date DESC
       LIMIT 1`);

    const job = (rows.rows as any[])[0];
    if (!job) {
      // No visit to hang the modal on. The office can still pause the schedule
      // or add a new one; say so plainly rather than opening an empty modal.
      return res.json({ job: null, reason: "no_visits" });
    }
    return res.json({ job, is_upcoming: job.is_upcoming === true });
  } catch (err) {
    console.error("[recurring anchor GET]", err);
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
// ── Commercial price drift ────────────────────────────────────────────────
//
// [commercial-price-drift 2026-08-18] Every active commercial schedule whose
// stored per-visit price no longer agrees with its own hours × hourly rate.
//
// This exists because National Able cut from 8 hours a day to 4 and nothing
// noticed. Their invoices were right — those bill actual hours — but the price
// on the schedule, and on all 266 visits it had already generated, stayed at the
// 8-hour figure. Qleno reported $53,100 of revenue that was never coming, for
// four months, in silence.
//
// It reports; it does not repair. Whether the price or the hours is the wrong
// number is a question about what the customer agreed to, and only the office
// knows that. Flat-fee schedules — 38 of Phes's 41 — carry no hourly rate and
// never appear here at all.
//
// Office-gated: this is pricing, and pricing is money.
router.get("/pricing-audit", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    // One query, no per-schedule follow-ups. The future-visit count comes from a
    // grouped subquery rather than a lateral per row.
    const rows = await db.execute(sql`
      SELECT rs.id,
             rs.duration_minutes,
             rs.base_fee,
             rs.commercial_hourly_rate,
             rs.manual_rate_override,
             rs.frequency,
             COALESCE(
               a.account_name,
               NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''),
               'Schedule #' || rs.id
             ) AS name,
             COALESCE(fj.future_visits, 0) AS future_visits
        FROM recurring_schedules rs
   LEFT JOIN accounts a ON a.id = rs.account_id AND a.company_id = rs.company_id
   LEFT JOIN clients  c ON c.id = rs.customer_id AND c.company_id = rs.company_id
   LEFT JOIN (
               SELECT recurring_schedule_id, COUNT(*) AS future_visits
                 FROM jobs
                WHERE company_id = ${companyId}
                  AND scheduled_date >= CURRENT_DATE
                  AND status <> 'cancelled'
                  AND recurring_schedule_id IS NOT NULL
             GROUP BY recurring_schedule_id
             ) fj ON fj.recurring_schedule_id = rs.id
       WHERE rs.company_id = ${companyId}
         AND rs.is_active = true
         AND rs.commercial_hourly_rate IS NOT NULL
         AND rs.duration_minutes IS NOT NULL
         AND rs.duration_minutes > 0
         AND COALESCE(rs.manual_rate_override, false) = false
    ORDER BY rs.id
    `);

    // The mismatch test itself lives in @workspace/pricing-rules so this audit
    // and the warning the office sees while editing can never disagree.
    const drifting = rows.rows.flatMap((r: any) => {
      const m = commercialPricingMismatch({
        hours: hoursFromMinutes(r.duration_minutes),
        fee: r.base_fee,
        rate: r.commercial_hourly_rate,
        manualRateOverride: !!r.manual_rate_override,
      });
      if (!m) return [];
      return [{
        schedule_id: Number(r.id),
        name: String(r.name),
        frequency: r.frequency ?? null,
        future_visits: Number(r.future_visits ?? 0),
        hours: m.hours,
        rate: m.rate,
        stored_fee: m.storedFee,
        expected_fee: m.expectedFee,
        difference: m.difference,
        // What the disagreement is worth across everything still on the books.
        future_difference: Math.round(m.difference * Number(r.future_visits ?? 0) * 100) / 100,
        message: describeCommercialPricingMismatch(m),
      }];
    });

    return res.json({
      checked: rows.rows.length,
      drifting_count: drifting.length,
      schedules: drifting,
    });
  } catch (err: any) {
    console.error("GET /recurring/pricing-audit error:", err);
    return res.status(500).json({ error: "Internal Server Error", detail: err?.message ?? String(err) });
  }
});

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

// DELETE /api/recurring/:id — turn a recurring schedule OFF.
//
// [recurring-scope 2026-08-20] The client tab called this from a button
// labelled "Pause", which it is not. It clears is_active with no confirm, and
// before this change nothing anywhere read a turned-off schedule back, so the
// row simply vanished and there was no way to undo it.
//
// The real pause is the Service hold (routes/client-suspension.ts), which sets
// is_active = false AND paused_by_suspension = true, then resumes ONLY the
// schedules carrying that flag. This route deliberately does not set the flag,
// so a hold's resume never revives a schedule the office turned off on purpose.
// Keep it that way. Un-turn-off is POST /:id/reactivate below.
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

// POST /api/recurring/:id/reactivate — turn a schedule back ON.
//
// [recurring-scope 2026-08-20] The other half of the DELETE above. Refuses a
// schedule that a service hold paused: those belong to the hold and must come
// back through Resume, or the hold's own resume rule ("re-activate ONLY the
// schedules this suspension paused") stops describing reality.
router.post("/:id/reactivate", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id" });
    const companyId = req.auth!.companyId;

    const rows = await db.select({
      id: recurringSchedulesTable.id,
      is_active: recurringSchedulesTable.is_active,
      paused_by_suspension: recurringSchedulesTable.paused_by_suspension,
    })
      .from(recurringSchedulesTable)
      .where(and(eq(recurringSchedulesTable.id, id), eq(recurringSchedulesTable.company_id, companyId)))
      .limit(1);
    if (!rows[0]) return res.status(404).json({ error: "Not found" });

    if (rows[0].paused_by_suspension) {
      return res.status(409).json({
        error: "This schedule is paused by a service hold. End the hold on the client's profile to start it again.",
        reason: "paused_by_suspension",
      });
    }
    if (rows[0].is_active) return res.json({ success: true, already_active: true });

    await db.update(recurringSchedulesTable)
      .set({ is_active: true })
      .where(and(eq(recurringSchedulesTable.id, id), eq(recurringSchedulesTable.company_id, companyId)));
    return res.json({ success: true });
  } catch (err) {
    console.error("[recurring reactivate]", err);
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
