/**
 * Cutover 3A — Availability + leave catalog + requests + blackouts.
 *
 * Mounted at /api/leave. Role gating:
 *   - Reads (catalog, balances, requests list) for office tier
 *     (owner/admin/office/super_admin).
 *   - Catalog CRUD + blackouts + decisions (approve/deny/cancel)
 *     for admin tier (owner/admin/super_admin).
 *   - Employee endpoints (own balance, own availability, own
 *     request submit) for any authenticated tenant user, scoped
 *     to req.auth.userId.
 *
 * Endpoints:
 *
 *   GET    /types                          office: list catalog
 *   POST   /types                          admin: create bucket
 *   PATCH  /types/:id                      admin: edit bucket
 *
 *   GET    /balances/me                    employee: own balances
 *   GET    /balances?userId=               office: any employee's balances
 *
 *   GET    /availability/me                employee: own grid
 *   PUT    /availability/me                employee: write own grid
 *   GET    /availability?userId=           office: any employee's grid
 *
 *   POST   /requests                       employee: submit
 *   GET    /requests                       office: list pending + decided
 *   GET    /requests/mine                  employee: own requests
 *   POST   /requests/:id/approve           admin: approve
 *   POST   /requests/:id/deny              admin: deny
 *   POST   /requests/:id/cancel            admin (or own pending): cancel
 *
 *   GET    /blackouts                      office: list
 *   POST   /blackouts                      admin: create
 *   DELETE /blackouts/:id                  admin: remove
 *
 *   GET    /alerts/use-it-or-lose-it       office: aggregated alerts for
 *                                          tenant employees (per policy)
 *
 *   POST   /unexcused/record               office: record an unexcused
 *                                          attendance entry; runs the
 *                                          cumulative-hours ladder watcher.
 */
import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  leaveTypesTable,
  employeeLeaveBalancesTable,
  leaveRequestsTable,
  leaveBlackoutsTable,
  employeeAvailabilityTable,
  employeeLeaveUsageTable,
  companyLeavePolicyTable,
  usersTable,
} from "@workspace/db/schema";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { notifyUserAsync } from "../lib/push.js";
import {
  computeCurrentBalance,
  isPastWaitingPeriod,
  round2,
} from "../lib/leave-balance.js";
import {
  checkRequestable,
  checkWaitingPeriod,
  checkAdvanceNotice,
  checkBalance,
  detectBlackoutOverlap,
  type BucketForValidation,
  type BlackoutWindow,
} from "../lib/leave-request-rules.js";
import {
  notifyLeaveSubmitted,
  notifyLeaveDecision,
} from "../lib/leave-notifications.js";
import { writeApprovedLeavePay } from "../lib/leave-pay.js";
import { recordUnexcusedEntryAndDriveLadder } from "../lib/unexcused-ladder-writer.js";
import { evaluateUseItOrLoseItAlert } from "../lib/leave-alerts.js";
import {
  resolveCascadeAllocation,
  type CascadeBucketInput,
} from "../lib/leave-cascade.js";
import { randomUUID } from "node:crypto";

const router = Router();

const officeReadGate = requireRole(
  "owner",
  "admin",
  "office",
  "super_admin",
);
const adminWriteGate = requireRole("owner", "admin", "super_admin");

router.use(requireAuth);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(res: Response, message: string, code?: string) {
  return res.status(400).json({ error: "Bad Request", message, code });
}
function notFound(res: Response, message: string) {
  return res.status(404).json({ error: "Not Found", message });
}
function forbidden(res: Response, message: string) {
  return res.status(403).json({ error: "Forbidden", message });
}

async function findBucket(companyId: number, id: number) {
  const rows = await db
    .select()
    .from(leaveTypesTable)
    .where(
      and(
        eq(leaveTypesTable.company_id, companyId),
        eq(leaveTypesTable.id, id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function loadBalance(
  companyId: number,
  userId: number,
  leaveTypeId: number,
) {
  const rows = await db
    .select()
    .from(employeeLeaveBalancesTable)
    .where(
      and(
        eq(employeeLeaveBalancesTable.company_id, companyId),
        eq(employeeLeaveBalancesTable.user_id, userId),
        eq(employeeLeaveBalancesTable.leave_type_id, leaveTypeId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function ensureBalanceRow(
  companyId: number,
  userId: number,
  leaveTypeId: number,
): Promise<typeof employeeLeaveBalancesTable.$inferSelect> {
  const existing = await loadBalance(companyId, userId, leaveTypeId);
  if (existing) return existing;
  const inserted = await db
    .insert(employeeLeaveBalancesTable)
    .values({
      company_id: companyId,
      user_id: userId,
      leave_type_id: leaveTypeId,
      granted_hours: "0",
      used_hours: "0",
    })
    .returning();
  return inserted[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

router.get("/types", officeReadGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const rows = await db
    .select()
    .from(leaveTypesTable)
    .where(eq(leaveTypesTable.company_id, companyId))
    .orderBy(asc(leaveTypesTable.display_name));
  return res.json({ data: rows });
});

router.post("/types", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const body = req.body as Partial<typeof leaveTypesTable.$inferInsert>;
  if (!body?.slug || !body?.display_name) {
    return bad(res, "slug + display_name required");
  }
  try {
    const inserted = await db
      .insert(leaveTypesTable)
      .values({
        company_id: companyId,
        slug: body.slug,
        display_name: body.display_name,
        is_paid: body.is_paid ?? true,
        annual_cap_hours: String(body.annual_cap_hours ?? "0"),
        accrual_mode: body.accrual_mode ?? "flat_grant",
        accrual_rate: String(body.accrual_rate ?? "0"),
        waiting_period_days: body.waiting_period_days ?? 0,
        carryover_allowed: body.carryover_allowed ?? false,
        documentation_required: body.documentation_required ?? false,
        requestable: body.requestable ?? true,
        exempt_from_blackout: body.exempt_from_blackout ?? false,
      })
      .returning();
    return res.json({ data: inserted[0] });
  } catch (err: any) {
    if (err?.code === "23505") {
      return res
        .status(409)
        .json({ error: "Conflict", message: "Slug already in use" });
    }
    throw err;
  }
});

router.patch("/types/:id", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return bad(res, "Invalid id");
  const existing = await findBucket(companyId, id);
  if (!existing) return notFound(res, "Bucket not found");
  const body = req.body as Partial<typeof leaveTypesTable.$inferInsert>;
  const updates: Partial<typeof leaveTypesTable.$inferInsert> = {
    updated_at: new Date(),
  };
  // slug is IMMUTABLE after creation — never accept it on PATCH.
  if (body.display_name != null) updates.display_name = body.display_name;
  if (body.is_paid != null) updates.is_paid = body.is_paid;
  if (body.annual_cap_hours != null)
    updates.annual_cap_hours = String(body.annual_cap_hours);
  if (body.accrual_mode != null) updates.accrual_mode = body.accrual_mode;
  if (body.accrual_rate != null) updates.accrual_rate = String(body.accrual_rate);
  if (body.waiting_period_days != null)
    updates.waiting_period_days = body.waiting_period_days;
  if (body.carryover_allowed != null)
    updates.carryover_allowed = body.carryover_allowed;
  if (body.documentation_required != null)
    updates.documentation_required = body.documentation_required;
  if (body.requestable != null) updates.requestable = body.requestable;
  if (body.exempt_from_blackout != null)
    updates.exempt_from_blackout = body.exempt_from_blackout;
  if (body.active != null) updates.active = body.active;
  await db
    .update(leaveTypesTable)
    .set(updates)
    .where(
      and(
        eq(leaveTypesTable.company_id, companyId),
        eq(leaveTypesTable.id, id),
      ),
    );
  return res.json({ data: { id, updated: true } });
});

// ─────────────────────────────────────────────────────────────────────────────
// Balances
// ─────────────────────────────────────────────────────────────────────────────

async function buildBalancesForUser(
  companyId: number,
  userId: number,
): Promise<
  Array<{
    leave_type_id: number;
    display_name: string;
    slug: string;
    accrual_mode: string;
    granted: number;
    used: number;
    available: number;
    annual_cap_hours: number;
    waiting_period_days: number;
    past_waiting_period: boolean;
  }>
> {
  const buckets = await db
    .select()
    .from(leaveTypesTable)
    .where(
      and(
        eq(leaveTypesTable.company_id, companyId),
        eq(leaveTypesTable.active, true),
      ),
    );
  const userRows = await db
    .select({ id: usersTable.id, hire_date: usersTable.hire_date })
    .from(usersTable)
    .where(
      and(eq(usersTable.company_id, companyId), eq(usersTable.id, userId)),
    )
    .limit(1);
  const hireDate = userRows[0]?.hire_date
    ? String(userRows[0].hire_date)
    : null;
  const today = new Date().toISOString().slice(0, 10);

  const out = [];
  for (const b of buckets) {
    const bal = await ensureBalanceRow(companyId, userId, b.id);
    const computed = computeCurrentBalance({
      accrual_mode: b.accrual_mode as
        | "flat_grant"
        | "accrue_per_hours"
        | "office_recorded",
      granted_hours: Number(bal.granted_hours),
      used_hours: Number(bal.used_hours),
      annual_cap_hours: Number(b.annual_cap_hours),
    });
    const past = hireDate
      ? isPastWaitingPeriod(hireDate, b.waiting_period_days, today)
      : false;
    out.push({
      leave_type_id: b.id,
      display_name: b.display_name,
      slug: b.slug,
      accrual_mode: b.accrual_mode,
      granted: computed.granted,
      used: computed.used,
      available: computed.available,
      annual_cap_hours: Number(b.annual_cap_hours),
      waiting_period_days: b.waiting_period_days,
      past_waiting_period: past,
    });
  }
  return out;
}

router.get("/balances/me", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const data = await buildBalancesForUser(companyId, userId);
  return res.json({ data });
});

router.get("/balances", officeReadGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = Number(req.query.userId);
  if (!Number.isFinite(userId)) return bad(res, "userId required");
  const data = await buildBalancesForUser(companyId, userId);
  return res.json({ data });
});

// ─────────────────────────────────────────────────────────────────────────────
// Availability
// ─────────────────────────────────────────────────────────────────────────────

async function loadAvailability(companyId: number, userId: number) {
  return db
    .select()
    .from(employeeAvailabilityTable)
    .where(
      and(
        eq(employeeAvailabilityTable.company_id, companyId),
        eq(employeeAvailabilityTable.user_id, userId),
      ),
    )
    .orderBy(
      asc(employeeAvailabilityTable.day_of_week),
      asc(employeeAvailabilityTable.start_time),
    );
}

router.get("/availability/me", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  return res.json({ data: await loadAvailability(companyId, userId) });
});

router.put("/availability/me", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const body = req.body as {
    blocks: Array<{
      day_of_week: number;
      start_time: string;
      end_time: string;
      available: boolean;
      note?: string | null;
    }>;
  };
  if (!body?.blocks || !Array.isArray(body.blocks)) {
    return bad(res, "blocks[] required");
  }
  for (const b of body.blocks) {
    if (
      !Number.isInteger(b.day_of_week) ||
      b.day_of_week < 0 ||
      b.day_of_week > 6
    ) {
      return bad(res, "day_of_week must be 0..6");
    }
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(b.start_time))
      return bad(res, "start_time must be HH:MM[:SS]");
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(b.end_time))
      return bad(res, "end_time must be HH:MM[:SS]");
  }
  // Replace-all semantics: simpler than a diff, the grid is small.
  await db
    .delete(employeeAvailabilityTable)
    .where(
      and(
        eq(employeeAvailabilityTable.company_id, companyId),
        eq(employeeAvailabilityTable.user_id, userId),
      ),
    );
  if (body.blocks.length > 0) {
    await db.insert(employeeAvailabilityTable).values(
      body.blocks.map((b) => ({
        company_id: companyId,
        user_id: userId,
        day_of_week: b.day_of_week,
        start_time: b.start_time,
        end_time: b.end_time,
        available: b.available,
        note: b.note ?? null,
      })),
    );
  }
  return res.json({ data: await loadAvailability(companyId, userId) });
});

router.get("/availability", officeReadGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = Number(req.query.userId);
  if (!Number.isFinite(userId)) return bad(res, "userId required");
  return res.json({ data: await loadAvailability(companyId, userId) });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────────────

async function buildBucketForValidation(
  row: typeof leaveTypesTable.$inferSelect,
): Promise<BucketForValidation> {
  return {
    requestable: row.requestable,
    waiting_period_days: row.waiting_period_days,
    accrual_mode: row.accrual_mode as BucketForValidation["accrual_mode"],
    exempt_from_blackout: row.exempt_from_blackout,
    display_name: row.display_name,
  };
}

router.post("/requests", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const body = req.body as {
    leave_type_id?: number;
    start_date?: string;
    end_date?: string;
    hours?: number | string;
    note?: string | null;
  };
  if (!body?.leave_type_id || !Number.isFinite(Number(body.leave_type_id)))
    return bad(res, "leave_type_id required");
  if (!body?.start_date || !ISO_DATE_RE.test(body.start_date))
    return bad(res, "start_date YYYY-MM-DD required");
  if (!body?.end_date || !ISO_DATE_RE.test(body.end_date))
    return bad(res, "end_date YYYY-MM-DD required");
  if (body.end_date < body.start_date)
    return bad(res, "end_date must be >= start_date");
  const hours = Number(body.hours);
  if (!Number.isFinite(hours) || hours <= 0) return bad(res, "hours must be positive");

  const bucket = await findBucket(companyId, Number(body.leave_type_id));
  if (!bucket) return notFound(res, "Leave type not found");
  const userRows = await db
    .select({ hire_date: usersTable.hire_date })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const hireDate = userRows[0]?.hire_date
    ? String(userRows[0].hire_date)
    : null;
  const today = new Date().toISOString().slice(0, 10);
  const validation = await buildBucketForValidation(bucket);

  const r1 = checkRequestable(validation);
  if (!r1.ok) return res.status(409).json({ error: "Conflict", ...r1 });
  const r2 = checkWaitingPeriod(validation, hireDate, today);
  if (!r2.ok) return res.status(409).json({ error: "Conflict", ...r2 });
  // 7-day advance notice for PTO + Unpaid (sick/PLAWA = short-notice, exempt).
  const r2b = checkAdvanceNotice(validation, body.start_date, today);
  if (!r2b.ok) return res.status(409).json({ error: "Conflict", ...r2b });

  const balanceRow = await ensureBalanceRow(companyId, userId, bucket.id);
  const balance = computeCurrentBalance({
    accrual_mode: validation.accrual_mode,
    granted_hours: Number(balanceRow.granted_hours),
    used_hours: Number(balanceRow.used_hours),
    annual_cap_hours: Number(bucket.annual_cap_hours),
  });
  const r3 = checkBalance(validation, hours, balance.available);
  if (!r3.ok) return res.status(409).json({ error: "Conflict", ...r3 });

  // Blackout check: PLAWA-class exempt buckets are NEVER auto-denied.
  // Non-exempt: row still created, marked blackout_conflict + denied;
  // office may override.
  let blackoutConflict = false;
  let blackoutLabel: string | null = null;
  let initialStatus: "pending" | "denied" = "pending";
  if (!validation.exempt_from_blackout) {
    const blackouts = await db
      .select({
        start_date: leaveBlackoutsTable.start_date,
        end_date: leaveBlackoutsTable.end_date,
        label: leaveBlackoutsTable.label,
      })
      .from(leaveBlackoutsTable)
      .where(eq(leaveBlackoutsTable.company_id, companyId));
    const blackoutWindows: BlackoutWindow[] = blackouts.map((b) => ({
      start_date: String(b.start_date),
      end_date: String(b.end_date),
      label: b.label,
    }));
    const outcome = detectBlackoutOverlap(
      body.start_date,
      body.end_date,
      blackoutWindows,
    );
    if (outcome.overlaps) {
      blackoutConflict = true;
      blackoutLabel = outcome.blackout.label;
      initialStatus = "denied";
    }
  }

  const inserted = await db
    .insert(leaveRequestsTable)
    .values({
      company_id: companyId,
      user_id: userId,
      leave_type_id: bucket.id,
      start_date: body.start_date,
      end_date: body.end_date,
      hours: hours.toFixed(2),
      note: body.note ?? null,
      status: initialStatus,
      blackout_conflict: blackoutConflict,
      blackout_label: blackoutLabel,
      decided_at: initialStatus === "denied" ? new Date() : null,
      decision_note:
        initialStatus === "denied" && blackoutLabel
          ? `Auto-denied: overlaps blackout "${blackoutLabel}". Office may override.`
          : null,
    })
    .returning();

  // Office/owner "ACTION REQUIRED" + employee "Pending"/"Emergency" (or
  // "Denied" if auto-denied above). Best-effort, never fails the request.
  void notifyLeaveSubmitted(inserted[0]!.id, companyId);

  return res.json({ data: inserted[0] });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /requests/cascade — leave bucket cascade (PTO → PLAWA → Unpaid Leave)
// ─────────────────────────────────────────────────────────────────────────────
//
// Employee asks for N hours off without choosing a bucket. Server orders the
// tenant's cascade-eligible buckets (default: PTO → PLAWA → Unpaid Leave),
// allocates greedily across them, and creates one leave_requests row per
// bucket that gets >0 hours. All rows share a cascade_group_id so they can be
// approved / denied / shown as a group.
//
// What this endpoint inherits from the single-bucket flow:
//   - Waiting period check, per bucket
//   - Blackout overlap check, per bucket (PLAWA-class exempt rows bypass)
//   - COMMS_ENABLED-gated office notification (one per row)
//
// What it does NOT do:
//   - Override `requestable=false` buckets (Unexcused). The cascade ordering
//     filters those out so they can't accidentally absorb the spill.
//   - Insert anything if the resolver fails — atomic at the route layer.
router.post("/requests/cascade", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const body = req.body as {
    start_date?: string;
    end_date?: string;
    hours?: number | string;
    note?: string | null;
    /** Optional override of the default PTO → PLAWA → Unpaid order. */
    cascade_order?: string[];
  };
  if (!body?.start_date || !ISO_DATE_RE.test(body.start_date))
    return bad(res, "start_date YYYY-MM-DD required");
  if (!body?.end_date || !ISO_DATE_RE.test(body.end_date))
    return bad(res, "end_date YYYY-MM-DD required");
  if (body.end_date < body.start_date)
    return bad(res, "end_date must be >= start_date");
  const hours = Number(body.hours);
  if (!Number.isFinite(hours) || hours <= 0) return bad(res, "hours must be positive");

  // 1. Pull all active leave_types for the tenant. The resolver filters by
  //    slug + requestable, so unrelated buckets (Sick, Unexcused) are dropped
  //    even when they share the tenant.
  const allTypes = await db
    .select()
    .from(leaveTypesTable)
    .where(and(eq(leaveTypesTable.company_id, companyId), eq(leaveTypesTable.active, true)));

  if (allTypes.length === 0) return notFound(res, "Tenant has no active leave types");

  // 2. Compute each bucket's available balance (same math as the single
  //    endpoint). Pre-create balance rows so the cascade insert never has
  //    to retry on a missing-row race.
  const bucketsForResolver: CascadeBucketInput[] = [];
  const validationByLeaveTypeId = new Map<number, BucketForValidation>();
  for (const bucket of allTypes) {
    const validation = await buildBucketForValidation(bucket);
    validationByLeaveTypeId.set(bucket.id, validation);
    const balanceRow = await ensureBalanceRow(companyId, userId, bucket.id);
    const balance = computeCurrentBalance({
      accrual_mode: validation.accrual_mode,
      granted_hours: Number(balanceRow.granted_hours),
      used_hours: Number(balanceRow.used_hours),
      annual_cap_hours: Number(bucket.annual_cap_hours),
    });
    bucketsForResolver.push({
      leave_type_id: bucket.id,
      slug: bucket.slug,
      available_hours: balance.available,
      requestable: validation.requestable,
    });
  }

  // 3. Allocate.
  const allocation = resolveCascadeAllocation({
    requestedHours: hours,
    buckets: bucketsForResolver,
    customOrder: body.cascade_order,
  });
  if (!allocation.ok) {
    return res.status(409).json({ error: "Conflict", code: allocation.code, message: allocation.message });
  }

  // 4. Per-bucket waiting period + blackout. Anything that fails the waiting
  //    period kills the whole cascade (we don't half-insert). Blackouts mark
  //    individual rows as denied without aborting the group — the office can
  //    still approve a PLAWA fragment even if a PTO fragment was auto-denied.
  const userRows = await db
    .select({ hire_date: usersTable.hire_date })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const hireDate = userRows[0]?.hire_date ? String(userRows[0].hire_date) : null;
  const today = new Date().toISOString().slice(0, 10);

  for (const alloc of allocation.allocations) {
    const validation = validationByLeaveTypeId.get(alloc.leave_type_id)!;
    const waitingCheck = checkWaitingPeriod(validation, hireDate, today);
    if (!waitingCheck.ok) {
      return res.status(409).json({
        error: "Conflict",
        code: waitingCheck.code,
        message: `${validation.display_name}: ${waitingCheck.message}`,
        bucket_slug: alloc.slug,
      });
    }
  }

  const blackouts = await db
    .select({
      start_date: leaveBlackoutsTable.start_date,
      end_date: leaveBlackoutsTable.end_date,
      label: leaveBlackoutsTable.label,
    })
    .from(leaveBlackoutsTable)
    .where(eq(leaveBlackoutsTable.company_id, companyId));
  const blackoutWindows: BlackoutWindow[] = blackouts.map((b) => ({
    start_date: String(b.start_date),
    end_date: String(b.end_date),
    label: b.label,
  }));

  // 5. Insert all rows in one transaction sharing a cascade_group_id.
  const cascadeGroupId = randomUUID();
  const inserted = await db.transaction(async (tx) => {
    const out: Array<typeof leaveRequestsTable.$inferSelect> = [];
    for (const alloc of allocation.allocations) {
      const validation = validationByLeaveTypeId.get(alloc.leave_type_id)!;
      let blackoutConflict = false;
      let blackoutLabel: string | null = null;
      let initialStatus: "pending" | "denied" = "pending";
      if (!validation.exempt_from_blackout) {
        const outcome = detectBlackoutOverlap(
          body.start_date!,
          body.end_date!,
          blackoutWindows,
        );
        if (outcome.overlaps) {
          blackoutConflict = true;
          blackoutLabel = outcome.blackout.label;
          initialStatus = "denied";
        }
      }
      const [row] = await tx
        .insert(leaveRequestsTable)
        .values({
          company_id: companyId,
          user_id: userId,
          leave_type_id: alloc.leave_type_id,
          start_date: body.start_date!,
          end_date: body.end_date!,
          hours: alloc.hours.toFixed(2),
          note: body.note ?? null,
          status: initialStatus,
          blackout_conflict: blackoutConflict,
          blackout_label: blackoutLabel,
          cascade_group_id: cascadeGroupId,
          cascade_order: alloc.cascade_order,
          decided_at: initialStatus === "denied" ? new Date() : null,
          decision_note:
            initialStatus === "denied" && blackoutLabel
              ? `Auto-denied: overlaps blackout "${blackoutLabel}". Office may override.`
              : null,
        })
        .returning();
      out.push(row);
    }
    return out;
  });

  // 6. Office notification per row. Quietly best-effort.
  for (const row of inserted) {
    void notifyOfficeOfRequestSilent(row.id, companyId);
  }

  return res.json({
    data: {
      cascade_group_id: cascadeGroupId,
      requests: inserted,
      spill_hours: allocation.spill_hours,
    },
  });
});

router.get("/requests", officeReadGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const statusFilter = (req.query.status as string | undefined) ?? null;
  const where = statusFilter
    ? and(
        eq(leaveRequestsTable.company_id, companyId),
        eq(leaveRequestsTable.status, statusFilter as any),
      )
    : eq(leaveRequestsTable.company_id, companyId);
  const rows = await db
    .select({
      id: leaveRequestsTable.id,
      user_id: leaveRequestsTable.user_id,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
      leave_type_id: leaveRequestsTable.leave_type_id,
      bucket_name: leaveTypesTable.display_name,
      start_date: leaveRequestsTable.start_date,
      end_date: leaveRequestsTable.end_date,
      hours: leaveRequestsTable.hours,
      note: leaveRequestsTable.note,
      status: leaveRequestsTable.status,
      blackout_conflict: leaveRequestsTable.blackout_conflict,
      blackout_label: leaveRequestsTable.blackout_label,
      decided_at: leaveRequestsTable.decided_at,
      decision_note: leaveRequestsTable.decision_note,
      created_at: leaveRequestsTable.created_at,
    })
    .from(leaveRequestsTable)
    .leftJoin(usersTable, eq(leaveRequestsTable.user_id, usersTable.id))
    .leftJoin(
      leaveTypesTable,
      eq(leaveRequestsTable.leave_type_id, leaveTypesTable.id),
    )
    .where(where)
    .orderBy(desc(leaveRequestsTable.created_at));
  return res.json({ data: rows });
});

router.get("/requests/mine", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const rows = await db
    .select()
    .from(leaveRequestsTable)
    .where(
      and(
        eq(leaveRequestsTable.company_id, companyId),
        eq(leaveRequestsTable.user_id, userId),
      ),
    )
    .orderBy(desc(leaveRequestsTable.created_at));
  return res.json({ data: rows });
});

async function loadRequest(companyId: number, id: number) {
  const rows = await db
    .select()
    .from(leaveRequestsTable)
    .where(
      and(
        eq(leaveRequestsTable.company_id, companyId),
        eq(leaveRequestsTable.id, id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

router.post("/requests/:id/approve", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const actingUserId = req.auth!.userId!;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return bad(res, "Invalid id");
  const reqRow = await loadRequest(companyId, id);
  if (!reqRow) return notFound(res, "Request not found");
  if (reqRow.status !== "pending" && reqRow.status !== "denied") {
    return res.status(409).json({
      error: "Conflict",
      message: `Request is ${reqRow.status}; only pending or denied (override) requests can be approved.`,
    });
  }
  const decisionNote =
    (req.body?.decision_note as string | undefined) ?? null;
  const hours = Number(reqRow.hours);
  // Decrement balance + write a usage row for the date(s).
  const bal = await ensureBalanceRow(
    companyId,
    reqRow.user_id,
    reqRow.leave_type_id,
  );
  await db
    .update(employeeLeaveBalancesTable)
    .set({
      used_hours: (Number(bal.used_hours) + hours).toFixed(2),
      updated_at: new Date(),
    })
    .where(eq(employeeLeaveBalancesTable.id, bal.id));
  await db.insert(employeeLeaveUsageTable).values({
    company_id: companyId,
    employee_id: reqRow.user_id,
    date_used: String(reqRow.start_date),
    hours: hours.toFixed(2),
    notes: `leave_request #${reqRow.id} approved`,
    logged_by: actingUserId,
  });
  await db
    .update(leaveRequestsTable)
    .set({
      status: "approved",
      decided_at: new Date(),
      decided_by_user_id: actingUserId,
      decision_note: decisionNote,
      updated_at: new Date(),
    })
    .where(eq(leaveRequestsTable.id, id));
  // Auto-pay: approval is the gate — a paid bucket cascades into pay as a
  // visible additional_pay line ($20/hr flat). Idempotent; unpaid = no-op.
  try {
    await writeApprovedLeavePay(companyId, id);
  } catch (err) {
    console.error("[leave] auto-pay on approval failed (non-fatal):", err);
  }
  // Employee Approved notification: in-app + push + email + SMS (MC-mirrored).
  void notifyLeaveDecision(id, "approved");
  // [push 2026-06-03] Push the employee (fire-and-forget, gated by COMMS_ENABLED).
  {
    const when = reqRow.start_date
      ? new Date(`${String(reqRow.start_date)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "";
    notifyUserAsync(reqRow.user_id, companyId, {
      title: "Time off approved",
      body: `Your request${when ? ` for ${when}` : ""} was approved.`,
      data: { type: "leave", requestId: String(id) },
    });
  }
  return res.json({ data: { id, status: "approved" } });
});

router.post("/requests/:id/deny", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const actingUserId = req.auth!.userId!;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return bad(res, "Invalid id");
  const reqRow = await loadRequest(companyId, id);
  if (!reqRow) return notFound(res, "Request not found");
  if (reqRow.status !== "pending") {
    return res.status(409).json({
      error: "Conflict",
      message: `Request is ${reqRow.status}; only pending can be denied.`,
    });
  }
  const decisionNote =
    (req.body?.decision_note as string | undefined) ?? null;
  await db
    .update(leaveRequestsTable)
    .set({
      status: "denied",
      decided_at: new Date(),
      decided_by_user_id: actingUserId,
      decision_note: decisionNote,
      updated_at: new Date(),
    })
    .where(eq(leaveRequestsTable.id, id));
  // Employee Denied notification: in-app + push + email + SMS (MC-mirrored).
  void notifyLeaveDecision(id, "denied");
  return res.json({ data: { id, status: "denied" } });
});

router.post("/requests/:id/cancel", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const actingUserId = req.auth!.userId!;
  const actingRole = req.auth!.role;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return bad(res, "Invalid id");
  const reqRow = await loadRequest(companyId, id);
  if (!reqRow) return notFound(res, "Request not found");
  const isOwn = reqRow.user_id === actingUserId;
  const isAdmin =
    actingRole === "owner" ||
    actingRole === "admin" ||
    actingRole === "super_admin";
  // Employees may cancel only their own PENDING requests; admins may
  // cancel approved (restoring balance).
  if (!isAdmin && !(isOwn && reqRow.status === "pending")) {
    return forbidden(res, "Only the owning employee may cancel a pending request; only admin may reverse an approval.");
  }
  if (reqRow.status === "cancelled") {
    return res
      .status(409)
      .json({ error: "Conflict", message: "Already cancelled" });
  }
  // If reversing an approved request, restore the balance + remove
  // the usage row(s) we created.
  if (reqRow.status === "approved") {
    const bal = await ensureBalanceRow(
      companyId,
      reqRow.user_id,
      reqRow.leave_type_id,
    );
    const hours = Number(reqRow.hours);
    const newUsed = Math.max(0, Number(bal.used_hours) - hours);
    await db
      .update(employeeLeaveBalancesTable)
      .set({
        used_hours: newUsed.toFixed(2),
        updated_at: new Date(),
      })
      .where(eq(employeeLeaveBalancesTable.id, bal.id));
    await db
      .delete(employeeLeaveUsageTable)
      .where(
        and(
          eq(employeeLeaveUsageTable.company_id, companyId),
          eq(employeeLeaveUsageTable.employee_id, reqRow.user_id),
          eq(employeeLeaveUsageTable.date_used, String(reqRow.start_date)),
          eq(
            employeeLeaveUsageTable.notes,
            `leave_request #${reqRow.id} approved`,
          ),
        ),
      );
  }
  await db
    .update(leaveRequestsTable)
    .set({
      status: "cancelled",
      decided_at: new Date(),
      decided_by_user_id: actingUserId,
      updated_at: new Date(),
    })
    .where(eq(leaveRequestsTable.id, id));
  return res.json({ data: { id, status: "cancelled" } });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blackouts
// ─────────────────────────────────────────────────────────────────────────────

router.get("/blackouts", officeReadGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const rows = await db
    .select()
    .from(leaveBlackoutsTable)
    .where(eq(leaveBlackoutsTable.company_id, companyId))
    .orderBy(asc(leaveBlackoutsTable.start_date));
  return res.json({ data: rows });
});

router.post("/blackouts", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const body = req.body as {
    start_date?: string;
    end_date?: string;
    label?: string;
  };
  if (!body?.start_date || !ISO_DATE_RE.test(body.start_date))
    return bad(res, "start_date YYYY-MM-DD required");
  if (!body?.end_date || !ISO_DATE_RE.test(body.end_date))
    return bad(res, "end_date YYYY-MM-DD required");
  if (!body?.label?.trim()) return bad(res, "label required");
  if (body.end_date < body.start_date)
    return bad(res, "end_date must be >= start_date");
  const inserted = await db
    .insert(leaveBlackoutsTable)
    .values({
      company_id: companyId,
      start_date: body.start_date,
      end_date: body.end_date,
      label: body.label.trim(),
      created_by_user_id: userId,
    })
    .returning();
  return res.json({ data: inserted[0] });
});

router.delete("/blackouts/:id", adminWriteGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return bad(res, "Invalid id");
  await db
    .delete(leaveBlackoutsTable)
    .where(
      and(
        eq(leaveBlackoutsTable.company_id, companyId),
        eq(leaveBlackoutsTable.id, id),
      ),
    );
  // Note: existing approved requests are NOT touched. Per spec —
  // adding/removing a blackout never retroactively changes a prior
  // decision.
  return res.json({ data: { id, deleted: true } });
});

// ─────────────────────────────────────────────────────────────────────────────
// Use-it-or-lose-it alert evaluation (office digest)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/alerts/use-it-or-lose-it", officeReadGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const policyRows = await db
    .select()
    .from(companyLeavePolicyTable)
    .where(eq(companyLeavePolicyTable.company_id, companyId))
    .limit(1);
  const policy = policyRows[0];
  if (!policy) return res.json({ data: { alerts: [] } });
  const leadDays = policy.use_it_or_lose_it_alert_lead_days ?? 60;
  const resetBasis = (policy.leave_reset_basis ?? "calendar_year") as
    | "work_anniversary"
    | "calendar_year";

  const users = await db
    .select({
      id: usersTable.id,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
      hire_date: usersTable.hire_date,
      is_active: usersTable.is_active,
    })
    .from(usersTable)
    .where(eq(usersTable.company_id, companyId));
  const today = new Date().toISOString().slice(0, 10);
  const alerts = [];
  for (const u of users) {
    if (!u.is_active) continue;
    const a = evaluateUseItOrLoseItAlert({
      reset_basis: resetBasis,
      hire_date: u.hire_date ? String(u.hire_date) : null,
      today,
      lead_days: leadDays,
    });
    if (!a.should_alert) continue;
    alerts.push({
      user_id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      next_reset: a.next_reset,
      days_until_reset: a.days_until_reset,
    });
  }
  return res.json({ data: { alerts, lead_days: leadDays, reset_basis: resetBasis } });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unexcused-hours ladder watcher endpoint
// ─────────────────────────────────────────────────────────────────────────────

router.post("/unexcused/record", officeReadGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const actingUserId = req.auth!.userId!;
  const body = req.body as {
    employee_id?: number;
    log_date?: string;
    hours?: number | string;
    notes?: string;
  };
  if (!body?.employee_id || !Number.isFinite(Number(body.employee_id)))
    return bad(res, "employee_id required");
  if (!body?.log_date || !ISO_DATE_RE.test(body.log_date))
    return bad(res, "log_date YYYY-MM-DD required");
  const hours = Number(body.hours);
  if (!Number.isFinite(hours) || hours <= 0)
    return bad(res, "hours must be positive");
  // Honor the legacy `notes` field: prior callers passed a full notes
  // string (e.g. "unexcused hours: 8.00") rather than a short context
  // suffix. The extracted helper composes its own canonical marker
  // `unexcused hours: X.XX (<note>)` — passing the legacy notes as the
  // `note` arg keeps the regex on read working (`hours` is still
  // parsed from the leading marker) while preserving caller intent.
  const result = await recordUnexcusedEntryAndDriveLadder(db, {
    company_id: companyId,
    employee_id: Number(body.employee_id),
    log_date: body.log_date,
    hours,
    type: "absent",
    protected: false,
    note: body.notes,
    logged_by: actingUserId,
  });
  if (!result.ladder_eval.triggered_step) {
    return res.json({ data: { recorded: true, triggered_step: null } });
  }
  const step = result.ladder_eval.triggered_step;
  return res.json({
    data: {
      recorded: true,
      triggered_step: {
        threshold_hours: step.threshold_hours,
        discipline_type: step.discipline_type,
        cumulative_hours: result.ladder_eval.cumulative_hours,
      },
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Notification helpers — best-effort, COMMS_ENABLED-gated, never throw
// ─────────────────────────────────────────────────────────────────────────────

// Leave request/decision notifications moved to lib/leave-notifications.ts
// (notifyLeaveSubmitted / notifyLeaveDecision) — real in-app + push + email
// + SMS mirroring MaidCentral's templates, replacing the prior console-log
// stubs (notifyOfficeOfRequestSilent / notifyEmployeeOfDecisionSilent).

// notifyOfficeOfDisciplineSilent moved to lib/unexcused-ladder-writer.ts
// in cutover 3B and re-exported (imported above) so the new
// attendance-overlay confirm path can use the same notifier.

export default router;
