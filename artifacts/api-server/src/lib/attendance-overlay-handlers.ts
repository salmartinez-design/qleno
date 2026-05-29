/**
 * Cutover 3B — DB-free handler bodies for the /attendance-overlay route.
 *
 * The Express router lives in `routes/attendance-overlay.ts` and is
 * responsible for auth, request parsing, and constructing the database
 * transaction. The actual classify+insert and confirm/dismiss logic
 * lives here so the cutover-3b-attendance test suite can drive it
 * with a fake `tx` without booting the drizzle pool.
 *
 * This file intentionally avoids importing `db` from `@workspace/db`.
 * It pulls in the schema *constants* (table identifiers) which are
 * safe — schema-only imports do not trigger `drizzle()` instantiation.
 */
import { sql } from "drizzle-orm";
import { attendanceProposalsTable } from "@workspace/db/schema";
import {
  classifyDiscrepancy,
  type ApprovedLeaveWindow,
  type ClockEventForOverlay,
  type ScheduledAssignment,
} from "./attendance-discrepancy.js";
import { recordUnexcusedEntryAndDriveLadder } from "./unexcused-ladder-writer.js";

// ─────────────────────────────────────────────────────────────────────────────
// Chicago wall-clock helpers (pure)
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

export function toChicagoDate(d: Date): string {
  // en-CA + 2-digit gives YYYY-MM-DD.
  return chicagoDateFormatter.format(d);
}

export function toChicagoMinutesOfDay(d: Date): number {
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

export function addDaysIso(iso: string, days: number): string {
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
// Scan loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test-visible inner scan loop. Exported for the E-series mocked-DB
 * tests so they can drive the classify+insert path without booting
 * Express. The caller is responsible for having already loaded
 * `assignments`, `events`, `leaves` and computed Chicago `now`.
 * Production path passes `db`; tests pass a fake.
 */
export interface RunScanInsertLoopInput {
  companyId: number;
  assignments: ScheduledAssignment[];
  events: ClockEventForOverlay[];
  leaves: ApprovedLeaveWindow[];
  nowMinutes: number;
  nowDate: string;
}

export interface RunScanInsertLoopOutput {
  new_proposals: number;
  auto_dismissed_due_to_leave: number;
  skipped_due_to_existing_proposal: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runScanInsertLoop(dbOrTx: any, input: RunScanInsertLoopInput): Promise<RunScanInsertLoopOutput> {
  const { companyId, assignments, events, leaves, nowMinutes, nowDate } = input;
  let new_proposals = 0;
  let auto_dismissed_due_to_leave = 0;
  let skipped_due_to_existing_proposal = 0;
  for (const a of assignments) {
    // Defensive: scheduled_date must be a valid YYYY-MM-DD. Skip
    // anything else (matches the route's load-time filter, but
    // double-guards the loop for tests that pass synthetic fixtures).
    if (!a.scheduled_date || !/^\d{4}-\d{2}-\d{2}$/.test(a.scheduled_date)) continue;
    const r = classifyDiscrepancy(a, events, leaves, nowMinutes, nowDate);
    if (r.kind === "on_time") continue;
    const isAutoDismiss = r.suppressed_by_leave;
    const inserted = await dbOrTx
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
  return { new_proposals, auto_dismissed_due_to_leave, skipped_due_to_existing_proposal };
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirm proposal handler
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfirmProposalInput {
  companyId: number;
  actingUserId: number;
  id: number;
  body: {
    override_attendance_type?: "absent" | "tardy" | "ncns";
    override_hours?: number;
    decision_note?: string;
    protected?: boolean;
  };
}

export interface ConfirmProposalOutput {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/**
 * Test-visible inner handler. Exported for the mocked-DB E-series so
 * tests can inject a fake tx without booting Express + Postgres. The
 * router wrapper in `routes/attendance-overlay.ts` pulls
 * companyId/userId off req.auth, runs the real db.transaction, and
 * delegates here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function confirmProposalWithTx(tx: any, input: ConfirmProposalInput): Promise<ConfirmProposalOutput> {
  const { companyId, actingUserId, id, body } = input;
  const proposalRows = await tx.execute(
    sql`SELECT * FROM attendance_proposals
        WHERE id = ${id} AND company_id = ${companyId}
        FOR UPDATE`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (proposalRows as { rows?: any[] }).rows?.[0];
  if (!row) {
    return { status: 404, body: { error: "Not Found", message: "Proposal not found" } };
  }
  if (row.status !== "pending") {
    return {
      status: 409,
      body: { error: "Conflict", message: `Proposal is already ${row.status}` },
    };
  }
  if (row.kind === "missing_clockout" && body?.override_attendance_type == null) {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: "missing_clockout proposals require override_attendance_type",
        code: "missing_clockout_requires_override",
      },
    };
  }
  const resolvedType: "absent" | "tardy" | "ncns" =
    body?.override_attendance_type === "tardy" ||
    body?.override_attendance_type === "ncns" ||
    body?.override_attendance_type === "absent"
      ? body.override_attendance_type
      : "absent";

  let resolvedHours: number | null = null;
  if (
    typeof body?.override_hours === "number" &&
    Number.isFinite(body.override_hours) &&
    body.override_hours > 0
  ) {
    resolvedHours = body.override_hours;
  } else if (row.kind === "late" && row.minutes_late != null) {
    resolvedHours = Number(row.minutes_late) / 60;
  } else if (row.kind === "short" && row.minutes_short != null) {
    resolvedHours = Number(row.minutes_short) / 60;
  } else if (row.kind === "no_show") {
    resolvedHours = row.estimated_hours != null ? Number(row.estimated_hours) : 8;
  }
  if (resolvedHours == null || !(resolvedHours > 0)) {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: "Could not resolve hours; supply override_hours",
        code: "hours_required",
      },
    };
  }

  const ladder = await recordUnexcusedEntryAndDriveLadder(tx, {
    company_id: companyId,
    employee_id: Number(row.user_id),
    log_date: String(row.scheduled_date),
    hours: resolvedHours,
    type: resolvedType,
    protected: body?.protected ?? false,
    note: body?.decision_note ?? undefined,
    logged_by: actingUserId,
  });

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
    return {
      status: 409,
      body: { error: "Conflict", message: "Proposal status changed during confirm" },
    };
  }

  return {
    status: 200,
    body: {
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
    },
  };
}
