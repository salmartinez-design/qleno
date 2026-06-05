/**
 * Cutover 1E — Pay-period routes (provider-neutral).
 *
 * Mounted at /api/pay. Gated to owner / admin / office / super_admin
 * for reads + adjustments; only owner / admin / super_admin may lock,
 * approve, unapprove, export, or change rates. Techs receive 403 by
 * router-level gate.
 *
 * Endpoints:
 *   POST   /periods                       create + auto-compute
 *   GET    /periods                       list (tenant-scoped)
 *   GET    /periods/:id                   detail + summaries
 *   GET    /periods/:id/summary/:userId   per-user detail
 *   POST   /periods/:id/recompute         re-run summary calc
 *   POST   /periods/:id/lock              snapshot for review
 *   POST   /periods/:id/approve           sign off
 *   POST   /periods/:id/unapprove         (logged)
 *   POST   /periods/:id/export            generate CSV
 *   GET    /periods/:id/export-file       download
 *   POST   /adjustments                   add (refuses if period approved)
 *   PATCH  /adjustments/:id               edit (refuses if period approved)
 *   DELETE /adjustments/:id               delete (refuses if period approved)
 *   POST   /rates                         add a dated rate row
 *   GET    /rates?userId=                 rate history
 */
import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  payPeriodsTable,
  payPeriodSummariesTable,
  payAdjustmentsTable,
  employeePayRatesTable,
  usersTable,
  jobClockEventsTable,
  jobsTable,
  clientsTable,
  onMyWayEventsTable,
  mileageRatesTable,
  mileageLegsTable,
} from "@workspace/db/schema";
import {
  detectCarpoolCandidates,
  refusalForTransition,
  MILEAGE_REIMBURSEMENT_ADJUSTMENT_TYPE,
  type MileageLegStatus,
} from "../lib/mileage-approval.js";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import {
  computeHoursForUser,
  minutesToHours,
  type ClockEventForPay,
} from "../lib/pay-hours.js";
import {
  computeSummary,
  dollarsToCents,
  centsToDollarString,
} from "../lib/pay-summary.js";
import { pickRateForDate } from "../lib/pay-rate-lookup.js";
import {
  buildPayExportCsv,
  buildPayExportFilename,
  type PayExportRow,
} from "../lib/pay-export.js";
import {
  computeMileageForLegs,
  type JobCoords,
  type MileageLegInput,
  type DateToCalendarDay,
} from "../lib/mileage-compute.js";
import { pickMileageRateForDate } from "../lib/mileage-rate-lookup.js";
import { getDistanceProvider } from "../lib/distance-provider-factory.js";
import type { DistanceProvider } from "../lib/distance-provider.js";
import {
  reconcileCommissionRows,
  type CommissionInputJob,
} from "../lib/commission-compute.js";
import {
  computePerTechCommissionRows,
  type JobTechRow,
} from "../lib/commission-paytype.js";
import { parseResRatesRow } from "../lib/commission-rates.js";
import { additionalPayTable } from "@workspace/db/schema";

const router = Router();

const officeReadGate = requireRole("owner", "admin", "office", "super_admin");
const adminWriteGate = requireRole("owner", "admin", "super_admin");

router.use(requireAuth, officeReadGate);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadPeriod(
  companyId: number,
  periodId: number,
): Promise<typeof payPeriodsTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(payPeriodsTable)
    .where(
      and(
        eq(payPeriodsTable.company_id, companyId),
        eq(payPeriodsTable.id, periodId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function badRequest(res: Response, message: string, code?: string) {
  return res.status(400).json({ error: "Bad Request", message, code });
}

function notFound(res: Response, message: string) {
  return res.status(404).json({ error: "Not Found", message });
}

function refusedDueToPeriodState(res: Response, status: string) {
  return res.status(409).json({
    error: "Conflict",
    message: `Period is ${status}; required action is not permitted in this state.`,
    code: "period_state_invalid",
  });
}

/**
 * Cutover 2A — Recompute mileage adjustments for a period.
 *
 * Loads every on_my_way row whose `sent_at` falls in the period
 * window, pre-joins client coords for both endpoint jobs, walks the
 * legs through the distance provider via `computeMileageForLegs`, and
 * INSERTs every eligible spec as a pay_adjustments row. Idempotent:
 * the partial unique index `pay_adjustments_mileage_source_uq`
 * collapses re-runs into ON CONFLICT DO NOTHING, so re-invoking this
 * endpoint never double-pays a leg.
 *
 * Exposed for tests via the `provider` parameter; production callers
 * pass the result of `getDistanceProvider(companyId)` so the swap
 * point stays the factory, not the route.
 */
async function recomputeMileageForPeriod(
  companyId: number,
  periodId: number,
  startDate: string,
  endDate: string,
  provider: DistanceProvider,
): Promise<{
  legs_considered: number;
  inserted: number;
  skipped: Record<string, number>;
}> {
  const rateRows = await db
    .select({
      rate: mileageRatesTable.rate,
      effective_date: mileageRatesTable.effective_date,
      end_date: mileageRatesTable.end_date,
    })
    .from(mileageRatesTable)
    .where(eq(mileageRatesTable.company_id, companyId));
  const rateInputs = rateRows.map((r) => ({
    rate: r.rate,
    effective_date: String(r.effective_date),
    end_date: r.end_date != null ? String(r.end_date) : null,
  }));
  const rateForDate = (date: string) => pickMileageRateForDate(rateInputs, date);

  const periodStartTs = new Date(`${startDate}T00:00:00Z`);
  const periodEndTs = new Date(`${endDate}T23:59:59.999Z`);

  // Pull every sent leg in the period. We DO NOT filter on
  // from_job_id at the DB level any more — the compute layer makes
  // the bookend + non-job-waypoint exclusion explicit, and we want
  // skip counts surfaced for the office.
  const legs = await db
    .select({
      id: onMyWayEventsTable.id,
      user_id: onMyWayEventsTable.user_id,
      from_job_id: onMyWayEventsTable.from_job_id,
      to_job_id: onMyWayEventsTable.job_id,
      sent_at: onMyWayEventsTable.sent_at,
    })
    .from(onMyWayEventsTable)
    .where(
      and(
        eq(onMyWayEventsTable.company_id, companyId),
        isNotNull(onMyWayEventsTable.sent_at),
        gte(onMyWayEventsTable.sent_at, periodStartTs),
        lte(onMyWayEventsTable.sent_at, periodEndTs),
      ),
    );

  if (legs.length === 0) {
    return { legs_considered: 0, inserted: 0, skipped: {} };
  }

  const jobIds = new Set<number>();
  for (const leg of legs) {
    if (leg.from_job_id != null) jobIds.add(leg.from_job_id);
    jobIds.add(leg.to_job_id);
  }

  const jobCoordRows = await db
    .select({
      job_id: jobsTable.id,
      lat: clientsTable.lat,
      lng: clientsTable.lng,
    })
    .from(jobsTable)
    .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
    .where(
      and(
        eq(jobsTable.company_id, companyId),
        inArray(jobsTable.id, Array.from(jobIds)),
      ),
    );
  const coordsByJobId = new Map<number, JobCoords>();
  for (const row of jobCoordRows) {
    if (row.lat == null || row.lng == null) continue;
    coordsByJobId.set(row.job_id, {
      lat: Number(row.lat),
      lng: Number(row.lng),
    });
  }

  const legInputs: MileageLegInput[] = legs.map((l) => ({
    id: l.id,
    user_id: l.user_id,
    from_job_id: l.from_job_id,
    to_job_id: l.to_job_id,
    sent_at: l.sent_at,
  }));

  // Phes is America/Chicago. Long-term this becomes a per-tenant
  // setting. Using Intl avoids dragging in a TZ library for one
  // format call.
  const phesTzFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const toCalendarDay: DateToCalendarDay = (d) => phesTzFormatter.format(d);

  const outcomes = await computeMileageForLegs(
    legInputs,
    coordsByJobId,
    rateForDate,
    provider,
    toCalendarDay,
  );

  const skipped: Record<string, number> = {};
  let inserted = 0;
  for (const outcome of outcomes) {
    if (outcome.kind !== "eligible") {
      skipped[outcome.kind] = (skipped[outcome.kind] ?? 0) + 1;
      continue;
    }
    const spec = outcome.spec;
    // INSERT into mileage_legs (status: 'computed'). Nothing flows
    // into pay_adjustments yet — that promotion is 2B. The unique
    // index on (company_id, source_on_my_way_event_id) collapses
    // re-runs into a no-op.
    const result = await db
      .insert(mileageLegsTable)
      .values({
        company_id: companyId,
        pay_period_id: periodId,
        user_id: spec.user_id,
        source_on_my_way_event_id: spec.source_on_my_way_event_id,
        from_job_id: spec.from_job_id,
        to_job_id: spec.to_job_id,
        leg_date: spec.leg_date,
        miles: spec.miles.toFixed(2),
        minutes: spec.minutes,
        rate_per_mile: spec.rate_per_mile.toFixed(4),
        amount: centsToDollarString(spec.amount_cents),
        measurement_source: spec.measurement_source,
        measurement_is_estimated: spec.measurement_is_estimated,
        status: "computed",
      })
      .onConflictDoNothing()
      .returning({ id: mileageLegsTable.id });
    if (result.length > 0) inserted += 1;
  }

  return { legs_considered: legs.length, inserted, skipped };
}

/** Internal: compute + write the per-user summaries for a period. */
async function recomputeSummariesForPeriod(
  companyId: number,
  periodId: number,
  startDate: string,
  endDate: string,
): Promise<{ written: number }> {
  // Pull every active employee in this tenant whose hire_date is <=
  // endDate.
  const employees = await db
    .select({
      id: usersTable.id,
      hire_date: usersTable.hire_date,
      is_active: usersTable.is_active,
    })
    .from(usersTable)
    .where(eq(usersTable.company_id, companyId));

  const eligibleEmployees = employees.filter(
    (e) =>
      e.is_active &&
      e.hire_date != null &&
      String(e.hire_date) <= endDate,
  );
  const userIds = eligibleEmployees.map((e) => e.id);
  if (userIds.length === 0) return { written: 0 };

  // Period boundary timestamps (inclusive start, exclusive end+1 day).
  const periodStartTs = new Date(`${startDate}T00:00:00Z`);
  const periodEndTs = new Date(`${endDate}T23:59:59.999Z`);

  // Pull clock events for these users in the period.
  const events = await db
    .select({
      id: jobClockEventsTable.id,
      job_id: jobClockEventsTable.job_id,
      user_id: jobClockEventsTable.user_id,
      event_type: jobClockEventsTable.event_type,
      event_at: jobClockEventsTable.event_at,
      gps_status: jobClockEventsTable.gps_status,
      latitude: jobClockEventsTable.latitude,
      longitude: jobClockEventsTable.longitude,
      exception_reason: jobClockEventsTable.exception_reason,
      exception_reviewed_at: jobClockEventsTable.exception_reviewed_at,
    })
    .from(jobClockEventsTable)
    .where(
      and(
        eq(jobClockEventsTable.company_id, companyId),
        inArray(jobClockEventsTable.user_id, userIds),
        gte(jobClockEventsTable.event_at, periodStartTs),
        lte(jobClockEventsTable.event_at, periodEndTs),
      ),
    );

  // Rate rows.
  const rates = await db
    .select({
      user_id: employeePayRatesTable.user_id,
      hourly_rate: employeePayRatesTable.hourly_rate,
      effective_date: employeePayRatesTable.effective_date,
      end_date: employeePayRatesTable.end_date,
    })
    .from(employeePayRatesTable)
    .where(
      and(
        eq(employeePayRatesTable.company_id, companyId),
        inArray(employeePayRatesTable.user_id, userIds),
      ),
    );
  const ratesByUser = new Map<number, typeof rates>();
  for (const r of rates) {
    const arr = ratesByUser.get(r.user_id) ?? [];
    arr.push(r);
    ratesByUser.set(r.user_id, arr);
  }

  // Adjustments assigned to this period.
  const adjustments = await db
    .select({
      user_id: payAdjustmentsTable.user_id,
      amount: payAdjustmentsTable.amount,
    })
    .from(payAdjustmentsTable)
    .where(
      and(
        eq(payAdjustmentsTable.company_id, companyId),
        eq(payAdjustmentsTable.pay_period_id, periodId),
      ),
    );
  const adjustmentsByUser = new Map<number, number>();
  for (const a of adjustments) {
    const cents = dollarsToCents(a.amount);
    adjustmentsByUser.set(
      a.user_id,
      (adjustmentsByUser.get(a.user_id) ?? 0) + cents,
    );
  }

  // Group events by user.
  const eventsByUser = new Map<number, ClockEventForPay[]>();
  for (const ev of events) {
    const arr = eventsByUser.get(ev.user_id) ?? [];
    arr.push({
      id: ev.id,
      job_id: ev.job_id,
      user_id: ev.user_id,
      event_type: ev.event_type as "clock_in" | "clock_out",
      event_at: ev.event_at,
      gps_status: ev.gps_status,
      latitude: ev.latitude != null ? Number(ev.latitude) : null,
      longitude: ev.longitude != null ? Number(ev.longitude) : null,
      exception_reason: ev.exception_reason,
      exception_reviewed_at: ev.exception_reviewed_at,
    });
    eventsByUser.set(ev.user_id, arr);
  }

  // Compute + upsert one summary per eligible employee.
  let written = 0;
  for (const emp of eligibleEmployees) {
    const evs = eventsByUser.get(emp.id) ?? [];
    const hours = computeHoursForUser(evs);
    const rateRows = ratesByUser.get(emp.id) ?? [];
    const rate = pickRateForDate(
      rateRows.map((r) => ({
        hourly_rate: r.hourly_rate,
        effective_date: String(r.effective_date),
        end_date: r.end_date != null ? String(r.end_date) : null,
      })),
      endDate,
    );
    const flags = new Set(hours.flags);
    if (rate == null) flags.add("missing_rate");
    const adjCents = adjustmentsByUser.get(emp.id) ?? 0;
    const summary = computeSummary({
      regular_minutes: hours.regular_minutes,
      overtime_minutes: hours.overtime_minutes,
      hourly_rate: rate,
      adjustments_cents: adjCents,
    });
    await db
      .insert(payPeriodSummariesTable)
      .values({
        company_id: companyId,
        pay_period_id: periodId,
        user_id: emp.id,
        regular_hours: summary.regular_hours.toFixed(2),
        overtime_hours: summary.overtime_hours.toFixed(2),
        regular_pay: centsToDollarString(summary.regular_pay_cents),
        overtime_pay: centsToDollarString(summary.overtime_pay_cents),
        adjustments_total: centsToDollarString(summary.adjustments_cents),
        gross_total: centsToDollarString(summary.gross_cents),
        flags: Array.from(flags).sort(),
        computed_at: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          payPeriodSummariesTable.company_id,
          payPeriodSummariesTable.pay_period_id,
          payPeriodSummariesTable.user_id,
        ],
        set: {
          regular_hours: summary.regular_hours.toFixed(2),
          overtime_hours: summary.overtime_hours.toFixed(2),
          regular_pay: centsToDollarString(summary.regular_pay_cents),
          overtime_pay: centsToDollarString(summary.overtime_pay_cents),
          adjustments_total: centsToDollarString(summary.adjustments_cents),
          gross_total: centsToDollarString(summary.gross_cents),
          flags: Array.from(flags).sort(),
          computed_at: new Date(),
        },
      });
    written += 1;
  }

  return { written };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /periods — create + auto-compute
// ─────────────────────────────────────────────────────────────────────────────

router.post("/periods", adminWriteGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const body = req.body as { start_date?: string; end_date?: string; notes?: string };
    if (!body?.start_date || !ISO_DATE_RE.test(body.start_date)) {
      return badRequest(res, "start_date must be YYYY-MM-DD");
    }
    if (!body?.end_date || !ISO_DATE_RE.test(body.end_date)) {
      return badRequest(res, "end_date must be YYYY-MM-DD");
    }
    if (body.end_date < body.start_date) {
      return badRequest(res, "end_date must be on or after start_date");
    }
    const inserted = await db
      .insert(payPeriodsTable)
      .values({
        company_id: companyId,
        start_date: body.start_date,
        end_date: body.end_date,
        notes: body.notes ?? null,
        created_by_user_id: userId,
      })
      .returning();
    const period = inserted[0]!;
    await recomputeSummariesForPeriod(
      companyId,
      period.id,
      body.start_date,
      body.end_date,
    );
    return res.json({ data: period });
  } catch (err: any) {
    if (err?.code === "23505") {
      return res.status(409).json({
        error: "Conflict",
        message: "A pay period with that start/end already exists",
        code: "duplicate_period",
      });
    }
    console.error("[pay] create period error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to create period" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /periods — list
// ─────────────────────────────────────────────────────────────────────────────

router.get("/periods", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const rows = await db
    .select()
    .from(payPeriodsTable)
    .where(eq(payPeriodsTable.company_id, companyId))
    .orderBy(desc(payPeriodsTable.start_date));
  return res.json({ data: rows });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /periods/:id — detail + summaries
// ─────────────────────────────────────────────────────────────────────────────

router.get("/periods/:id", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const periodId = Number(req.params.id);
  if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
  const period = await loadPeriod(companyId, periodId);
  if (!period) return notFound(res, "Period not found");
  const summaries = await db
    .select({
      id: payPeriodSummariesTable.id,
      user_id: payPeriodSummariesTable.user_id,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
      regular_hours: payPeriodSummariesTable.regular_hours,
      overtime_hours: payPeriodSummariesTable.overtime_hours,
      regular_pay: payPeriodSummariesTable.regular_pay,
      overtime_pay: payPeriodSummariesTable.overtime_pay,
      adjustments_total: payPeriodSummariesTable.adjustments_total,
      gross_total: payPeriodSummariesTable.gross_total,
      flags: payPeriodSummariesTable.flags,
      computed_at: payPeriodSummariesTable.computed_at,
    })
    .from(payPeriodSummariesTable)
    .leftJoin(usersTable, eq(payPeriodSummariesTable.user_id, usersTable.id))
    .where(
      and(
        eq(payPeriodSummariesTable.company_id, companyId),
        eq(payPeriodSummariesTable.pay_period_id, periodId),
      ),
    )
    .orderBy(asc(usersTable.last_name), asc(usersTable.first_name));
  return res.json({ data: { period, summaries } });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /periods/:id/summary/:userId — per-user detail
// ─────────────────────────────────────────────────────────────────────────────

router.get("/periods/:id/summary/:userId", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const periodId = Number(req.params.id);
  const userId = Number(req.params.userId);
  if (!Number.isFinite(periodId) || !Number.isFinite(userId)) {
    return badRequest(res, "Invalid ids");
  }
  const period = await loadPeriod(companyId, periodId);
  if (!period) return notFound(res, "Period not found");

  const summaryRows = await db
    .select()
    .from(payPeriodSummariesTable)
    .where(
      and(
        eq(payPeriodSummariesTable.company_id, companyId),
        eq(payPeriodSummariesTable.pay_period_id, periodId),
        eq(payPeriodSummariesTable.user_id, userId),
      ),
    )
    .limit(1);
  if (!summaryRows[0]) return notFound(res, "Summary not found");

  const adjustments = await db
    .select()
    .from(payAdjustmentsTable)
    .where(
      and(
        eq(payAdjustmentsTable.company_id, companyId),
        eq(payAdjustmentsTable.pay_period_id, periodId),
        eq(payAdjustmentsTable.user_id, userId),
      ),
    )
    .orderBy(asc(payAdjustmentsTable.created_at));

  return res.json({
    data: {
      summary: summaryRows[0],
      adjustments,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /periods/:id/recompute — only while open
// ─────────────────────────────────────────────────────────────────────────────

router.post("/periods/:id/recompute", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const periodId = Number(req.params.id);
  if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
  const period = await loadPeriod(companyId, periodId);
  if (!period) return notFound(res, "Period not found");
  if (period.status !== "open") return refusedDueToPeriodState(res, period.status);
  const result = await recomputeSummariesForPeriod(
    companyId,
    periodId,
    String(period.start_date),
    String(period.end_date),
  );
  return res.json({ data: result });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /periods/:id/recompute-mileage — Cutover 2A
// ─────────────────────────────────────────────────────────────────────────────
//
// Walks on_my_way_events whose sent_at lands in the period, asks the
// distance provider for miles + minutes per client-to-client leg, and
// inserts pay_adjustments rows (adjustment_type='mileage'). The
// partial unique index on (company_id, source_on_my_way_event_id)
// makes re-runs no-ops via ON CONFLICT DO NOTHING — safe to call
// repeatedly while the period is open.
//
// Caller flow: POST /periods/:id/recompute-mileage, then
// POST /periods/:id/recompute to fold the new adjustments into each
// employee's summary.

router.post("/periods/:id/recompute-mileage", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const periodId = Number(req.params.id);
  if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
  const period = await loadPeriod(companyId, periodId);
  if (!period) return notFound(res, "Period not found");
  if (period.status !== "open") return refusedDueToPeriodState(res, period.status);
  // Provider is resolved at the factory — the route doesn't name a
  // vendor. Per-tenant cache is layered in there too.
  const result = await recomputeMileageForPeriod(
    companyId,
    periodId,
    String(period.start_date),
    String(period.end_date),
    getDistanceProvider(companyId),
  );
  return res.json({ data: result });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle gates: lock → approve → export
// ─────────────────────────────────────────────────────────────────────────────

router.post("/periods/:id/lock", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const periodId = Number(req.params.id);
  if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
  const period = await loadPeriod(companyId, periodId);
  if (!period) return notFound(res, "Period not found");
  if (period.status !== "open") return refusedDueToPeriodState(res, period.status);
  await db
    .update(payPeriodsTable)
    .set({
      status: "locked",
      locked_at: new Date(),
      locked_by_user_id: userId,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(payPeriodsTable.company_id, companyId),
        eq(payPeriodsTable.id, periodId),
      ),
    );

  // Cutover 4a — commission auto-compute fires at lock time. Idempotent:
  // re-locks (after an unapprove → re-lock) reconcile against existing
  // commission rows in additional_pay rather than duplicating. Failure is
  // logged but NOT fatal — the period is locked either way; the office
  // can re-run via /compute-commission if the auto-fire errored.
  try {
    const result = await computeAndApplyCommission(companyId, period.start_date, period.end_date, periodId);
    console.log(
      `[pay] period ${periodId} (company ${companyId}) auto-commission: ` +
      `inserted=${result.inserted} updated=${result.updated} voided=${result.voided}`,
    );
  } catch (err) {
    console.error(
      `[pay] period ${periodId} (company ${companyId}) auto-commission FAILED (non-fatal):`,
      err,
    );
  }
  return res.json({ data: { id: periodId, status: "locked" } });
});

/**
 * Cutover 4a — explicit re-run endpoint. Useful when:
 *   - The auto-fire on lock errored (and got logged)
 *   - Jobs were retroactively edited (billed_amount, service_type) and
 *     the period is still locked but not yet approved
 *   - Office wants a preview before commit (?dry_run=1 returns the plan
 *     without writing)
 *
 * Refuses on approved / exported periods — once approved, commission is
 * frozen.
 */
router.post("/periods/:id/compute-commission", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const periodId = Number(req.params.id);
  if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
  const period = await loadPeriod(companyId, periodId);
  if (!period) return notFound(res, "Period not found");
  if (period.status === "approved" || period.status === "exported") {
    return refusedDueToPeriodState(res, period.status);
  }
  const dryRun = req.query.dry_run === "1" || req.query.dry_run === "true";
  const result = await computeAndApplyCommission(
    companyId,
    period.start_date,
    period.end_date,
    periodId,
    { dryRun },
  );
  return res.json({ data: { period_id: periodId, dry_run: dryRun, ...result } });
});

/**
 * Pull every job + override for the (company, window), compute commission
 * rows, reconcile against existing `additional_pay` rows, and apply the
 * diff (insert / update / void). All in one transaction so the period
 * never sees a half-written commission state.
 *
 * Returns counts for logging + the dry-run response shape.
 */
async function computeAndApplyCommission(
  companyId: number,
  periodStart: string,
  periodEnd: string,
  periodId: number,
  opts: { dryRun?: boolean } = {},
): Promise<{ inserted: number; updated: number; voided: number; total_amount: number }> {
  const dryRun = opts.dryRun === true;

  // Company config — same waterfall as routes/payroll.ts /detail.
  let compSettings: any = {
    res_tech_pay_pct: 0.35,
    deep_clean_pay_pct: 0.32,
    move_in_out_pay_pct: 0.32,
    commercial_hourly_rate: 20.0,
    commercial_comp_mode: "allowed_hours",
  };
  try {
    const rows = await db.execute(
      sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`,
    );
    if (rows.rows[0]) compSettings = rows.rows[0];
  } catch {
    // Tiered columns absent on this tenant's DB — keep defaults. Same
    // fallback /payroll/detail uses.
  }
  const resRates = parseResRatesRow(compSettings);

  // All completed jobs in the window, with their assigned tech.
  const jobs = await db
    .select({
      id: jobsTable.id,
      assigned_user_id: jobsTable.assigned_user_id,
      service_type: jobsTable.service_type,
      account_id: jobsTable.account_id,
      base_fee: jobsTable.base_fee,
      billed_amount: jobsTable.billed_amount,
      allowed_hours: jobsTable.allowed_hours,
      actual_hours: jobsTable.actual_hours,
      branch_id: jobsTable.branch_id,
      scheduled_date: jobsTable.scheduled_date,
    })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.status, "complete"),
        gte(jobsTable.scheduled_date, periodStart),
        lte(jobsTable.scheduled_date, periodEnd),
      ),
    );

  const jobIds = jobs.map((j) => j.id);
  const commercialCfg = {
    commercial_hourly_rate: parseFloat(String(compSettings.commercial_hourly_rate ?? 20)),
    commercial_comp_mode: (compSettings.commercial_comp_mode === "actual_hours"
      ? "actual_hours"
      : "allowed_hours") as "actual_hours" | "allowed_hours",
  };

  // Per-tech pay-type rows (job_technicians) + per-job final_pay overrides.
  // The parity engine pays each tech by THEIR pay type (fee_split /
  // allowed_hours / hourly) so two techs on one job can differ (MC parity);
  // jobs with no clocked hours fall back to the legacy single-basis path
  // inside computePerTechCommissionRows (no regression).
  const overrides = new Map<string, number>();
  let jobTechs: JobTechRow[] = [];
  const techHoursByKey = new Map<string, number>();
  const serviceTypePctBySlug = new Map<string, number>();
  if (jobIds.length > 0) {
    try {
      const techRows = await db.execute(
        sql`SELECT job_id, user_id, is_primary, pay_type, hourly_rate, commission_pct,
                   pay_deduction_pct, pay_deduction_flat, final_pay
              FROM job_technicians
             WHERE company_id = ${companyId} AND job_id = ANY(${jobIds}::int[])`,
      );
      jobTechs = (techRows.rows as any[]).map((r) => ({
        job_id: Number(r.job_id),
        user_id: Number(r.user_id),
        is_primary: r.is_primary === true,
        pay_type: r.pay_type ?? null,
        hourly_rate: r.hourly_rate ?? null,
        commission_pct: r.commission_pct ?? null,
        pay_deduction_pct: r.pay_deduction_pct ?? null,
        pay_deduction_flat: r.pay_deduction_flat ?? null,
      }));
      for (const r of techRows.rows as any[]) {
        const pay = parseFloat(String(r.final_pay));
        if (r.final_pay != null && Number.isFinite(pay)) {
          overrides.set(`${r.user_id}:${r.job_id}`, pay);
        }
      }
    } catch {
      // job_technicians (or the pay-type columns) may be absent on a
      // freshly-seeded tenant — empty jobTechs falls back to legacy.
    }

    // Per-tech clocked hours (the split denominator + hourly basis).
    try {
      const hourRows = await db.execute(
        sql`SELECT job_id, user_id,
                   SUM(EXTRACT(EPOCH FROM (clock_out_at - clock_in_at)) / 3600.0) AS hours
              FROM timeclock
             WHERE company_id = ${companyId} AND job_id = ANY(${jobIds}::int[])
               AND clock_out_at IS NOT NULL
               AND source = 'punched'
             GROUP BY job_id, user_id`,
      );
      for (const r of hourRows.rows as any[]) {
        const h = parseFloat(String(r.hours));
        if (Number.isFinite(h) && h > 0) techHoursByKey.set(`${r.job_id}:${r.user_id}`, h);
      }
    } catch {
      // No timeclock data → every job falls back to legacy single-basis.
    }
  }

  // Per-service fee-split % (service_types.commission_pct), NULL = company tier.
  try {
    const svcRows = await db.execute(
      sql`SELECT slug, commission_pct FROM service_types
           WHERE company_id = ${companyId} AND commission_pct IS NOT NULL`,
    );
    for (const r of svcRows.rows as any[]) {
      const pct = parseFloat(String(r.commission_pct));
      if (Number.isFinite(pct)) serviceTypePctBySlug.set(String(r.slug).toLowerCase(), pct);
    }
  } catch {
    // service_types.commission_pct column absent — fall back to tiers.
  }

  const computed = computePerTechCommissionRows({
    jobs: jobs as CommissionInputJob[],
    jobTechs,
    techHoursByKey,
    serviceTypePctBySlug,
    resRates,
    commercial: commercialCfg,
    overrides,
  });

  // Existing commission rows in this window — match by job_id IN (...).
  // type='commission' filter keeps tips/bonuses/mileage out of the diff.
  const existingRows = jobIds.length > 0
    ? await db.execute(sql`
        SELECT id, user_id, job_id, amount, voided_at
          FROM additional_pay
         WHERE company_id = ${companyId}
           AND type = 'commission'
           AND job_id = ANY(${jobIds}::int[])
      `)
    : { rows: [] as any[] };
  const existing = (existingRows.rows as any[]).map((r) => ({
    id: r.id,
    user_id: r.user_id,
    job_id: r.job_id,
    amount: r.amount,
    voided_at: r.voided_at,
  }));

  const plan = reconcileCommissionRows({ computed, existing });
  const totalAmount = computed.reduce((s, r) => s + r.amount, 0);

  if (dryRun) {
    return {
      inserted: plan.to_insert.length,
      updated: plan.to_update.length,
      voided: plan.to_void.length,
      total_amount: Math.round(totalAmount * 100) / 100,
    };
  }

  let inserted = 0;
  let updated = 0;
  let voided = 0;
  await db.transaction(async (tx) => {
    if (plan.to_insert.length > 0) {
      const ins = await tx
        .insert(additionalPayTable)
        .values(
          plan.to_insert.map((r) => ({
            company_id: companyId,
            user_id: r.user_id,
            job_id: r.job_id,
            amount: r.amount.toFixed(2),
            type: "commission",
            notes: `[commission_auto] period_id=${periodId} basis=${r.basis}`,
            status: "pending" as const,
          })),
        )
        .returning({ id: additionalPayTable.id });
      inserted = ins.length;
    }
    for (const u of plan.to_update) {
      await tx
        .update(additionalPayTable)
        .set({
          amount: u.new_amount.toFixed(2),
          notes: `[commission_auto] period_id=${periodId} recomputed`,
        })
        .where(eq(additionalPayTable.id, u.id));
      updated++;
    }
    for (const v of plan.to_void) {
      await tx
        .update(additionalPayTable)
        .set({ voided_at: new Date(), notes: `[commission_auto] period_id=${periodId} voided (job no longer in compute set)` })
        .where(eq(additionalPayTable.id, v.id));
      voided++;
    }
  });

  return {
    inserted,
    updated,
    voided,
    total_amount: Math.round(totalAmount * 100) / 100,
  };
}

router.post("/periods/:id/approve", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const periodId = Number(req.params.id);
  if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
  const period = await loadPeriod(companyId, periodId);
  if (!period) return notFound(res, "Period not found");
  if (period.status !== "locked") return refusedDueToPeriodState(res, period.status);
  await db
    .update(payPeriodsTable)
    .set({
      status: "approved",
      approved_at: new Date(),
      approved_by_user_id: userId,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(payPeriodsTable.company_id, companyId),
        eq(payPeriodsTable.id, periodId),
      ),
    );
  return res.json({ data: { id: periodId, status: "approved" } });
});

router.post("/periods/:id/unapprove", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const periodId = Number(req.params.id);
  if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
  const period = await loadPeriod(companyId, periodId);
  if (!period) return notFound(res, "Period not found");
  if (period.status !== "approved") return refusedDueToPeriodState(res, period.status);
  await db
    .update(payPeriodsTable)
    .set({
      status: "locked",
      approved_at: null,
      approved_by_user_id: null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(payPeriodsTable.company_id, companyId),
        eq(payPeriodsTable.id, periodId),
      ),
    );
  console.log(
    `[pay] period ${periodId} (company ${companyId}) UN-APPROVED by user ${req.auth!.userId}`,
  );
  return res.json({ data: { id: periodId, status: "locked" } });
});

router.post("/periods/:id/export", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const periodId = Number(req.params.id);
  if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
  const period = await loadPeriod(companyId, periodId);
  if (!period) return notFound(res, "Period not found");
  if (period.status !== "approved" && period.status !== "exported") {
    return refusedDueToPeriodState(res, period.status);
  }

  const rows = await buildExportRowsForPeriod(companyId, periodId);
  const csv = buildPayExportCsv({
    period_start: String(period.start_date),
    period_end: String(period.end_date),
    rows,
  });
  const filename = buildPayExportFilename(
    String(period.start_date),
    String(period.end_date),
  );

  if (period.status !== "exported") {
    await db
      .update(payPeriodsTable)
      .set({
        status: "exported",
        exported_at: new Date(),
        exported_by_user_id: userId,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(payPeriodsTable.company_id, companyId),
          eq(payPeriodsTable.id, periodId),
        ),
      );
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  return res.send(csv);
});

router.get("/periods/:id/export-file", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const periodId = Number(req.params.id);
  if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
  const period = await loadPeriod(companyId, periodId);
  if (!period) return notFound(res, "Period not found");
  if (period.status !== "exported") {
    return refusedDueToPeriodState(res, period.status);
  }
  const rows = await buildExportRowsForPeriod(companyId, periodId);
  const csv = buildPayExportCsv({
    period_start: String(period.start_date),
    period_end: String(period.end_date),
    rows,
  });
  const filename = buildPayExportFilename(
    String(period.start_date),
    String(period.end_date),
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  return res.send(csv);
});

async function buildExportRowsForPeriod(
  companyId: number,
  periodId: number,
): Promise<PayExportRow[]> {
  const rows = await db
    .select({
      user_id: payPeriodSummariesTable.user_id,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
      external_id: usersTable.id, // External identifier hook; tenants
      // wanting a separate external ID can store it in a tenant-defined
      // user field and we'd swap this column. Defaulting to user.id
      // keeps the export deterministic.
      regular_hours: payPeriodSummariesTable.regular_hours,
      overtime_hours: payPeriodSummariesTable.overtime_hours,
      regular_pay: payPeriodSummariesTable.regular_pay,
      overtime_pay: payPeriodSummariesTable.overtime_pay,
      adjustments_total: payPeriodSummariesTable.adjustments_total,
      gross_total: payPeriodSummariesTable.gross_total,
    })
    .from(payPeriodSummariesTable)
    .leftJoin(usersTable, eq(payPeriodSummariesTable.user_id, usersTable.id))
    .where(
      and(
        eq(payPeriodSummariesTable.company_id, companyId),
        eq(payPeriodSummariesTable.pay_period_id, periodId),
      ),
    )
    .orderBy(asc(usersTable.last_name), asc(usersTable.first_name));
  return rows.map((r) => ({
    employee_identifier: String(r.external_id ?? r.user_id),
    employee_first_name: r.first_name ?? "",
    employee_last_name: r.last_name ?? "",
    regular_hours: Number(r.regular_hours),
    overtime_hours: Number(r.overtime_hours),
    regular_pay_cents: dollarsToCents(r.regular_pay),
    overtime_pay_cents: dollarsToCents(r.overtime_pay),
    adjustments_cents: dollarsToCents(r.adjustments_total),
    gross_cents: dollarsToCents(r.gross_total),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Adjustments
// ─────────────────────────────────────────────────────────────────────────────

router.post("/adjustments", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const body = req.body as {
    user_id?: number;
    pay_period_id?: number | null;
    adjustment_type?: string;
    amount?: number | string;
    note?: string | null;
  };
  if (!body?.user_id || !Number.isFinite(Number(body.user_id))) {
    return badRequest(res, "user_id is required");
  }
  const type = (body?.adjustment_type ?? "").trim();
  if (!type) return badRequest(res, "adjustment_type is required");
  if (body?.amount == null || !Number.isFinite(Number(body.amount))) {
    return badRequest(res, "amount is required");
  }
  if (body.pay_period_id != null) {
    const period = await loadPeriod(companyId, Number(body.pay_period_id));
    if (!period) return notFound(res, "Period not found");
    if (period.status === "approved" || period.status === "exported") {
      return refusedDueToPeriodState(res, period.status);
    }
  }
  const inserted = await db
    .insert(payAdjustmentsTable)
    .values({
      company_id: companyId,
      pay_period_id:
        body.pay_period_id != null ? Number(body.pay_period_id) : null,
      user_id: Number(body.user_id),
      adjustment_type: type,
      amount: Number(body.amount).toFixed(2),
      note: body.note ?? null,
      created_by_user_id: userId,
    })
    .returning();
  return res.json({ data: inserted[0] });
});

router.patch("/adjustments/:id", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return badRequest(res, "Invalid id");
  const existing = await db
    .select()
    .from(payAdjustmentsTable)
    .where(
      and(
        eq(payAdjustmentsTable.company_id, companyId),
        eq(payAdjustmentsTable.id, id),
      ),
    )
    .limit(1);
  if (!existing[0]) return notFound(res, "Adjustment not found");
  if (existing[0].pay_period_id != null) {
    const period = await loadPeriod(companyId, existing[0].pay_period_id);
    if (period && (period.status === "approved" || period.status === "exported")) {
      return refusedDueToPeriodState(res, period.status);
    }
  }
  const body = req.body as {
    adjustment_type?: string;
    amount?: number | string;
    note?: string | null;
  };
  const updates: Partial<typeof payAdjustmentsTable.$inferInsert> = {
    updated_at: new Date(),
  };
  if (body.adjustment_type != null) updates.adjustment_type = body.adjustment_type;
  if (body.amount != null) updates.amount = Number(body.amount).toFixed(2);
  if (body.note !== undefined) updates.note = body.note;
  await db
    .update(payAdjustmentsTable)
    .set(updates)
    .where(
      and(
        eq(payAdjustmentsTable.company_id, companyId),
        eq(payAdjustmentsTable.id, id),
      ),
    );
  return res.json({ data: { id, updated: true } });
});

router.delete("/adjustments/:id", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return badRequest(res, "Invalid id");
  const existing = await db
    .select()
    .from(payAdjustmentsTable)
    .where(
      and(
        eq(payAdjustmentsTable.company_id, companyId),
        eq(payAdjustmentsTable.id, id),
      ),
    )
    .limit(1);
  if (!existing[0]) return notFound(res, "Adjustment not found");
  if (existing[0].pay_period_id != null) {
    const period = await loadPeriod(companyId, existing[0].pay_period_id);
    if (period && (period.status === "approved" || period.status === "exported")) {
      return refusedDueToPeriodState(res, period.status);
    }
  }
  await db
    .delete(payAdjustmentsTable)
    .where(
      and(
        eq(payAdjustmentsTable.company_id, companyId),
        eq(payAdjustmentsTable.id, id),
      ),
    );
  return res.json({ data: { id, deleted: true } });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rates
// ─────────────────────────────────────────────────────────────────────────────

router.post("/rates", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const actingUserId = req.auth!.userId!;
  const body = req.body as {
    user_id?: number;
    hourly_rate?: number | string;
    effective_date?: string;
  };
  if (!body?.user_id || !Number.isFinite(Number(body.user_id))) {
    return badRequest(res, "user_id is required");
  }
  if (body?.hourly_rate == null || !Number.isFinite(Number(body.hourly_rate))) {
    return badRequest(res, "hourly_rate is required");
  }
  if (!body?.effective_date || !ISO_DATE_RE.test(body.effective_date)) {
    return badRequest(res, "effective_date must be YYYY-MM-DD");
  }
  const inserted = await db
    .insert(employeePayRatesTable)
    .values({
      company_id: companyId,
      user_id: Number(body.user_id),
      hourly_rate: Number(body.hourly_rate).toFixed(2),
      effective_date: body.effective_date,
      created_by_user_id: actingUserId,
    })
    .returning();
  return res.json({ data: inserted[0] });
});

router.get("/rates", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = Number(req.query.userId ?? NaN);
  if (!Number.isFinite(userId)) return badRequest(res, "userId is required");
  const rows = await db
    .select()
    .from(employeePayRatesTable)
    .where(
      and(
        eq(employeePayRatesTable.company_id, companyId),
        eq(employeePayRatesTable.user_id, userId),
      ),
    )
    .orderBy(desc(employeePayRatesTable.effective_date));
  return res.json({ data: rows });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cutover 2B — Mileage approval gate
// ─────────────────────────────────────────────────────────────────────────────
//
// The office's review surface for computed mileage_legs. Lifecycle is
// computed → reviewed → applied | discarded, with applied being the
// only state that moves money (creates a pay_adjustments row of type
// 'mileage_reimbursement' and sets the leg's applied_pay_adjustment_id
// bridge). Apply is blocked on approved/exported periods; discard is
// always allowed for non-terminal legs.

router.get(
  "/periods/:id/mileage-legs",
  async (req, res) => {
    const companyId = req.auth!.companyId!;
    const periodId = Number(req.params.id);
    if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
    const period = await loadPeriod(companyId, periodId);
    if (!period) return notFound(res, "Period not found");

    const rows = await db
      .select({
        id: mileageLegsTable.id,
        user_id: mileageLegsTable.user_id,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
        leg_date: mileageLegsTable.leg_date,
        from_job_id: mileageLegsTable.from_job_id,
        to_job_id: mileageLegsTable.to_job_id,
        miles: mileageLegsTable.miles,
        minutes: mileageLegsTable.minutes,
        rate_per_mile: mileageLegsTable.rate_per_mile,
        amount: mileageLegsTable.amount,
        measurement_source: mileageLegsTable.measurement_source,
        measurement_is_estimated: mileageLegsTable.measurement_is_estimated,
        status: mileageLegsTable.status,
        reviewed_at: mileageLegsTable.reviewed_at,
        reviewed_by_user_id: mileageLegsTable.reviewed_by_user_id,
        applied_at: mileageLegsTable.applied_at,
        applied_pay_adjustment_id: mileageLegsTable.applied_pay_adjustment_id,
        discarded_at: mileageLegsTable.discarded_at,
        discard_reason: mileageLegsTable.discard_reason,
      })
      .from(mileageLegsTable)
      .leftJoin(usersTable, eq(mileageLegsTable.user_id, usersTable.id))
      .where(
        and(
          eq(mileageLegsTable.company_id, companyId),
          eq(mileageLegsTable.pay_period_id, periodId),
        ),
      )
      .orderBy(
        asc(mileageLegsTable.leg_date),
        asc(usersTable.last_name),
        asc(mileageLegsTable.id),
      );

    // Per-tech totals + flag detection for the review screen. Only
    // non-discarded legs count toward the "still-to-decide" totals
    // the office uses to triage. Estimated-distance and missing-
    // address shapes get surfaced as flags.
    const byTech = new Map<
      number,
      {
        user_id: number;
        first_name: string | null;
        last_name: string | null;
        computed_count: number;
        reviewed_count: number;
        applied_count: number;
        discarded_count: number;
        pending_amount_cents: number;
        applied_amount_cents: number;
        flag_count: number;
      }
    >();
    for (const r of rows) {
      let bucket = byTech.get(r.user_id);
      if (!bucket) {
        bucket = {
          user_id: r.user_id,
          first_name: r.first_name,
          last_name: r.last_name,
          computed_count: 0,
          reviewed_count: 0,
          applied_count: 0,
          discarded_count: 0,
          pending_amount_cents: 0,
          applied_amount_cents: 0,
          flag_count: 0,
        };
        byTech.set(r.user_id, bucket);
      }
      const cents = dollarsToCents(r.amount);
      if (r.status === "computed") {
        bucket.computed_count += 1;
        bucket.pending_amount_cents += cents;
      } else if (r.status === "reviewed") {
        bucket.reviewed_count += 1;
        bucket.pending_amount_cents += cents;
      } else if (r.status === "applied") {
        bucket.applied_count += 1;
        bucket.applied_amount_cents += cents;
      } else if (r.status === "discarded") {
        bucket.discarded_count += 1;
      }
      if (r.status !== "discarded" && r.measurement_is_estimated) {
        bucket.flag_count += 1;
      }
    }

    return res.json({
      data: {
        period,
        legs: rows,
        techs: Array.from(byTech.values()).sort((a, b) =>
          (a.last_name ?? "").localeCompare(b.last_name ?? ""),
        ),
      },
    });
  },
);

router.get(
  "/periods/:id/mileage-carpool-candidates",
  async (req, res) => {
    const companyId = req.auth!.companyId!;
    const periodId = Number(req.params.id);
    if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
    const period = await loadPeriod(companyId, periodId);
    if (!period) return notFound(res, "Period not found");
    const rows = await db
      .select({
        id: mileageLegsTable.id,
        user_id: mileageLegsTable.user_id,
        leg_date: mileageLegsTable.leg_date,
        from_job_id: mileageLegsTable.from_job_id,
        to_job_id: mileageLegsTable.to_job_id,
        status: mileageLegsTable.status,
      })
      .from(mileageLegsTable)
      .where(
        and(
          eq(mileageLegsTable.company_id, companyId),
          eq(mileageLegsTable.pay_period_id, periodId),
        ),
      );
    const candidates = detectCarpoolCandidates(
      rows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        leg_date: String(r.leg_date),
        from_job_id: r.from_job_id,
        to_job_id: r.to_job_id,
        status: r.status as
          | "computed"
          | "reviewed"
          | "applied"
          | "discarded",
      })),
    );
    return res.json({ data: { candidates } });
  },
);

async function loadLegOrNotFound(
  companyId: number,
  legId: number,
): Promise<typeof mileageLegsTable.$inferSelect | null> {
  const rows = await db
    .select()
    .from(mileageLegsTable)
    .where(
      and(
        eq(mileageLegsTable.company_id, companyId),
        eq(mileageLegsTable.id, legId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

router.post(
  "/mileage-legs/:id/review",
  async (req, res) => {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const legId = Number(req.params.id);
    if (!Number.isFinite(legId)) return badRequest(res, "Invalid id");
    const leg = await loadLegOrNotFound(companyId, legId);
    if (!leg) return notFound(res, "Mileage leg not found");
    const refusal = refusalForTransition(
      leg.status as MileageLegStatus,
      "review",
    );
    if (refusal) {
      return res.status(409).json({
        error: "Conflict",
        message: refusal,
        code: "leg_state_invalid",
      });
    }
    const now = new Date();
    await db
      .update(mileageLegsTable)
      .set({
        status: "reviewed",
        reviewed_at: now,
        reviewed_by_user_id: userId,
        updated_at: now,
      })
      .where(
        and(
          eq(mileageLegsTable.company_id, companyId),
          eq(mileageLegsTable.id, legId),
        ),
      );
    return res.json({ data: { id: legId, status: "reviewed" } });
  },
);

router.post(
  "/mileage-legs/:id/discard",
  async (req, res) => {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const legId = Number(req.params.id);
    if (!Number.isFinite(legId)) return badRequest(res, "Invalid id");
    const body = req.body as { reason?: string };
    const reason = (body?.reason ?? "").trim();
    if (!reason) return badRequest(res, "reason is required for discard");
    const leg = await loadLegOrNotFound(companyId, legId);
    if (!leg) return notFound(res, "Mileage leg not found");
    const refusal = refusalForTransition(
      leg.status as MileageLegStatus,
      "discard",
    );
    if (refusal) {
      return res.status(409).json({
        error: "Conflict",
        message: refusal,
        code: "leg_state_invalid",
      });
    }
    const now = new Date();
    await db
      .update(mileageLegsTable)
      .set({
        status: "discarded",
        discarded_at: now,
        discarded_by_user_id: userId,
        discard_reason: reason,
        updated_at: now,
      })
      .where(
        and(
          eq(mileageLegsTable.company_id, companyId),
          eq(mileageLegsTable.id, legId),
        ),
      );
    return res.json({ data: { id: legId, status: "discarded" } });
  },
);

/** Promote ONE reviewed leg to a pay_adjustments row. Atomic at the
 *  app level: INSERT the adjustment, then UPDATE the leg with the
 *  bridge id + applied state. The leg's status='reviewed' precondition
 *  + the period-state check upstream prevent double-apply (a second
 *  call observes status='applied' and refuses). */
async function applyLegInternal(
  companyId: number,
  actingUserId: number,
  leg: typeof mileageLegsTable.$inferSelect,
): Promise<{ leg_id: number; pay_adjustment_id: number }> {
  const inserted = await db
    .insert(payAdjustmentsTable)
    .values({
      company_id: companyId,
      pay_period_id: leg.pay_period_id,
      user_id: leg.user_id,
      adjustment_type: MILEAGE_REIMBURSEMENT_ADJUSTMENT_TYPE,
      amount: leg.amount, // already numeric(10,2) string from 2A
      note: `mileage_leg #${leg.id}: ${leg.miles} mi × $${leg.rate_per_mile}/mi`,
      created_by_user_id: actingUserId,
    })
    .returning({ id: payAdjustmentsTable.id });
  const adjustmentId = inserted[0]!.id;
  const now = new Date();
  await db
    .update(mileageLegsTable)
    .set({
      status: "applied",
      applied_at: now,
      applied_pay_adjustment_id: adjustmentId,
      updated_at: now,
    })
    .where(
      and(
        eq(mileageLegsTable.company_id, companyId),
        eq(mileageLegsTable.id, leg.id),
      ),
    );
  return { leg_id: leg.id, pay_adjustment_id: adjustmentId };
}

router.post(
  "/mileage-legs/:id/apply",
  adminWriteGate,
  async (req, res) => {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const legId = Number(req.params.id);
    if (!Number.isFinite(legId)) return badRequest(res, "Invalid id");
    const leg = await loadLegOrNotFound(companyId, legId);
    if (!leg) return notFound(res, "Mileage leg not found");

    const refusal = refusalForTransition(
      leg.status as MileageLegStatus,
      "apply",
    );
    if (refusal) {
      return res.status(409).json({
        error: "Conflict",
        message: refusal,
        code: "leg_state_invalid",
      });
    }
    // Period state gate. Mirrors 1E's adjustments write rule: no
    // money moves into a period that's already approved or exported.
    const period = await loadPeriod(companyId, leg.pay_period_id);
    if (!period) return notFound(res, "Period not found");
    if (period.status === "approved" || period.status === "exported") {
      return refusedDueToPeriodState(res, period.status);
    }

    const result = await applyLegInternal(companyId, userId, leg);
    return res.json({ data: { ...result, status: "applied" } });
  },
);

router.post(
  "/periods/:id/mileage-legs/apply-all-reviewed",
  adminWriteGate,
  async (req, res) => {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const periodId = Number(req.params.id);
    if (!Number.isFinite(periodId)) return badRequest(res, "Invalid id");
    const period = await loadPeriod(companyId, periodId);
    if (!period) return notFound(res, "Period not found");
    if (period.status === "approved" || period.status === "exported") {
      return refusedDueToPeriodState(res, period.status);
    }
    const reviewedLegs = await db
      .select()
      .from(mileageLegsTable)
      .where(
        and(
          eq(mileageLegsTable.company_id, companyId),
          eq(mileageLegsTable.pay_period_id, periodId),
          eq(mileageLegsTable.status, "reviewed"),
        ),
      );
    const applied: Array<{ leg_id: number; pay_adjustment_id: number }> = [];
    for (const leg of reviewedLegs) {
      const r = await applyLegInternal(companyId, userId, leg);
      applied.push(r);
    }
    return res.json({
      data: { applied_count: applied.length, applied },
    });
  },
);

export default router;
