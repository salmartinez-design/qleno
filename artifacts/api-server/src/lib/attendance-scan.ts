/**
 * [attendance-scan-cron 2026-08-21] The unexcused-absence scanner, lifted out
 * of the POST /api/attendance-overlay/scan route body so something other than a
 * button can run it.
 *
 * THE GAP THIS CLOSES. Tardies have been swept nightly since 2026-07-07
 * (lib/auto-tardy.ts). Unexcused absences never were: the only caller of the
 * scanner was the dispatch board's "Run scan" button, scoped to whichever single
 * date the operator happened to be looking at (pages/jobs.tsx — `from_date:
 * selectedDate, to_date: selectedDate`). Nobody clicking meant no proposals,
 * which meant no attendance-log rows, which meant an Attendance tab that looked
 * clean and a disciplinary ladder that never advanced. The engine was fine; it
 * simply never ran.
 *
 * WHY A NIGHTLY SCAN IS SAFE. The scanner writes `attendance_proposals` rows in
 * status `pending` — it does NOT write `employee_attendance_log` and it does NOT
 * touch the discipline ladder. A human still confirms each proposal at
 * POST /proposals/:id/confirm, which is the only path that records attendance.
 * So the cron fills the office's review queue and nothing else; it can never
 * discipline someone on its own. That is the same "no money (or discipline)
 * moves automatically" principle the mileage engine follows.
 *
 * Idempotent: runScanInsertLoop inserts ON CONFLICT DO NOTHING against the
 * proposal's natural key, so re-scanning a date the office already reviewed adds
 * nothing and cannot resurrect a dismissed proposal.
 */
import { db } from "@workspace/db";
import {
  jobsTable,
  jobTechniciansTable,
  jobClockEventsTable,
  leaveRequestsTable,
} from "@workspace/db/schema";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  type ApprovedLeaveWindow,
  type ClockEventForOverlay,
  type ScheduledAssignment,
} from "./attendance-discrepancy.js";
import {
  addDaysIso,
  runScanInsertLoop,
  toChicagoDate,
  toChicagoMinutesOfDay,
} from "./attendance-overlay-handlers.js";
import { parseScheduledTime } from "./parse-scheduled-time.js";
import { tzOf } from "./company-tz.js";

export interface AttendanceScanResult {
  scanned_assignments: number;
  from_date: string;
  to_date: string;
  [k: string]: unknown;
}

/**
 * Scan one tenant's window for attendance discrepancies and insert pending
 * proposals. Window bounds are assumed already validated (the route runs them
 * through validateScanWindow; the cron passes a single past date).
 */
export async function runAttendanceScanForCompany(
  companyId: number,
  fromDate: string,
  toDate: string,
  userId: number | null = null,
): Promise<AttendanceScanResult> {
  const tz = tzOf(companyId);

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
        gte(jobsTable.scheduled_date, fromDate),
        lte(jobsTable.scheduled_date, toDate),
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
  const keyOf = (jobId: number, uid: number, date: string) =>
    `${jobId}|${uid}|${date}`;
  for (const j of activeJobs) {
    const time_minutes = parseScheduledTime(j.scheduled_time);
    const est = j.estimated_hours != null ? Number(j.estimated_hours) : null;
    const seen = new Set<number>();
    if (j.assigned_user_id != null) seen.add(j.assigned_user_id);
    for (const r of techRows) {
      if (r.job_id === j.id) seen.add(r.user_id);
    }
    for (const uid of seen) {
      if (userId != null && uid !== userId) continue;
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
  const evWindowStart = addDaysIso(fromDate, -1);
  const evWindowEndExclusive = addDaysIso(toDate, 2); // gives margin past the last day
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
      event_date: toChicagoDate(at, tz),
      event_minutes_of_day: toChicagoMinutesOfDay(at, tz),
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
              lte(leaveRequestsTable.start_date, toDate),
              gte(leaveRequestsTable.end_date, fromDate),
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
  const nowDate = toChicagoDate(now, tz);
  const nowMinutes = toChicagoMinutesOfDay(now, tz);

  const counts = await runScanInsertLoop(db, {
    companyId,
    assignments,
    events,
    leaves,
    nowMinutes,
    nowDate,
  });

  return {
    scanned_assignments: assignments.length,
    ...counts,
    from_date: fromDate,
    to_date: toDate,
  };
}

/**
 * Nightly entry — scan YESTERDAY for every tenant, in that tenant's own zone.
 *
 * Yesterday, not today, for the same reason auto-tardy uses it: a day still in
 * progress has techs who simply haven't arrived yet, and proposing an absence
 * against them at 1 AM would be noise. Each tenant's "yesterday" is computed
 * from its own timezone so a non-Central tenant isn't scanned a day off.
 *
 * No backfill on first run — same call as auto-tardy. Retroactively proposing
 * months of absences would bury the office in a queue nobody can triage, and
 * the proposals would be un-actionable anyway (nobody remembers whether a tech
 * called off on a Tuesday in June). The office can still reach any past date
 * with the manual "Run scan" button, which is unchanged.
 */
export async function runAttendanceScanCron(): Promise<void> {
  try {
    const companies = await db.execute(sql`SELECT id FROM companies`);
    let totalProposals = 0;
    let scanned = 0;
    for (const row of (companies.rows ?? []) as Array<{ id: number }>) {
      const companyId = Number(row.id);
      try {
        // Yesterday in this tenant's zone.
        const yd = new Date(`${toChicagoDate(new Date(), tzOf(companyId))}T00:00:00Z`);
        yd.setUTCDate(yd.getUTCDate() - 1);
        const ymd = yd.toISOString().slice(0, 10);
        const r = await runAttendanceScanForCompany(companyId, ymd, ymd);
        const created = Number((r as { new_proposals?: unknown }).new_proposals ?? 0);
        totalProposals += created;
        scanned++;
        if (created > 0) {
          console.log(
            `[attendance-scan] company ${companyId} ${ymd}: ${created} new proposal(s) from ${r.scanned_assignments} assignment(s)`,
          );
        }
      } catch (err) {
        console.error(`[attendance-scan] company ${companyId} failed:`, err);
      }
    }
    console.log(
      `[attendance-scan] nightly: ${totalProposals} new proposal(s) across ${scanned} tenant(s)`,
    );
  } catch (err) {
    console.error("[attendance-scan] nightly cron error:", err);
  }
}
