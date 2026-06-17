import { Router } from "express";
import { db } from "@workspace/db";
import { cancellationLogTable, jobsTable, clientsTable, companiesTable, usersTable } from "@workspace/db/schema";
import { eq, and, gte, lte, desc, sql, count } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import {
  resolveCancellationPolicy,
  CANCEL_ACTIONS,
  type CancelAction,
} from "../lib/cancellation-policy.js";
import {
  resolveCancellationTechPay,
  type CancellationTechPayMode,
} from "../lib/cancellation-tech-pay.js";

const router = Router();

const REASON_MAP: Record<string, "customer_request" | "no_show" | "weather" | "emergency" | "other"> = {
  client_request: "customer_request",
  customer_request: "customer_request",
  no_show_client: "no_show",
  no_show_tech: "no_show",
  no_show: "no_show",
  weather: "weather",
  tech_unavailable: "other",
  emergency: "emergency",
  other: "other",
};

/**
 * Map an MC-style cancel_action to the legacy cancel_reason enum so the
 * existing pre-action-picker reports keep working. The action is the
 * source of truth going forward; cancel_reason is for back-compat.
 */
const ACTION_TO_LEGACY_REASON: Record<CancelAction, "customer_request" | "no_show" | "weather" | "emergency" | "other"> = {
  move: "customer_request",
  bump: "other",
  skip: "customer_request",
  cancel: "customer_request",
  lockout: "no_show",
  cancel_service: "customer_request",
};

// GET /api/cancellations/reschedule-count — count reschedule records for a client in last N days
router.get("/reschedule-count", requireAuth, async (req, res) => {
  try {
    const { client_id, days = "90" } = req.query;
    if (!client_id) return res.status(400).json({ error: "client_id required" });
    const companyId = req.auth!.companyId!;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(days as string));
    const cutoffStr = cutoff.toISOString();

    const rows = await db
      .select({ cnt: count() })
      .from(cancellationLogTable)
      .where(and(
        eq(cancellationLogTable.company_id, companyId),
        eq(cancellationLogTable.customer_id, parseInt(client_id as string)),
        gte(cancellationLogTable.cancelled_at, new Date(cutoffStr)),
        sql`${cancellationLogTable.notes} ILIKE 'Rescheduled to%'`,
      ));

    return res.json({ count: rows[0]?.cnt ?? 0 });
  } catch (err) {
    console.error("[cancellations/reschedule-count]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/cancellations — list with filters
router.get("/", requireAuth, async (req, res) => {
  try {
    const { date_from, date_to, customer_id, employee_id } = req.query;
    const conditions: any[] = [eq(cancellationLogTable.company_id, req.auth!.companyId!)];
    if (date_from) conditions.push(sql`${cancellationLogTable.cancelled_at} >= ${date_from as string}`);
    if (date_to) conditions.push(sql`${cancellationLogTable.cancelled_at} <= ${date_to as string}`);
    if (customer_id) conditions.push(eq(cancellationLogTable.customer_id, parseInt(customer_id as string)));

    const rows = await db
      .select({
        id: cancellationLogTable.id,
        job_id: cancellationLogTable.job_id,
        customer_id: cancellationLogTable.customer_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        cancelled_by: cancellationLogTable.cancelled_by,
        cancel_reason: cancellationLogTable.cancel_reason,
        cancelled_at: cancellationLogTable.cancelled_at,
        rescheduled_to_job_id: cancellationLogTable.rescheduled_to_job_id,
        notes: cancellationLogTable.notes,
        refund_issued: cancellationLogTable.refund_issued,
      })
      .from(cancellationLogTable)
      .leftJoin(clientsTable, eq(clientsTable.id, cancellationLogTable.customer_id))
      .where(and(...conditions))
      .orderBy(desc(cancellationLogTable.cancelled_at));

    return res.json(rows);
  } catch (err) {
    console.error("[cancellations GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/cancellations — log a cancellation or reschedule event
router.post("/", requireAuth, async (req, res) => {
  try {
    const { job_id, customer_id, cancel_reason, notes } = req.body;
    if (!job_id || !customer_id || !cancel_reason) {
      return res.status(400).json({ error: "job_id, customer_id, and cancel_reason required" });
    }
    const companyId = req.auth!.companyId!;
    const mappedReason = REASON_MAP[cancel_reason as string] ?? "other";

    const [row] = await db.insert(cancellationLogTable).values({
      company_id: companyId,
      job_id: parseInt(job_id),
      customer_id: parseInt(customer_id),
      cancelled_by: req.auth!.userId,
      cancel_reason: mappedReason,
      notes: notes ?? null,
    }).returning();

    return res.status(201).json(row);
  } catch (err) {
    console.error("[cancellations POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/cancellations/action — MC-style cancellation action.
 *
 * Body:
 *   {
 *     job_id: number,
 *     action: 'move'|'bump'|'skip'|'cancel'|'lockout'|'cancel_service',
 *     notes?: string,
 *     // Optional override of the resolved charge. Operator can dial it
 *     // down or up at the modal (e.g. partial-fee gesture).
 *     charge_amount_override?: number,
 *   }
 *
 * Behavior:
 *   1. Resolves the customer charge via cancellation-policy.ts (action +
 *      per-client fee % + company default + job amount).
 *   2. Flips the job to the right status:
 *        - 'cancel' / 'lockout' → status='complete', billed_amount untouched,
 *          notes appended with the action + fee marker.
 *        - free actions → status='cancelled', billed_amount cleared to 0.
 *   3. If action='cancel_service', sets the recurring schedule's cancelled_at
 *      and cancels future not-yet-completed jobs on the same schedule.
 *   4. Writes the cancellation_log row with cancel_action +
 *      customer_charge_amount + affects_future_jobs.
 *
 * All in one transaction. Returns { ok, log_row, charge_amount,
 * next_status, future_cancelled_count }.
 */
router.post("/action", requireAuth, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const body = req.body as {
    job_id?: number;
    action?: string;
    notes?: string;
    charge_amount_override?: number;
    // Reschedule fields. Required for move/bump (we surface a 400 if
    // missing); ignored for skip/cancel/lockout/cancel_service.
    new_date?: string; // 'YYYY-MM-DD'
    new_time?: string; // 'HH:MM' or 'HH:MM:SS'
    // [reclassify-lockout 2026-06-17] Opt-in: allow a charging action
    // (cancel/lockout) to supersede a job that was already marked complete.
    // Without this flag the handler 409s on complete/cancelled jobs.
    reclassify?: boolean;
  };
  if (!body?.job_id || !Number.isFinite(Number(body.job_id))) {
    return res.status(400).json({ error: "job_id required" });
  }
  const action = body.action as CancelAction | undefined;
  if (!action || !CANCEL_ACTIONS.includes(action)) {
    return res.status(400).json({
      error: "Bad Request",
      message: `action must be one of: ${CANCEL_ACTIONS.join(", ")}`,
    });
  }

  // Reschedule actions REQUIRE a new_date. Validate before we run the
  // policy resolver so the UI gets a clear error.
  const isReschedule = action === "move" || action === "bump";
  if (isReschedule) {
    if (!body.new_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.new_date)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "new_date (YYYY-MM-DD) is required for move/bump actions",
      });
    }
    if (body.new_time != null && !/^\d{2}:\d{2}(:\d{2})?$/.test(body.new_time)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "new_time must be HH:MM or HH:MM:SS when provided",
      });
    }
  }

  // Load job + client + company defaults in one round trip. Tech-pay
  // policy fields piggyback here so we don't need a second query.
  //
  // [BUG-4 / 2026-06-01] LEFT JOIN clients (was INNER). Commercial jobs
  // store the customer identity on jobs.account_id + jobs.account_property_id
  // and leave jobs.client_id NULL — INNER JOIN drops them, the handler
  // returned 404 "Job not found", and the cancel modal bubbled that up
  // for any commercial job. Affected the unassigned lane especially since
  // recently-created commercial jobs land there first. Residential rows
  // still get their cancel/lockout-pct overrides via the join; commercial
  // rows resolve those columns to NULL and fall through to company
  // defaults, which is the existing intended behavior for commercial.
  const ctx = await db.execute(sql`
    SELECT j.id, j.client_id, j.account_id, j.status::text AS status, j.billed_amount, j.base_fee,
           j.notes AS job_notes, j.recurring_schedule_id,
           c.cancel_fee_pct AS client_cancel_pct, c.lockout_fee_pct AS client_lockout_pct,
           c.first_name || ' ' || COALESCE(c.last_name,'') AS client_name,
           co.default_cancel_fee_pct, co.default_lockout_fee_pct,
           co.default_cancel_fee_flat, co.default_lockout_fee_flat,
           co.cancellation_tech_pay_mode, co.cancellation_tech_pay_amount
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      JOIN companies co ON co.id = j.company_id
     WHERE j.id = ${body.job_id} AND j.company_id = ${companyId}
     LIMIT 1
  `);
  const row = ctx.rows[0] as any;
  if (!row) return res.status(404).json({ error: "Not Found", message: "Job not found" });

  // [reclassify-lockout 2026-06-17] A completed job can be reclassified as a
  // charged cancellation/lockout after the fact (office learns the tech was
  // locked out, etc.). Allow it ONLY when: the caller opts in (reclassify),
  // the action actually charges (cancel/lockout — reschedule/skip/service-end
  // make no sense on a finished job), and the job is currently 'complete'
  // (NOT 'cancelled' — a free/voided job has nothing to bill). Everything
  // else keeps the original guard.
  const isCharging = action === "cancel" || action === "lockout";
  const isReclassify = body.reclassify === true && isCharging && row.status === "complete";
  if ((row.status === "complete" || row.status === "cancelled") && !isReclassify) {
    return res.status(409).json({
      error: "Conflict",
      message: `Job already ${row.status}. Cancellation actions only apply to active jobs.`,
    });
  }

  const jobAmount = parseFloat(String(row.billed_amount ?? row.base_fee ?? 0));
  const policy = resolveCancellationPolicy({
    action,
    jobAmount,
    companyDefaultCancelFeePct: parseFloat(String(row.default_cancel_fee_pct ?? 100)),
    companyDefaultLockoutFeePct: parseFloat(String(row.default_lockout_fee_pct ?? 100)),
    companyDefaultCancelFeeFlat: parseFloat(String(row.default_cancel_fee_flat ?? 0)),
    companyDefaultLockoutFeeFlat: parseFloat(String(row.default_lockout_fee_flat ?? 0)),
    clientCancelFeePct: row.client_cancel_pct != null ? parseFloat(String(row.client_cancel_pct)) : null,
    clientLockoutFeePct: row.client_lockout_pct != null ? parseFloat(String(row.client_lockout_pct)) : null,
  });

  // Operator override on the modal — clamp to >= 0, allow setting to 0
  // (waive the fee).
  const finalCharge = body.charge_amount_override != null && Number.isFinite(Number(body.charge_amount_override))
    ? Math.max(0, Number(body.charge_amount_override))
    : policy.charge_amount;

  const feeBasis = policy.fee_flat_applied > 0 ? "flat" : `${policy.fee_pct_applied}%`;
  const actionNote = policy.charges_customer
    ? `[${action}_fee_charged: $${finalCharge.toFixed(2)} (${feeBasis})]`
    : isReschedule
      ? `[${action} to ${body.new_date}${body.new_time ? ` ${body.new_time}` : ""}]`
      : `[${action}]`;
  const operatorNote = body.notes?.trim() ? ` ${body.notes.trim()}` : "";
  const appendedNotes = `${row.job_notes ?? ""}${row.job_notes ? "\n" : ""}${actionNote}${operatorNote}`.trim();

  let futureCancelled = 0;
  let techPayWritten: Array<{ user_id: number; amount: number }> = [];
  const logRow = await db.transaction(async (tx) => {
    // [reclassify-lockout] Re-applying a cancellation to an already-completed
    // job must be idempotent — otherwise repeated taps stack the customer
    // charge log and double the tech's cancellation pay. Before writing the
    // fresh rows, clear any prior charging-cancellation footprint for THIS
    // job: pending cancellation_pay (unpaid, safe to delete) and prior
    // charging cancellation_log rows. Only runs on the reclassify path; the
    // normal first-time flow leaves these untouched.
    if (isReclassify) {
      await tx.execute(sql`
        DELETE FROM additional_pay
         WHERE job_id = ${body.job_id} AND company_id = ${companyId}
           AND type = 'cancellation_pay' AND status = 'pending'
      `);
      await tx.execute(sql`
        DELETE FROM cancellation_log
         WHERE job_id = ${body.job_id} AND company_id = ${companyId}
           AND cancel_action IN ('cancel','lockout')
      `);
    }

    // Update the job row itself. Three flavors:
    //   reschedule → keep status='scheduled', UPDATE scheduled_date (+ time)
    //   complete   → charged cancel/lockout, billed_amount = fee, locked_at = NOW()
    //   cancelled  → free skip / cancel_service, billed_amount = 0
    if (isReschedule) {
      // Move/Bump: just shift the job. status stays 'scheduled' (or
      // 'in_progress' if a tech already clocked in — preserve it).
      // billed_amount stays untouched. The audit log row records the
      // reschedule for reporting; the job itself continues to live.
      if (body.new_time != null) {
        await tx.execute(sql`
          UPDATE jobs
             SET scheduled_date = ${body.new_date}::date,
                 scheduled_time = ${body.new_time}::time,
                 notes = ${appendedNotes}
           WHERE id = ${body.job_id} AND company_id = ${companyId}
        `);
      } else {
        await tx.execute(sql`
          UPDATE jobs
             SET scheduled_date = ${body.new_date}::date,
                 notes = ${appendedNotes}
           WHERE id = ${body.job_id} AND company_id = ${companyId}
        `);
      }
    } else if (policy.next_job_status === "complete") {
      // Charged cancellation — billed_amount becomes the cancellation fee
      // (so revenue reports pick it up cleanly).
      await tx.execute(sql`
        UPDATE jobs
           SET status = 'complete'::job_status,
               billed_amount = ${finalCharge.toFixed(2)},
               notes = ${appendedNotes},
               locked_at = NOW()
         WHERE id = ${body.job_id} AND company_id = ${companyId}
      `);
    } else {
      // Free action — job is cancelled, billed_amount zeroed.
      await tx.execute(sql`
        UPDATE jobs
           SET status = 'cancelled'::job_status,
               billed_amount = 0,
               notes = ${appendedNotes}
         WHERE id = ${body.job_id} AND company_id = ${companyId}
      `);
    }

    // Cancel Service — terminate future occurrences of the same schedule.
    if (policy.affects_future_jobs && row.recurring_schedule_id != null) {
      const futureCancel = await tx.execute(sql`
        UPDATE jobs
           SET status = 'cancelled'::job_status,
               billed_amount = 0,
               notes = COALESCE(notes, '') ||
                       (CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END) ||
                       '[cancel_service_propagated from job ' || ${body.job_id} || ']'
         WHERE recurring_schedule_id = ${row.recurring_schedule_id}
           AND company_id = ${companyId}
           AND status::text IN ('scheduled','in_progress')
           AND id != ${body.job_id}
        RETURNING id
      `);
      futureCancelled = (futureCancel.rows as any[]).length;
      // Also flag the recurring schedule itself. The column is
      // `is_active` (Drizzle naming) — referencing `active` here
      // would 500 the whole transaction.
      await tx.execute(sql`
        UPDATE recurring_schedules
           SET is_active = false
         WHERE id = ${row.recurring_schedule_id} AND company_id = ${companyId}
      `);
    }

    // Cancellation log row — the audit trail. cancel_reason stays for
    // back-compat with existing /reports/cancellations; cancel_action is
    // the new source of truth.
    const [logged] = await tx
      .insert(cancellationLogTable)
      .values({
        company_id: companyId,
        job_id: body.job_id!,
        customer_id: row.client_id,
        cancelled_by: userId,
        cancel_reason: ACTION_TO_LEGACY_REASON[action],
        cancel_action: action,
        customer_charge_amount: finalCharge.toFixed(2),
        affects_future_jobs: policy.affects_future_jobs,
        notes: body.notes ?? null,
      })
      .returning();

    // Tech pay — charging actions still owe the assigned tech(s)
    // something (they were on the schedule, may have driven out, may
    // have shown up to a locked door). Resolve via tenant policy +
    // split across assigned techs.
    if (policy.charges_customer) {
      const techRows = await tx.execute(sql`
        SELECT user_id FROM job_technicians WHERE job_id = ${body.job_id}
      `);
      const techIds = (techRows.rows as Array<{ user_id: number }>).map(r => r.user_id);
      if (techIds.length > 0) {
        const techPay = resolveCancellationTechPay({
          action,
          customerChargeAmount: finalCharge,
          numTechs: techIds.length,
          policy: {
            mode: (row.cancellation_tech_pay_mode ?? "flat") as CancellationTechPayMode,
            amount: parseFloat(String(row.cancellation_tech_pay_amount ?? 60)),
          },
        });
        if (techPay.pays_tech) {
          const noteLabel = `${action === "lockout" ? "Lockout" : "Cancel"} pay — ${row.client_name ?? "Customer"} (job #${body.job_id})`;
          for (const tid of techIds) {
            await tx.execute(sql`
              INSERT INTO additional_pay
                (company_id, user_id, amount, type, notes, job_id, status)
              VALUES
                (${companyId}, ${tid}, ${techPay.pay_per_tech.toFixed(2)},
                 'cancellation_pay', ${noteLabel}, ${body.job_id}, 'pending')
            `);
            techPayWritten.push({ user_id: tid, amount: techPay.pay_per_tech });
          }
        }
      }
    }

    return logged;
  });

  return res.status(201).json({
    ok: true,
    log: logRow,
    charge_amount: finalCharge,
    fee_pct_applied: policy.fee_pct_applied,
    // For reschedule actions, the job stays 'scheduled' regardless of
    // what the policy said (the policy is cancellation-centric and
    // defaults to 'cancelled' for free actions). Surface 'scheduled' so
    // the dispatch refetch knows to keep the chip visible.
    next_status: isReschedule ? "scheduled" : policy.next_job_status,
    future_cancelled_count: futureCancelled,
    tech_pay: techPayWritten,
    // Echo back the reschedule target so the frontend can confirm in
    // the toast / log it for debugging.
    rescheduled_to: isReschedule ? { date: body.new_date, time: body.new_time ?? null } : undefined,
  });
});

export default router;
