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
  employeeAttendanceLogTable,
  employeeDisciplineLogTable,
  companyLeavePolicyTable,
  companyAttendancePolicyTable,
  usersTable,
} from "@workspace/db/schema";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import {
  computeCurrentBalance,
  isPastWaitingPeriod,
  round2,
} from "../lib/leave-balance.js";
import {
  checkRequestable,
  checkWaitingPeriod,
  checkBalance,
  detectBlackoutOverlap,
  type BucketForValidation,
  type BlackoutWindow,
} from "../lib/leave-request-rules.js";
import {
  evaluateLadder,
  type UnexcusedStep,
  type UnexcusedEntry,
} from "../lib/unexcused-ladder.js";
import { evaluateUseItOrLoseItAlert } from "../lib/leave-alerts.js";

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

  // Best-effort office notification (COMMS_ENABLED gated). Never
  // fail the request if comms fails — the ticket is the source of
  // truth.
  void notifyOfficeOfRequestSilent(inserted[0]!.id, companyId);

  return res.json({ data: inserted[0] });
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
  void notifyEmployeeOfDecisionSilent(id, "approved");
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
  void notifyEmployeeOfDecisionSilent(id, "denied");
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
  // Insert attendance log entry.
  await db.insert(employeeAttendanceLogTable).values({
    company_id: companyId,
    employee_id: Number(body.employee_id),
    log_date: body.log_date,
    type: "absent", // unexcused = unauthorized absent in the existing enum
    protected: false,
    notes: body.notes ?? `unexcused hours: ${hours.toFixed(2)}`,
    logged_by: actingUserId,
  });
  // Drive the ladder. Pull the policy ladder + entries for the
  // window-extent we need (max window_days across steps).
  const policyRow = await db
    .select({
      unexcused_hours_steps: companyAttendancePolicyTable.unexcused_hours_steps,
    })
    .from(companyAttendancePolicyTable)
    .where(eq(companyAttendancePolicyTable.company_id, companyId))
    .limit(1);
  const steps =
    ((policyRow[0]?.unexcused_hours_steps as UnexcusedStep[] | null) ?? []) as UnexcusedStep[];
  if (steps.length === 0) {
    return res.json({ data: { recorded: true, triggered_step: null } });
  }
  const maxWindow = Math.max(...steps.map((s) => s.window_days), 0);
  const windowStart = (() => {
    const d = new Date(`${body.log_date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - maxWindow);
    return d.toISOString().slice(0, 10);
  })();
  const entries = await db
    .select({
      log_date: employeeAttendanceLogTable.log_date,
      notes: employeeAttendanceLogTable.notes,
    })
    .from(employeeAttendanceLogTable)
    .where(
      and(
        eq(employeeAttendanceLogTable.company_id, companyId),
        eq(employeeAttendanceLogTable.employee_id, Number(body.employee_id)),
        eq(employeeAttendanceLogTable.type, "absent"),
        gte(employeeAttendanceLogTable.log_date, windowStart),
        lte(employeeAttendanceLogTable.log_date, body.log_date),
      ),
    );
  // Parse hours back out of the notes field (we stored
  // "unexcused hours: 8.00" — this is a stopgap until a dedicated
  // hours column exists on attendance_log). Fall back to 8h
  // per absence row if the notes don't match.
  const parsed: UnexcusedEntry[] = entries.map((e) => {
    const m = /unexcused hours:\s*([0-9.]+)/i.exec(e.notes ?? "");
    return {
      date: String(e.log_date),
      hours: m ? Number(m[1]) : 8,
    };
  });
  // Which thresholds already fired? Pull recent discipline log rows
  // tagged with the unexcused-ladder marker.
  const recentDiscipline = await db
    .select({
      reason: employeeDisciplineLogTable.reason,
    })
    .from(employeeDisciplineLogTable)
    .where(
      and(
        eq(employeeDisciplineLogTable.company_id, companyId),
        eq(employeeDisciplineLogTable.employee_id, Number(body.employee_id)),
      ),
    );
  const alreadyFired = new Set<number>();
  for (const d of recentDiscipline) {
    const m = /\bunexcused-ladder\s+t=(\d+(?:\.\d+)?)/i.exec(d.reason ?? "");
    if (m) alreadyFired.add(Number(m[1]));
  }
  const evalResult = evaluateLadder(
    steps,
    parsed,
    body.log_date,
    alreadyFired,
  );
  if (!evalResult.triggered_step) {
    return res.json({ data: { recorded: true, triggered_step: null } });
  }
  const step = evalResult.triggered_step;
  await db.insert(employeeDisciplineLogTable).values({
    company_id: companyId,
    employee_id: Number(body.employee_id),
    discipline_type: step.discipline_type,
    custom_label: step.label ?? null,
    reason: `unexcused-ladder t=${step.threshold_hours} window=${step.window_days}d cum=${evalResult.cumulative_hours.toFixed(2)}h`,
    effective_date: body.log_date,
    issued_by: actingUserId,
    pending_review: true,
  });
  if (step.notify) {
    void notifyOfficeOfDisciplineSilent(
      companyId,
      Number(body.employee_id),
      step,
      evalResult.cumulative_hours,
    );
  }
  return res.json({
    data: {
      recorded: true,
      triggered_step: {
        threshold_hours: step.threshold_hours,
        discipline_type: step.discipline_type,
        cumulative_hours: evalResult.cumulative_hours,
      },
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Notification helpers — best-effort, COMMS_ENABLED-gated, never throw
// ─────────────────────────────────────────────────────────────────────────────

async function notifyOfficeOfRequestSilent(
  requestId: number,
  companyId: number,
): Promise<void> {
  try {
    if (process.env.COMMS_ENABLED !== "true") return;
    // The ticket itself is in the DB; this is just the email ping.
    // Office notification details (recipient list) live in the
    // existing comms layer — wired by recipient role conventions.
    // Implementing the actual send is out of scope here; we leave a
    // structured log line the comms job can pick up.
    console.log(
      `[leave] new request #${requestId} (company ${companyId}) — comms enabled, office notify`,
    );
  } catch (err) {
    console.warn("[leave] office notify failed (non-fatal):", err);
  }
}

async function notifyEmployeeOfDecisionSilent(
  requestId: number,
  outcome: "approved" | "denied",
): Promise<void> {
  try {
    if (process.env.COMMS_ENABLED !== "true") return;
    console.log(
      `[leave] request #${requestId} → ${outcome} — comms enabled, employee notify`,
    );
  } catch (err) {
    console.warn("[leave] employee notify failed (non-fatal):", err);
  }
}

async function notifyOfficeOfDisciplineSilent(
  companyId: number,
  employeeId: number,
  step: UnexcusedStep,
  cumulativeHours: number,
): Promise<void> {
  try {
    if (process.env.COMMS_ENABLED !== "true") return;
    console.log(
      `[unexcused-ladder] company ${companyId} employee ${employeeId} crossed ${step.threshold_hours}h (cum=${cumulativeHours.toFixed(2)}h) → ${step.discipline_type}`,
    );
  } catch (err) {
    console.warn("[unexcused-ladder] notify failed (non-fatal):", err);
  }
}

export default router;
