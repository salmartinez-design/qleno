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
  usersTable,
} from "@workspace/db/schema";
import { and, asc, desc, eq, gte, inArray, isNotNull, like, lte, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { notifyUserAsync } from "../lib/push.js";
import {
  computeCurrentBalance,
  isPastWaitingPeriod,
  round2,
} from "../lib/leave-balance.js";
import { nextResetDate } from "../lib/leave-reset-format.js";
import { benefitYearStartDate } from "../lib/leave-grant-reset.js";
import { nextOccurrenceStep } from "../lib/unexcused-ladder.js";
import {
  DISC_LABEL,
  parseUnexcusedHours,
  cleanUnexNote,
  pickNextStep,
  maxLadderWindow,
} from "../lib/leave-attendance-format.js";
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
import { writeApprovedLeavePay, voidApprovedLeavePay } from "../lib/leave-pay.js";
import { slugToBucket } from "../lib/leave-bucket.js";
import { logAudit } from "../lib/audit.js";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";

// Disk-upload for the required leave attachment (doctor's note / file). Mirrors
// routes/attachments.ts; lands the file in the served uploads dir and returns a
// canonical /api/uploads/ URL. 10 MB cap; images + PDFs are the expected use.
const leaveUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = "/tmp/uploads";
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `leave-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Time-off "ticket" flow (Sal 2026-06-22). A standard workday is 8h; a half-day
// is 4h. HALF_DAY_CUTOFF is the morning/afternoon split shown on the board —
// noon by default, kept as a constant so it can be made tenant-configurable later.
const DAILY_HOURS = 8;
const HALF_DAY_CUTOFF = "12:00"; // morning = off until 12:00; afternoon = off from 12:00
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
    next_reset_date: string | null;
    eligible_on: string | null;
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
    // Reset countdown + waiting-period note inputs (Phase 2 card polish).
    // Flat-grant buckets reset on the work anniversary; office-recorded
    // (Unexcused) never resets → null. eligible_on = hire + waiting period.
    const nextReset =
      b.accrual_mode === "flat_grant" && hireDate
        ? nextResetDate(hireDate, today).toISOString().slice(0, 10)
        : null;
    let eligibleOn: string | null = null;
    if (hireDate) {
      const d = new Date(`${hireDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + (b.waiting_period_days || 0));
      eligibleOn = d.toISOString().slice(0, 10);
    }
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
      next_reset_date: nextReset,
      eligible_on: eligibleOn,
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

// Per-employee leave usage feed (the bucket lives in each row's note tag —
// "…/pto", "…/plawa", etc.). Replaces the deprecated /hr-leave/balance/:id
// usage feed for the profile's "View History" modal. Read-only.
async function buildUsageForUser(companyId: number, userId: number) {
  return db
    .select({
      date_used: employeeLeaveUsageTable.date_used,
      hours: employeeLeaveUsageTable.hours,
      notes: employeeLeaveUsageTable.notes,
    })
    .from(employeeLeaveUsageTable)
    .where(
      and(
        eq(employeeLeaveUsageTable.company_id, companyId),
        eq(employeeLeaveUsageTable.employee_id, userId),
      ),
    )
    .orderBy(desc(employeeLeaveUsageTable.date_used));
}

router.get("/usage/me", async (req, res) => {
  const data = await buildUsageForUser(req.auth!.companyId!, req.auth!.userId!);
  return res.json({ data });
});

router.get("/usage", officeReadGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = Number(req.query.userId);
  if (!Number.isFinite(userId)) return bad(res, "userId required");
  const data = await buildUsageForUser(companyId, userId);
  return res.json({ data });
});

// ─────────────────────────────────────────────────────────────────────────────
// Attendance summary (Phase 2) — real, clickable stat tiles + the Unexcused
// disciplinary-ladder progress. Counts + per-day drill-down rows (date +
// reason) over a rolling window, sourced from employee_attendance_log
// (tardy/absent/ncns) + employee_leave_usage (pto/plawa note tags). Read-only.
// ─────────────────────────────────────────────────────────────────────────────
function ymdMinus(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

async function buildAttendanceSummary(
  companyId: number,
  userId: number,
  windowDays: number,
  includeDiscipline = false,
) {
  const to = new Date().toISOString().slice(0, 10);
  const from = ymdMinus(windowDays);

  const att = await db
    .select({
      log_date: employeeAttendanceLogTable.log_date,
      type: employeeAttendanceLogTable.type,
      notes: employeeAttendanceLogTable.notes,
      is_protected: employeeAttendanceLogTable.protected,
    })
    .from(employeeAttendanceLogTable)
    .where(
      and(
        eq(employeeAttendanceLogTable.company_id, companyId),
        eq(employeeAttendanceLogTable.employee_id, userId),
        gte(employeeAttendanceLogTable.log_date, from),
      ),
    )
    .orderBy(desc(employeeAttendanceLogTable.log_date));

  const usage = await buildUsageForUser(companyId, userId);
  const usageInWindow = usage.filter(
    (u) => String(u.date_used).slice(0, 10) >= from,
  );

  const dayRow = (date: any, reason: string, hours: number | null) => ({
    date: String(date).slice(0, 10),
    reason: (reason || "").trim(),
    hours: hours != null ? round2(Number(hours)) : null,
  });
  const lateRows = att.filter((r) => r.type === "tardy").map((r) => dayRow(r.log_date, r.notes || "Late", null));
  const absentRows = att.filter((r) => r.type === "absent" || r.type === "ncns").map((r) => dayRow(r.log_date, r.notes || "Absent", null));
  const unexRows = att.filter((r) => r.type === "absent" && !r.is_protected).map((r) => dayRow(r.log_date, cleanUnexNote(r.notes), parseUnexcusedHours(r.notes)));
  const ptoRows = usageInWindow.filter((u) => String(u.notes || "").includes("/pto")).map((u) => dayRow(u.date_used, String(u.notes || ""), Number(u.hours)));
  const sickRows = usageInWindow.filter((u) => String(u.notes || "").includes("/plawa")).map((u) => dayRow(u.date_used, String(u.notes || ""), Number(u.hours)));
  const timeOffRows = usageInWindow.map((u) => dayRow(u.date_used, String(u.notes || ""), Number(u.hours)));

  const tile = (rows: Array<{ hours: number | null }>) => ({
    count: rows.length,
    hours: round2(rows.reduce((s, r) => s + (r.hours || 0), 0)),
    days: rows,
  });

  // Unexcused disciplinary ladder (LMS-rule thresholds). The
  // unexcused_hours_steps column may not exist yet in every tenant DB — read
  // defensively so the tile degrades to a plain count until it's configured.
  let steps: any[] = [];
  try {
    const r = await db.execute(
      sql`SELECT unexcused_hours_steps FROM company_attendance_policy WHERE company_id = ${companyId} LIMIT 1`,
    );
    steps = ((r.rows[0] as any)?.unexcused_hours_steps as any[]) || [];
  } catch {
    steps = [];
  }
  const maxWindow = maxLadderWindow(steps, windowDays);
  const ladderFrom = ymdMinus(maxWindow);
  const rollingHours = round2(
    att
      .filter((r) => r.type === "absent" && !r.is_protected && String(r.log_date).slice(0, 10) >= ladderFrom)
      .reduce((s, r) => s + parseUnexcusedHours(r.notes), 0),
  );
  const nextStep = pickNextStep(steps, rollingHours);

  // Occurrence-based disciplinary ladders (PHES). Count INCIDENTS per Benefit
  // Year (work anniversary) — unexcused absences and tardies independently.
  // Steps read defensively (columns added by the cutover migration).
  let unexOccSteps: any[] = [];
  let tardyOccSteps: any[] = [];
  try {
    const r = await db.execute(
      sql`SELECT unexcused_occurrence_steps, tardy_occurrence_steps FROM company_attendance_policy WHERE company_id = ${companyId} LIMIT 1`,
    );
    unexOccSteps = ((r.rows[0] as any)?.unexcused_occurrence_steps as any[]) || [];
    tardyOccSteps = ((r.rows[0] as any)?.tardy_occurrence_steps as any[]) || [];
  } catch {
    unexOccSteps = [];
    tardyOccSteps = [];
  }
  const uRow = await db
    .select({ hire_date: usersTable.hire_date })
    .from(usersTable)
    .where(and(eq(usersTable.company_id, companyId), eq(usersTable.id, userId)))
    .limit(1);
  const occHireDate = uRow[0]?.hire_date ? String(uRow[0].hire_date).slice(0, 10) : to;
  const benefitYearStart = benefitYearStartDate(occHireDate, to).toISOString().slice(0, 10);
  const byRows = await db
    .select({ type: employeeAttendanceLogTable.type, is_protected: employeeAttendanceLogTable.protected })
    .from(employeeAttendanceLogTable)
    .where(
      and(
        eq(employeeAttendanceLogTable.company_id, companyId),
        eq(employeeAttendanceLogTable.employee_id, userId),
        gte(employeeAttendanceLogTable.log_date, benefitYearStart),
      ),
    );
  const unexOccCount = byRows.filter((r) => r.type === "absent" && !r.is_protected).length;
  const tardyOccCount = byRows.filter((r) => r.type === "tardy" && !r.is_protected).length;
  const fmtOccStep = (s: any | null) =>
    s ? { occurrence: Number(s.occurrence), label: s.label || DISC_LABEL[s.discipline_type] || "Discipline" } : null;
  const unexNextOcc = fmtOccStep(nextOccurrenceStep(unexOccSteps, unexOccCount));
  const tardyNextOcc = fmtOccStep(nextOccurrenceStep(tardyOccSteps, tardyOccCount));

  // Discipline log (office/owner only — never returned to an employee's own
  // /me view). Active = not dismissed. Newest first.
  let discipline: Array<{ label: string; type: string; reason: string | null; effective_date: string; pending_review: boolean }> = [];
  let currentDiscipline: { label: string } | null = null;
  if (includeDiscipline) {
    const disc = await db
      .select({
        discipline_type: employeeDisciplineLogTable.discipline_type,
        custom_label: employeeDisciplineLogTable.custom_label,
        reason: employeeDisciplineLogTable.reason,
        effective_date: employeeDisciplineLogTable.effective_date,
        pending_review: employeeDisciplineLogTable.pending_review,
      })
      .from(employeeDisciplineLogTable)
      .where(
        and(
          eq(employeeDisciplineLogTable.company_id, companyId),
          eq(employeeDisciplineLogTable.employee_id, userId),
          eq(employeeDisciplineLogTable.dismissed, false),
        ),
      )
      .orderBy(desc(employeeDisciplineLogTable.effective_date))
      .limit(20);
    discipline = disc.map((d) => ({
      label: d.custom_label || DISC_LABEL[d.discipline_type] || "Discipline",
      type: d.discipline_type,
      reason: d.reason,
      effective_date: String(d.effective_date).slice(0, 10),
      pending_review: !!d.pending_review,
    }));
    currentDiscipline = discipline[0] ? { label: discipline[0].label } : null;
  }

  return {
    window_days: windowDays,
    from,
    to,
    tiles: {
      late: tile(lateRows),
      absent: tile(absentRows),
      unexcused: tile(unexRows),
      time_off: tile(timeOffRows),
      sick: tile(sickRows),
      pto: tile(ptoRows),
    },
    unexcused: {
      // Occurrence-based (PHES) — the disciplinary ladder counts incidents per
      // benefit year. Falls back to plain count when no steps are configured.
      occurrences: unexOccCount,
      benefit_year_start: benefitYearStart,
      next_step: unexNextOcc,
      current_discipline: currentDiscipline,
      // Legacy cumulative-hours record (kept for reference, not the ladder).
      rolling_hours: rollingHours,
      hours_window_days: maxWindow,
      hours_next_step: nextStep,
    },
    tardy: {
      occurrences: tardyOccCount,
      benefit_year_start: benefitYearStart,
      next_step: tardyNextOcc,
    },
    discipline,
  };
}

function parseWindowDays(q: unknown): number {
  const n = Number(q);
  return [30, 90, 180, 365].includes(n) ? n : 180;
}

router.get("/attendance-summary/me", async (req, res) => {
  const data = await buildAttendanceSummary(
    req.auth!.companyId!,
    req.auth!.userId!,
    parseWindowDays(req.query.windowDays),
  );
  return res.json({ data });
});

router.get("/attendance-summary", officeReadGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = Number(req.query.userId);
  if (!Number.isFinite(userId)) return bad(res, "userId required");
  const data = await buildAttendanceSummary(companyId, userId, parseWindowDays(req.query.windowDays), true);
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

// Upload the required attachment, get back a URL to submit with the request.
router.post("/upload", leaveUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) return bad(res, "No file uploaded");
    const uploadsDir = process.env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.renameSync(req.file.path, path.join(uploadsDir, req.file.filename));
    return res.json({
      file_url: `/api/uploads/${req.file.filename}`,
      file_name: req.file.originalname,
    });
  } catch (err) {
    console.error("[leave] upload failed:", err);
    return res.status(500).json({ error: "Upload failed" });
  }
});

router.post("/requests", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const userId = req.auth!.userId!;
  const body = req.body as {
    leave_type_id?: number;
    start_date?: string;
    end_date?: string;
    day_unit?: "full_day" | "morning" | "afternoon";
    attachment_url?: string | null;
    attachment_name?: string | null;
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

  // Required attachment at submit (Sal 2026-06-22) — employee-only, mandatory.
  if (!body.attachment_url) {
    return bad(res, "An attachment (e.g. a doctor's note) is required to submit a time-off request.", "attachment_required");
  }

  // Unit: full day / morning / afternoon. No free-form hours. Multi-day must be
  // full days. Hours are derived (full = 8h × days; half = 4h, single day).
  const dayUnit: "full_day" | "morning" | "afternoon" =
    body.day_unit === "morning" || body.day_unit === "afternoon" ? body.day_unit : "full_day";
  const multiDay = body.end_date > body.start_date;
  if (multiDay && dayUnit !== "full_day") {
    return bad(res, "Multi-day requests must be full days (use Morning/Afternoon for a single day).", "multiday_must_be_full");
  }
  const dayCount =
    Math.round(
      (Date.parse(`${body.end_date}T00:00:00Z`) - Date.parse(`${body.start_date}T00:00:00Z`)) / 86400000,
    ) + 1;
  const hours = dayUnit === "full_day" ? DAILY_HOURS * dayCount : DAILY_HOURS / 2;

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
      day_unit: dayUnit,
      attachment_url: body.attachment_url,
      attachment_name: body.attachment_name ?? null,
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
  // Company-wide audit trail (per-employee profile log reads the same table).
  try {
    await logAudit(req, "leave_request_submitted", "leave_request", String(inserted[0]!.id), null, {
      leave_type_id: bucket.id, start_date: body.start_date, end_date: body.end_date,
      day_unit: dayUnit, hours, status: initialStatus,
    });
  } catch { /* audit is best-effort */ }

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
      avatar_url: usersTable.avatar_url,
      leave_type_id: leaveRequestsTable.leave_type_id,
      bucket_name: leaveTypesTable.display_name,
      bucket_slug: leaveTypesTable.slug,
      start_date: leaveRequestsTable.start_date,
      end_date: leaveRequestsTable.end_date,
      hours: leaveRequestsTable.hours,
      day_unit: leaveRequestsTable.day_unit,
      attachment_url: leaveRequestsTable.attachment_url,
      attachment_name: leaveRequestsTable.attachment_name,
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
  // Write one usage row PER calendar day in the range (was: only start_date —
  // that left multi-day requests showing the tech off for just day one on the
  // board). Full day = 8h/day; a half-day request is a single day at 4h.
  const dayUnit = ((reqRow as { day_unit?: string }).day_unit ?? "full_day");
  const perDay = dayUnit === "full_day" ? DAILY_HOURS : DAILY_HOURS / 2;
  const startMs = Date.parse(`${String(reqRow.start_date)}T00:00:00Z`);
  const endMs = Date.parse(`${String(reqRow.end_date)}T00:00:00Z`);
  // Bucket tag (Sal 2026-06-24): the per-bucket View History modal filters
  // usage rows on a "/pto" vs "/plawa" note tag (matching the [MC import]
  // rows). App-approved rows previously carried no tag and so never showed
  // in history — tag each one by its leave_type bucket so PTO/Sick history
  // stays complete for leave approved going forward.
  const ltRow = await db
    .select({ slug: leaveTypesTable.slug })
    .from(leaveTypesTable)
    .where(eq(leaveTypesTable.id, reqRow.leave_type_id))
    .limit(1);
  const bucket = slugToBucket(ltRow[0]?.slug);
  for (let t = startMs; t <= endMs; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    await db.insert(employeeLeaveUsageTable).values({
      company_id: companyId,
      employee_id: reqRow.user_id,
      date_used: d,
      hours: perDay.toFixed(2),
      // Stable prefix "leave_request #<id> approved" is the key the cancel
      // path matches on to remove every day of this request.
      notes: `leave_request #${reqRow.id} approved (${dayUnit}) usage/${bucket}`,
      logged_by: actingUserId,
    });
  }
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
  try {
    await logAudit(req, "leave_request_approved", "leave_request", String(id), null, {
      decided_by: actingUserId, hours, day_unit: dayUnit, decision_note: decisionNote,
    });
  } catch { /* audit best-effort */ }
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
  try {
    await logAudit(req, "leave_request_denied", "leave_request", String(id), null, {
      decided_by: actingUserId, decision_note: decisionNote,
    });
  } catch { /* audit best-effort */ }
  return res.json({ data: { id, status: "denied" } });
});

// Count of pending time-off requests — powers the office "employee notifications"
// bell badge. Office/owner only. (Equipment/supply requests, when built, add into
// the same bell count.)
router.get("/requests/pending-count", officeReadGate, async (req, res) => {
  const companyId = req.auth!.companyId!;
  const rows = await db
    .select({ id: leaveRequestsTable.id })
    .from(leaveRequestsTable)
    .where(
      and(
        eq(leaveRequestsTable.company_id, companyId),
        eq(leaveRequestsTable.status, "pending"),
      ),
    );
  return res.json({ pending: rows.length });
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
    // Remove EVERY usage day for this request. The prior code matched only
    // start_date AND an exact note string without the "(dayUnit) usage/<bucket>"
    // suffix, so it deleted 0 rows on a multi-day or tagged request, leaving
    // the days showing as "taken" even though the balance was restored. Key on
    // the stable "leave_request #<id> approved" prefix instead — covers all
    // days and both the old and new note formats.
    await db
      .delete(employeeLeaveUsageTable)
      .where(
        and(
          eq(employeeLeaveUsageTable.company_id, companyId),
          eq(employeeLeaveUsageTable.employee_id, reqRow.user_id),
          like(
            employeeLeaveUsageTable.notes,
            `leave_request #${reqRow.id} approved%`,
          ),
        ),
      );
    // Reverse the auto-pay so the employee isn't paid for cancelled leave.
    await voidApprovedLeavePay(companyId, reqRow.id, actingUserId);
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
