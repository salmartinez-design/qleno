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
// Re-export DB-free helpers so existing route consumers (and the test
// suite) continue to import from this module. The handler bodies
// themselves live in `lib/attendance-overlay-handlers.ts` so tests
// can drive them with a fake tx without booting drizzle.
import {
  confirmProposalWithTx,
  runScanInsertLoop,
  toChicagoDate,
  toChicagoMinutesOfDay,
  type ConfirmProposalInput,
  type ConfirmProposalOutput,
  type RunScanInsertLoopInput,
  type RunScanInsertLoopOutput,
} from "../lib/attendance-overlay-handlers.js";
import { validateScanWindow } from "../lib/scan-window.js";
import { runAttendanceScanForCompany } from "../lib/attendance-scan.js";
import { tzOf } from "../lib/company-tz.js";

export {
  confirmProposalWithTx,
  runScanInsertLoop,
  toChicagoDate,
  toChicagoMinutesOfDay,
};
export type {
  ConfirmProposalInput,
  ConfirmProposalOutput,
  RunScanInsertLoopInput,
  RunScanInsertLoopOutput,
};

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
// POST /scan
// ─────────────────────────────────────────────────────────────────────────────

router.post("/scan", async (req, res) => {
  const companyId = req.auth!.companyId!;
  const v = validateScanWindow({
    from_date: req.body?.from_date,
    to_date: req.body?.to_date,
    user_id: req.body?.user_id,
    today: toChicagoDate(new Date(), tzOf(companyId)),
  });
  if (!v.ok) return res.status(v.status).json({ error: "Bad Request", message: v.message, code: v.code });

  // [attendance-scan-cron 2026-08-21] The scan body moved to
  // lib/attendance-scan.ts so the nightly cron can run the same engine. This
  // route is now validation + delegation; the behavior is unchanged.
  const data = await runAttendanceScanForCompany(companyId, v.from_date, v.to_date, v.user_id);
  return res.json({ data });
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

  const r = await db.transaction(async (tx) => {
    return await confirmProposalWithTx(tx as any, {
      companyId,
      actingUserId,
      id,
      body,
    });
  });
  // [90d-composite] A confirmed attendance violation changes the tech's
  // attendance sub-score → recompute the rolling composite. Non-fatal; runs
  // after the confirm tx commits so a recompute failure can't roll it back.
  if (r.status === 200) {
    try {
      const u = await db.execute(
        sql`SELECT user_id FROM attendance_proposals WHERE id = ${id} AND company_id = ${companyId} LIMIT 1`,
      );
      const uid = Number((u as { rows?: any[] }).rows?.[0]?.user_id);
      if (uid) {
        const { recomputeCompositeScore } = await import("../lib/scorecard-composite.js");
        await recomputeCompositeScore(companyId, uid);
      }
    } catch (e: any) {
      console.error("[scorecard-composite] recompute after attendance confirm failed (non-fatal):", e?.message ?? e);
    }
  }
  return res.status(r.status).json(r.body);
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
