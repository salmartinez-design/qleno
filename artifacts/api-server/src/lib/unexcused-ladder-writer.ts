/**
 * Cutover 3B — Extracted shared helper that drives the cumulative
 * unexcused-hours ladder.
 *
 * Before 3B this block was inlined in routes/leave.ts (the body of
 * POST /api/leave/unexcused/record). The attendance-overlay's
 * /proposals/:id/confirm endpoint needs the IDENTICAL behavior — insert
 * a row into employee_attendance_log, load policy + rolling window of
 * recent attendance entries + already-fired thresholds, evaluate the
 * ladder, optionally write a discipline row + fire the office
 * notification.
 *
 * Both call sites share this helper so they cannot drift. The 3A
 * test suite (cutover-3a-leave.test.ts) is the contract — refactoring
 * leave.ts to call this MUST be byte-identical or the 3A tests fail.
 *
 * Notes regex marker: the `notes` field on the inserted attendance_log
 * row uses the format `unexcused hours: X.XX (<optional note>)`. The
 * ladder reads hours back out of `notes` via the existing
 * `/unexcused hours:\s*([0-9.]+)/i` regex (see body below). Do NOT
 * change the marker format without updating BOTH the regex here AND
 * any code that reads it.
 */
import {
  companyAttendancePolicyTable,
  employeeAttendanceLogTable,
  employeeDisciplineLogTable,
  usersTable,
} from "@workspace/db/schema";
import { and, eq, gte, lte } from "drizzle-orm";
import {
  evaluateLadder,
  evaluateOccurrenceLadder,
  type LadderEvaluation,
  type UnexcusedStep,
  type UnexcusedEntry,
  type OccurrenceStep,
} from "./unexcused-ladder.js";
import { benefitYearStartDate } from "./leave-grant-reset.js";

/**
 * `tx` accepts the global db handle OR a transaction handle. Drizzle's
 * tx and db share the same query API for the .select/.insert calls we
 * use here, so a permissive type avoids forcing transaction callers to
 * cast. Typed as `any` deliberately — both the runtime db handle and
 * a drizzle tx handle are valid; importing `typeof db` here would
 * trigger the drizzle initializer in unit tests that otherwise stay
 * DB-free.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbOrTx = any;

export interface UnexcusedLadderArgs {
  company_id: number;
  employee_id: number;
  /** YYYY-MM-DD */
  log_date: string;
  /** Hours to credit toward the ladder for this entry. */
  hours: number;
  /** Attendance enum value. Only "absent" feeds the ladder (consistent
   *  with the prior inlined behavior). "tardy" / "ncns" are stored but
   *  the ladder window query filters on type='absent'. */
  type: "absent" | "tardy" | "ncns";
  protected?: boolean;
  /** Optional human/system context. Appended to the notes regex
   *  marker as `unexcused hours: X.XX (<note>)`. */
  note?: string;
  /** NULL = system-recorded (auto-tardy sweep); a user id = office record. */
  logged_by: number | null;
}

export interface UnexcusedLadderResult {
  attendance_log_id: number;
  ladder_eval: LadderEvaluation;
  discipline_log_id: number | null;
  notification_sent: boolean;
}

/**
 * Best-effort, COMMS_ENABLED-gated, never throw. Mirrors the helper
 * formerly in routes/leave.ts (moved here in 3B). The leave.ts route
 * imports it from this module so both call sites stay in sync.
 */
export async function notifyOfficeOfDisciplineSilent(
  companyId: number,
  employeeId: number,
  step: UnexcusedStep,
  cumulativeHours: number,
): Promise<void> {
  try {
    if (process.env.COMMS_ENABLED !== "true") return;
    // eslint-disable-next-line no-console
    console.log(
      `[unexcused-ladder] company ${companyId} employee ${employeeId} crossed ${step.threshold_hours}h (cum=${cumulativeHours.toFixed(2)}h) → ${step.discipline_type}`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[unexcused-ladder] notify failed (non-fatal):", err);
  }
}

/**
 * Insert an attendance_log entry + evaluate the cumulative-hours
 * ladder + (if a threshold fires) insert a discipline_log row +
 * (best-effort) notify the office.
 *
 * Idempotency: the caller is responsible for not calling this twice
 * for the same (employee, date, source). The attendance-overlay
 * confirm path enforces this via the proposal status transition
 * (only `pending` rows can transition to `confirmed` via a SELECT
 * FOR UPDATE).
 */
export async function recordUnexcusedEntryAndDriveLadder(
  tx: DbOrTx,
  args: UnexcusedLadderArgs,
): Promise<UnexcusedLadderResult> {
  const hours = Number(args.hours);
  const noteSuffix = args.note && args.note.trim() !== "" ? ` (${args.note.trim()})` : "";
  const insertedLog = await tx
    .insert(employeeAttendanceLogTable)
    .values({
      company_id: args.company_id,
      employee_id: args.employee_id,
      log_date: args.log_date,
      type: args.type,
      protected: args.protected ?? false,
      notes: `unexcused hours: ${hours.toFixed(2)}${noteSuffix}`,
      logged_by: args.logged_by,
    })
    .returning({ id: employeeAttendanceLogTable.id });
  const attendance_log_id = insertedLog[0]!.id;

  // Drive the ladder. Pull the policy ladders (occurrence + legacy hours).
  const policyRow = await tx
    .select({
      unexcused_hours_steps: companyAttendancePolicyTable.unexcused_hours_steps,
      unexcused_occurrence_steps: companyAttendancePolicyTable.unexcused_occurrence_steps,
      tardy_occurrence_steps: companyAttendancePolicyTable.tardy_occurrence_steps,
    })
    .from(companyAttendancePolicyTable)
    .where(eq(companyAttendancePolicyTable.company_id, args.company_id))
    .limit(1);

  // [PHES occurrence ladder] If occurrence steps are configured for this
  // incident kind, drive discipline off the per-Benefit-Year OCCURRENCE COUNT
  // and return. Otherwise fall through to the legacy cumulative-hours ladder
  // (so any tenant still on hours keeps working, and the 3B hours tests pass).
  const kind: "tardy" | "unexcused" = args.type === "tardy" ? "tardy" : "unexcused";
  const occSteps = (((kind === "tardy"
    ? policyRow[0]?.tardy_occurrence_steps
    : policyRow[0]?.unexcused_occurrence_steps) as OccurrenceStep[] | null) ?? []) as OccurrenceStep[];
  if (occSteps.length > 0) {
    return await driveOccurrenceLadder(tx, args, attendance_log_id, kind, occSteps);
  }
  const steps = ((policyRow[0]?.unexcused_hours_steps as UnexcusedStep[] | null) ??
    []) as UnexcusedStep[];
  if (steps.length === 0) {
    return {
      attendance_log_id,
      ladder_eval: { triggered_step: null, cumulative_hours: 0, as_of: args.log_date },
      discipline_log_id: null,
      notification_sent: false,
    };
  }

  const maxWindow = Math.max(...steps.map((s) => s.window_days), 0);
  const windowStart = (() => {
    const d = new Date(`${args.log_date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - maxWindow);
    return d.toISOString().slice(0, 10);
  })();
  const entries = await tx
    .select({
      log_date: employeeAttendanceLogTable.log_date,
      notes: employeeAttendanceLogTable.notes,
    })
    .from(employeeAttendanceLogTable)
    .where(
      and(
        eq(employeeAttendanceLogTable.company_id, args.company_id),
        eq(employeeAttendanceLogTable.employee_id, args.employee_id),
        eq(employeeAttendanceLogTable.type, "absent"),
        gte(employeeAttendanceLogTable.log_date, windowStart),
        lte(employeeAttendanceLogTable.log_date, args.log_date),
      ),
    );
  // Parse hours back out of the notes field (we stored
  // "unexcused hours: 8.00" — this is a stopgap until a dedicated
  // hours column exists on attendance_log). Fall back to 8h
  // per absence row if the notes don't match.
  const parsed: UnexcusedEntry[] = (entries as Array<{ log_date: unknown; notes: string | null }>).map((e) => {
    const m = /unexcused hours:\s*([0-9.]+)/i.exec(e.notes ?? "");
    return {
      date: String(e.log_date),
      hours: m ? Number(m[1]) : 8,
    };
  });
  const recentDiscipline = await tx
    .select({
      reason: employeeDisciplineLogTable.reason,
    })
    .from(employeeDisciplineLogTable)
    .where(
      and(
        eq(employeeDisciplineLogTable.company_id, args.company_id),
        eq(employeeDisciplineLogTable.employee_id, args.employee_id),
      ),
    );
  const alreadyFired = new Set<number>();
  for (const d of recentDiscipline as Array<{ reason: string | null }>) {
    const m = /\bunexcused-ladder\s+t=(\d+(?:\.\d+)?)/i.exec(d.reason ?? "");
    if (m) alreadyFired.add(Number(m[1]));
  }
  const evalResult = evaluateLadder(steps, parsed, args.log_date, alreadyFired);
  if (!evalResult.triggered_step) {
    return {
      attendance_log_id,
      ladder_eval: evalResult,
      discipline_log_id: null,
      notification_sent: false,
    };
  }
  const step = evalResult.triggered_step;
  const insertedDiscipline = await tx
    .insert(employeeDisciplineLogTable)
    .values({
      company_id: args.company_id,
      employee_id: args.employee_id,
      discipline_type: step.discipline_type,
      custom_label: step.label ?? null,
      reason: `unexcused-ladder t=${step.threshold_hours} window=${step.window_days}d cum=${evalResult.cumulative_hours.toFixed(2)}h`,
      effective_date: args.log_date,
      issued_by: args.logged_by,
      pending_review: true,
    })
    .returning({ id: employeeDisciplineLogTable.id });
  let notification_sent = false;
  if (step.notify) {
    void notifyOfficeOfDisciplineSilent(
      args.company_id,
      args.employee_id,
      step,
      evalResult.cumulative_hours,
    );
    notification_sent = true;
  }
  return {
    attendance_log_id,
    ladder_eval: evalResult,
    discipline_log_id: insertedDiscipline[0]?.id ?? null,
    notification_sent,
  };
}

/**
 * Occurrence-based disciplinary ladder (PHES, Sal 2026-06-24).
 *
 * Counts INCIDENTS of one kind (unexcused absence OR tardy) within the
 * employee's current Benefit Year (work anniversary — the same boundary the
 * leave engine uses) and fires the matching discipline step. Idempotent per
 * (kind, benefit-year, occurrence) via a reason marker; a new benefit year
 * resets the counter so the same step can fire again next year.
 */
async function driveOccurrenceLadder(
  tx: DbOrTx,
  args: UnexcusedLadderArgs,
  attendance_log_id: number,
  kind: "tardy" | "unexcused",
  steps: OccurrenceStep[],
): Promise<UnexcusedLadderResult> {
  const attType = kind === "tardy" ? "tardy" : "absent";
  const marker = kind === "tardy" ? "tardy-occ" : "unexcused-occ";
  const nullResult: UnexcusedLadderResult = {
    attendance_log_id,
    ladder_eval: { triggered_step: null, cumulative_hours: 0, as_of: args.log_date },
    discipline_log_id: null,
    notification_sent: false,
  };

  // Benefit-year window (work anniversary), reused from the leave engine.
  const u = await tx
    .select({ hire_date: usersTable.hire_date })
    .from(usersTable)
    .where(eq(usersTable.id, args.employee_id))
    .limit(1);
  const hireDate = u[0]?.hire_date ? String(u[0].hire_date).slice(0, 10) : args.log_date;
  const byStart = benefitYearStartDate(hireDate, args.log_date).toISOString().slice(0, 10);

  // Count this kind's NON-protected occurrences in the current benefit year
  // (includes the row just inserted).
  const rows = await tx
    .select({
      is_protected: employeeAttendanceLogTable.protected,
    })
    .from(employeeAttendanceLogTable)
    .where(
      and(
        eq(employeeAttendanceLogTable.company_id, args.company_id),
        eq(employeeAttendanceLogTable.employee_id, args.employee_id),
        eq(employeeAttendanceLogTable.type, attType),
        gte(employeeAttendanceLogTable.log_date, byStart),
        lte(employeeAttendanceLogTable.log_date, args.log_date),
      ),
    );
  const occurrenceCount = (rows as Array<{ is_protected: boolean | null }>).filter(
    (r) => !r.is_protected,
  ).length;

  // Already-fired steps for THIS kind + THIS benefit year (idempotent).
  const disc = await tx
    .select({ reason: employeeDisciplineLogTable.reason })
    .from(employeeDisciplineLogTable)
    .where(
      and(
        eq(employeeDisciplineLogTable.company_id, args.company_id),
        eq(employeeDisciplineLogTable.employee_id, args.employee_id),
      ),
    );
  const fired = new Set<number>();
  const re = new RegExp(`\\b${marker}\\s+s=(\\d+)\\s+by=${byStart}\\b`, "i");
  for (const d of disc as Array<{ reason: string | null }>) {
    const m = re.exec(d.reason ?? "");
    if (m) fired.add(Number(m[1]));
  }

  const evalResult = evaluateOccurrenceLadder(steps, occurrenceCount, fired);
  if (!evalResult.triggered_step) return nullResult;

  const step = evalResult.triggered_step;
  const insertedDiscipline = await tx
    .insert(employeeDisciplineLogTable)
    .values({
      company_id: args.company_id,
      employee_id: args.employee_id,
      discipline_type: step.discipline_type,
      custom_label: step.label ?? null,
      reason: `${marker} s=${step.occurrence} by=${byStart} count=${occurrenceCount}`,
      effective_date: args.log_date,
      issued_by: args.logged_by,
      pending_review: true,
    })
    .returning({ id: employeeDisciplineLogTable.id });

  let notification_sent = false;
  if (step.notify) {
    // Reuse the existing (COMMS-gated) office-alert pattern; surface the
    // occurrence count via the shared shape (window_days unused here).
    void notifyOfficeOfDisciplineSilent(
      args.company_id,
      args.employee_id,
      { threshold_hours: step.occurrence, window_days: 0, discipline_type: step.discipline_type, label: step.label ?? `${marker} #${step.occurrence}`, notify: true },
      occurrenceCount,
    );
    notification_sent = true;
  }
  return {
    attendance_log_id,
    ladder_eval: { triggered_step: null, cumulative_hours: 0, as_of: args.log_date },
    discipline_log_id: insertedDiscipline[0]?.id ?? null,
    notification_sent,
  };
}
