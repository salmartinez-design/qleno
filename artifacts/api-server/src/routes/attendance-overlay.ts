/**
 * Cutover 3B — Attendance overlay routes.
 *
 * Mounted at /api/attendance-overlay. All endpoints office-tier
 * (owner/admin/office/super_admin) gated. Tech-role NEVER sees a 3B
 * endpoint — these are dispatch surface, not field surface.
 *
 * Endpoints:
 *   POST /scan                      Run the scanner for [from..to] window,
 *                                   optionally scoped to one user. Inserts
 *                                   pending proposals + auto-dismisses
 *                                   full-day approved-leave overlaps.
 *
 *   GET  /proposals                 Filterable list of proposals joined
 *                                   with user / job / client / leave
 *                                   request context.
 *
 *   POST /proposals/:id/confirm     Decide a proposal: writes a row to
 *                                   employee_attendance_log via the
 *                                   extracted unexcused-ladder helper
 *                                   (which also drives the discipline
 *                                   ladder). Defaults to 'absent' type
 *                                   for all kinds.
 *
 *   POST /proposals/:id/dismiss     Mark a proposal dismissed without
 *                                   writing to the attendance log.
 *
 * Cross-tenant: every load + every UPDATE WHERE clause is guarded by
 * req.auth.companyId. 404 (not 403) when the proposal belongs to
 * another tenant — we don't leak the existence of the ID.
 *
 * Concurrency: confirm uses SELECT … FOR UPDATE + UPDATE with status
 * WHERE clause + rowCount===1 check. A second confirm racing the first
 * gets a 409.
 */
import { Router, type Response } from "express";
import { db } from "@workspace/db";
import {
  attendanceProposalsTable,
  jobsTable,
  jobTechniciansTable,
  jobClockEventsTable,
  leaveRequestsTable,
  usersTable,
  clientsTable,
  leaveTypesTable,
} from "@workspace/db/schema";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { parseScheduledTime } from "../lib/parse-scheduled-time.js";
import {
  classifyDiscrepancy,
  type ApprovedLeaveWindow,
  type ClockEventForOverlay,
  type ScheduledAssignment,
} from "../lib/attendance-discrepancy.js";
import { recordUnexcusedEntryAndDriveLadder } from "../lib/unexcused-ladder-writer.js";
import { validateScanWindow } from "../lib/scan-window.js";

const router = Router();

const officeGate = requireRole("owner", "admin", "office", "super_admin");

router.use(requireAuth);
router.use(officeGate);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(res: Response, message: string, code?: string) {
  return res.status(400).json({ error: "Bad Request", message, code });
}
function notFound(res: Response, message: string) {
  return res.status(404).json({ error: "Not Found", message });
}

// ─────────────────────────────────────────────────────────────────────────────
// Chicago wall-clock helpers
// ─────────────────────────────────────────────────────────────────────────────

const chicagoDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const chicagoTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
});

function toChicagoDate(d: Date): string {
  // en-CA + 2-digit gives YYYY-MM-DD.
  return chicagoDateFormatter.format(d);
}

function toChicagoMinutesOfDay(d: Date): number {
  // en-US 24h "HH:MM". Chrome ICU sometimes emits "24:MM" at the day
  // boundary — normalize.
  const s = chicagoTimeFormatter.format(d);
  const [hStr, mStr] = s.split(":");
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(h)) h = 0;
  if (h === 24) h = 0;
  return h * 60 + m;
}

function addDaysIso(iso: string, days: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const t = Date.UTC(y, m - 1, d) + days * 24 * 60 * 60 * 1000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /scan
// ─────────────────────────────────────────────────────────────────────────────

router.post("/scan", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const v = validateScanWindow({
    from_date: req.body?.from_date,
    to_date: req.body?.to_date,
    user_id: req.body?.user_id,
    today: toChicagoDate(new Date()),
  });
  if (!v.ok) return res.status(v.status).json({ error: "Bad Request", message: v.message, code: v.code });

  // 1) Scheduled assignments in the window. Union jobs.assigned_user_id
  //    (the legacy single-tech mirror) with job_technicians rows. Skip
  //    cancelled jobs and rows with no scheduled_date (defensive — the
  //    column is NOT NULL on jobs, but defensive against future schema
  //    drift).
  const jobsRaw = await db
    .select({
      id: jobsTable.id,
      scheduled_date: jobsTable.scheduled_date,
      scheduled_time: jobsTable.scheduled_time,
      estimated_hours: jobsTable.estimated_hours,
      assigned_user_id: jobsTable.assigned_user_id,
      status: jobsTable.status,
    })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.company_id, companyId),
        gte(jobsTable.scheduled_date, v.from_date),
        lte(jobsTable.scheduled_date, v.to_date),
      ),
    );
  const activeJobs = jobsRaw.filter(
    (j) => j.status !== "cancelled" && j.scheduled_date != null,
  );

  const jobIds = activeJobs.map((j) => j.id);
  const techRows: Array<{ job_id: number; user_id: number }> =
    jobIds.length === 0
      ? []
      : await db
          .select({
            job_id: jobTechniciansTable.job_id,
            user_id: jobTechniciansTable.user_id,
          })
          .from(jobTechniciansTable)
          .where(
            and(
              eq(jobTechniciansTable.company_id, companyId),
              inArray(jobTechniciansTable.job_id, jobIds),
            ),
          );

  // Build (job_id, user_id, scheduled_date, scheduled_time_minutes, estimated_hours)
  // assignment tuples. Filter by optional user_id scope.
  const assignmentSet = new Map<string, ScheduledAssignment>();
  const keyOf = (jobId: number, userId: number, date: string) =>
    `${jobId}|${userId}|${date}`;
  for (const j of activeJobs) {
    const time_minutes = parseScheduledTime(j.scheduled_time);
    const est = j.estimated_hours != null ? Number(j.estimated_hours) : null;
    const seen = new Set<number>();
    if (j.assigned_user_id != null) seen.add(j.assigned_user_id);
    for (const r of techRows) {
      if (r.job_id === j.id) seen.add(r.user_id);
    }
    for (const uid of seen) {
      if (v.user_id != null && uid !== v.user_id) continue;
      const k = keyOf(j.id, uid, String(j.scheduled_date));
      if (assignmentSet.has(k)) continue;
      assignmentSet.set(k, {
        job_id: j.id,
        user_id: uid,
        scheduled_date: String(j.scheduled_date),
        scheduled_time_minutes: time_minutes,
        estimated_hours: est,
      });
    }
  }
  const assignments = Array.from(assignmentSet.values());

  // 2) Clock events: include a 1-day margin for cross-midnight shifts.
  const evWindowStart = addDaysIso(v.from_date, -1);
  const evWindowEndExclusive = addDaysIso(v.to_date, 2); // gives margin past the last day
  const userIds = Array.from(new Set(assignments.map((a) => a.user_id)));
  const eventRows =
    jobIds.length === 0 || userIds.length === 0
      ? []
      : await db
          .select({
            id: jobClockEventsTable.id,
            job_id: jobClockEventsTable.job_id,
            user_id: jobClockEventsTable.user_id,
            event_type: jobClockEventsTable.event_type,
            event_at: jobClockEventsTable.event_at,
            is_correction: jobClockEventsTable.is_correction,
            correction_of_event_id: jobClockEventsTable.correction_of_event_id,
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
              inArray(jobClockEventsTable.job_id, jobIds),
              inArray(jobClockEventsTable.user_id, userIds),
              gte(
                jobClockEventsTable.event_at,
                new Date(`${evWindowStart}T00:00:00Z`),
              ),
              lte(
                jobClockEventsTable.event_at,
                new Date(`${evWindowEndExclusive}T00:00:00Z`),
              ),
            ),
          );

  const events: ClockEventForOverlay[] = eventRows.map((e) => {
    const at = e.event_at instanceof Date ? e.event_at : new Date(String(e.event_at));
    return {
      id: e.id,
      job_id: e.job_id,
      user_id: e.user_id,
      event_type: e.event_type as "clock_in" | "clock_out",
      event_at: at,
      event_date: toChicagoDate(at),
      event_minutes_of_day: toChicagoMinutesOfDay(at),
      is_correction: !!e.is_correction,
      correction_of_event_id: e.correction_of_event_id ?? null,
      gps_status: e.gps_status,
      latitude: e.latitude as number | string | null,
      longitude: e.longitude as number | string | null,
      exception_reason: e.exception_reason,
      exception_reviewed_at: e.exception_reviewed_at as Date | string | null,
    };
  });

  // 3) Approved leave windows overlapping the scan window.
  const leaveRows =
    userIds.length === 0
      ? []
      : await db
          .select({
            id: leaveRequestsTable.id,
            user_id: leaveRequestsTable.user_id,
            start_date: leaveRequestsTable.start_date,
            end_date: leaveRequestsTable.end_date,
            hours: leaveRequestsTable.hours,
          })
          .from(leaveRequestsTable)
          .where(
            and(
              eq(leaveRequestsTable.company_id, companyId),
              eq(leaveRequestsTable.status, "approved"),
              inArray(leaveRequestsTable.user_id, userIds),
              lte(leaveRequestsTable.start_date, v.to_date),
              gte(leaveRequestsTable.end_date, v.from_date),
            ),
          );
  const leaves: ApprovedLeaveWindow[] = leaveRows.map((l) => ({
    leave_request_id: l.id,
    user_id: l.user_id,
    start_date: String(l.start_date),
    end_date: String(l.end_date),
    hours: Number(l.hours),
  }));

  // 4) Classify + insert. Per-assignment small txn (ON CONFLICT DO NOTHING).
  const now = new Date();
  const nowDate = toChicagoDate(now);
  const nowMinutes = toChicagoMinutesOfDay(now);

  let new_proposals = 0;
  let auto_dismissed_due_to_leave = 0;
  let skipped_due_to_existing_proposal = 0;
  for (const a of assignments) {
    const r = classifyDiscrepancy(a, events, leaves, nowMinutes, nowDate);
    if (r.kind === "on_time") continue;
    const isAutoDismiss = r.suppressed_by_leave;
    const inserted = await db
      .insert(attendanceProposalsTable)
      .values({
        company_id: companyId,
        user_id: a.user_id,
        job_id: a.job_id,
        scheduled_date: a.scheduled_date,
        scheduled_time_minutes: a.scheduled_time_minutes,
        estimated_hours:
          a.estimated_hours != null ? a.estimated_hours.toFixed(2) : null,
        kind: r.kind,
        status: isAutoDismiss ? "dismissed" : "pending",
        minutes_late: r.minutes_late,
        minutes_short: r.minutes_short,
        clock_in_event_id: r.clock_in_event_id,
        clock_out_event_id: r.clock_out_event_id,
        leave_request_id: r.leave_request_id,
        decided_at: isAutoDismiss ? new Date() : null,
        decided_by_user_id: null,
        decision_note: isAutoDismiss
          ? `auto-reconciled: approved leave #${r.leave_request_id}`
          : null,
      })
      .onConflictDoNothing({
        target: [
          attendanceProposalsTable.company_id,
          attendanceProposalsTable.user_id,
          attendanceProposalsTable.job_id,
          attendanceProposalsTable.scheduled_date,
        ],
      })
      .returning({ id: attendanceProposalsTable.id });
    if (inserted.length === 0) {
      skipped_due_to_existing_proposal += 1;
    } else if (isAutoDismiss) {
      auto_dismissed_due_to_leave += 1;
    } else {
      new_proposals += 1;
    }
  }

  return res.json({
    data: {
      scanned_assignments: assignments.length,
      new_proposals,
      auto_dismissed_due_to_leave,
      skipped_due_to_existing_proposal,
      from_date: v.from_date,
      to_date: v.to_date,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /proposals
// ─────────────────────────────────────────────────────────────────────────────

router.get("/proposals", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const statusParam = (req.query.status as string | undefined) ?? "pending";
  const statuses = statusParam
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s === "pending" || s === "confirmed" || s === "dismissed");
  if (statuses.length === 0) {
    return bad(res, "status must be one or more of pending,confirmed,dismissed");
  }
  const from = (req.query.from_date as string | undefined) ?? "";
  const to = (req.query.to_date as string | undefined) ?? "";
  if (!ISO_DATE_RE.test(from)) return bad(res, "from_date YYYY-MM-DD required");
  if (!ISO_DATE_RE.test(to)) return bad(res, "to_date YYYY-MM-DD required");
  const userIdQ = req.query.user_id ? Number(req.query.user_id) : null;
  const kindQ = (req.query.kind as string | undefined) ?? null;

  const whereParts = [
    eq(attendanceProposalsTable.company_id, companyId),
    inArray(attendanceProposalsTable.status, statuses as ("pending" | "confirmed" | "dismissed")[]),
    gte(attendanceProposalsTable.scheduled_date, from),
    lte(attendanceProposalsTable.scheduled_date, to),
  ];
  if (userIdQ != null && Number.isFinite(userIdQ)) {
    whereParts.push(eq(attendanceProposalsTable.user_id, userIdQ));
  }
  if (kindQ === "late" || kindQ === "short" || kindQ === "no_show" || kindQ === "missing_clockout") {
    whereParts.push(eq(attendanceProposalsTable.kind, kindQ));
  }

  const rows = await db
    .select({
      id: attendanceProposalsTable.id,
      company_id: attendanceProposalsTable.company_id,
      user_id: attendanceProposalsTable.user_id,
      job_id: attendanceProposalsTable.job_id,
      scheduled_date: attendanceProposalsTable.scheduled_date,
      scheduled_time_minutes: attendanceProposalsTable.scheduled_time_minutes,
      estimated_hours: attendanceProposalsTable.estimated_hours,
      kind: attendanceProposalsTable.kind,
      status: attendanceProposalsTable.status,
      minutes_late: attendanceProposalsTable.minutes_late,
      minutes_short: attendanceProposalsTable.minutes_short,
      clock_in_event_id: attendanceProposalsTable.clock_in_event_id,
      clock_out_event_id: attendanceProposalsTable.clock_out_event_id,
      leave_request_id: attendanceProposalsTable.leave_request_id,
      created_at: attendanceProposalsTable.created_at,
      decided_at: attendanceProposalsTable.decided_at,
      decision_note: attendanceProposalsTable.decision_note,
      user_first_name: usersTable.first_name,
      user_last_name: usersTable.last_name,
      client_first_name: clientsTable.first_name,
      client_last_name: clientsTable.last_name,
      client_address: clientsTable.address,
      leave_start_date: leaveRequestsTable.start_date,
      leave_end_date: leaveRequestsTable.end_date,
      leave_type_display_name: leaveTypesTable.display_name,
    })
    .from(attendanceProposalsTable)
    .leftJoin(usersTable, eq(attendanceProposalsTable.user_id, usersTable.id))
    .leftJoin(jobsTable, eq(attendanceProposalsTable.job_id, jobsTable.id))
    .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
    .leftJoin(
      leaveRequestsTable,
      eq(attendanceProposalsTable.leave_request_id, leaveRequestsTable.id),
    )
    .leftJoin(
      leaveTypesTable,
      eq(leaveRequestsTable.leave_type_id, leaveTypesTable.id),
    )
    .where(and(...whereParts));

  const data = rows.map((r) => {
    const proposed_unexcused_hours_default = (() => {
      if (r.kind === "late") return r.minutes_late != null ? r.minutes_late / 60 : null;
      if (r.kind === "short") return r.minutes_short != null ? r.minutes_short / 60 : null;
      if (r.kind === "no_show") return r.estimated_hours != null ? Number(r.estimated_hours) : 8;
      // missing_clockout — office must provide via override.
      return null;
    })();
    const display_label = (() => {
      if (r.kind === "late") return `Late by ${r.minutes_late ?? 0} min`;
      if (r.kind === "short") {
        const est = r.estimated_hours != null ? Number(r.estimated_hours) : null;
        return est != null
          ? `Short by ${r.minutes_short ?? 0} min vs ${est}h scheduled`
          : `Short by ${r.minutes_short ?? 0} min`;
      }
      if (r.kind === "no_show") return "No clock-in";
      return "Clocked in, never clocked out";
    })();
    return {
      ...r,
      proposed_attendance_type_default: "absent" as const,
      proposed_unexcused_hours_default,
      display_label,
    };
  });

  return res.json({ data });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /proposals/:id/confirm
// ─────────────────────────────────────────────────────────────────────────────

router.post("/proposals/:id/confirm", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const actingUserId = req.auth!.userId!;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return bad(res, "Invalid id");
  const body = req.body as {
    override_attendance_type?: "absent" | "tardy" | "ncns";
    override_hours?: number;
    decision_note?: string;
    protected?: boolean;
  };

  return await db.transaction(async (tx) => {
    // SELECT … FOR UPDATE on the proposal row, tenant-guarded.
    const proposalRows = await tx.execute(
      sql`SELECT * FROM attendance_proposals
          WHERE id = ${id} AND company_id = ${companyId}
          FOR UPDATE`,
    );
    const row = (proposalRows as { rows?: any[] }).rows?.[0];
    if (!row) {
      return notFound(res, "Proposal not found");
    }
    if (row.status !== "pending") {
      return res
        .status(409)
        .json({ error: "Conflict", message: `Proposal is already ${row.status}` });
    }

    if (row.kind === "missing_clockout" && body?.override_attendance_type == null && body?.override_hours == null) {
      return res.status(400).json({
        error: "Bad Request",
        message:
          "Resolve via 1C clock correction or provide override_hours + override_attendance_type",
        code: "missing_clockout_requires_override",
      });
    }

    const resolvedType: "absent" | "tardy" | "ncns" =
      body?.override_attendance_type === "tardy" ||
      body?.override_attendance_type === "ncns" ||
      body?.override_attendance_type === "absent"
        ? body.override_attendance_type
        : "absent";

    let resolvedHours: number | null = null;
    if (typeof body?.override_hours === "number" && Number.isFinite(body.override_hours) && body.override_hours > 0) {
      resolvedHours = body.override_hours;
    } else if (row.kind === "late" && row.minutes_late != null) {
      resolvedHours = Number(row.minutes_late) / 60;
    } else if (row.kind === "short" && row.minutes_short != null) {
      resolvedHours = Number(row.minutes_short) / 60;
    } else if (row.kind === "no_show") {
      resolvedHours = row.estimated_hours != null ? Number(row.estimated_hours) : 8;
    }
    if (resolvedHours == null || !(resolvedHours > 0)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Could not resolve hours; supply override_hours",
        code: "hours_required",
      });
    }

    const ladder = await recordUnexcusedEntryAndDriveLadder(tx as any, {
      company_id: companyId,
      employee_id: Number(row.user_id),
      log_date: String(row.scheduled_date),
      hours: resolvedHours,
      type: resolvedType,
      protected: body?.protected ?? false,
      note: body?.decision_note ?? undefined,
      logged_by: actingUserId,
    });

    // Update the proposal; second writer racing us sees rowCount 0
    // because status='pending' clause no longer matches.
    const updated = await tx.execute(
      sql`UPDATE attendance_proposals
          SET status = 'confirmed',
              decided_at = now(),
              decided_by_user_id = ${actingUserId},
              decision_note = ${body?.decision_note ?? null},
              created_attendance_log_id = ${ladder.attendance_log_id}
          WHERE id = ${id}
            AND company_id = ${companyId}
            AND status = 'pending'`,
    );
    const rowCount = (updated as { rowCount?: number }).rowCount ?? 0;
    if (rowCount !== 1) {
      // Race: another confirm got there first. Surface as 409.
      return res.status(409).json({ error: "Conflict", message: "Proposal status changed during confirm" });
    }

    return res.json({
      data: {
        proposal: {
          id,
          status: "confirmed",
          decided_at: new Date().toISOString(),
          decided_by_user_id: actingUserId,
        },
        attendance_log_id: ladder.attendance_log_id,
        ladder_eval: ladder.ladder_eval,
        discipline_log_id: ladder.discipline_log_id,
        notification_sent: ladder.notification_sent,
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /proposals/:id/dismiss
// ─────────────────────────────────────────────────────────────────────────────

router.post("/proposals/:id/dismiss", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const actingUserId = req.auth!.userId!;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return bad(res, "Invalid id");
  const note = (req.body?.decision_note as string | undefined) ?? null;

  return await db.transaction(async (tx) => {
    const rows = await tx.execute(
      sql`SELECT id, status FROM attendance_proposals
          WHERE id = ${id} AND company_id = ${companyId}
          FOR UPDATE`,
    );
    const row = (rows as { rows?: any[] }).rows?.[0];
    if (!row) return notFound(res, "Proposal not found");
    if (row.status !== "pending") {
      return res
        .status(409)
        .json({ error: "Conflict", message: `Proposal is already ${row.status}` });
    }
    const updated = await tx.execute(
      sql`UPDATE attendance_proposals
          SET status = 'dismissed',
              decided_at = now(),
              decided_by_user_id = ${actingUserId},
              decision_note = ${note}
          WHERE id = ${id}
            AND company_id = ${companyId}
            AND status = 'pending'`,
    );
    const rowCount = (updated as { rowCount?: number }).rowCount ?? 0;
    if (rowCount !== 1) {
      return res.status(409).json({ error: "Conflict", message: "Proposal status changed during dismiss" });
    }
    return res.json({
      data: { id, status: "dismissed" },
    });
  });
});

// Defensive: silence unused-import errors when the file compiles with
// stricter eslint settings. (or + isNotNull are reserved for future
// filter cases — keep imports stable so future edits don't churn the
// import list.)
void or;
void isNotNull;

export default router;
