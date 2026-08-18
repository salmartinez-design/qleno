/**
 * Auto-tardy sweep (Sal 2026-07-07: "auto-count every late clock-in").
 *
 * The handbook's 20-minute grace rule was only enforced when the office
 * manually recorded a tardy — auto-detected late clock-ins (the dispatch
 * board's LATE chips) never reached the disciplinary ladder (observed:
 * 17 lates in 180 days vs 2 recorded occurrences). This sweep closes the
 * gap: for a given service date it finds each tech's FIRST scheduled job
 * of the day and, when their real clock-in landed more than
 * GRACE_MINUTES past the scheduled start, records a tardy through the
 * same `recordUnexcusedEntryAndDriveLadder` writer the office form uses —
 * so the occurrence ladder, discipline rows, and office notification all
 * fire identically.
 *
 * Deliberate boundaries:
 *   - FIRST job of the day only. Being late to a mid-day job is routing
 *     drift (drive time, prior job ran long), not a shift tardy. The
 *     handbook's grace rule is about the scheduled shift start.
 *   - source='punched' clock rows only — synthetic 'estimated' pairs
 *     (mark-complete / MC imports) are not evidence of a late arrival.
 *   - One tardy per (employee, date), and NEVER when ANY tardy row
 *     already exists for that day (manual or auto). This is also what
 *     makes an office deletion stick: the sweep only processes a date
 *     once (yesterday, from the nightly cron), so a removed mistake is
 *     not re-inserted.
 *   - No backfill. The sweep starts with the first nightly run after
 *     deploy — retroactively feeding months of lates into the ladder
 *     would instantly put techs at termination-level counts.
 *   - The 20-minute threshold mirrors LATE_THRESHOLD_MINUTES in the
 *     dispatch board's job-status logic, so "chip says LATE" and "counts
 *     on the ladder" stay the same rule.
 */
import { db } from "@workspace/db";
import { jobsTable, timeclockTable, employeeAttendanceLogTable } from "@workspace/db/schema";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { recordUnexcusedEntryAndDriveLadder } from "./unexcused-ladder-writer.js";
import { tzOf, DEFAULT_TZ } from "./company-tz.js";

const GRACE_MINUTES = 20;

/** "HH:MM" / "H:MM" / "H:MM AM|PM" → minutes since midnight, or null. */
export function scheduledTimeToMins(t: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i.exec(String(t ?? "").trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3]?.toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * A UTC timestamp → minutes since midnight in the company's local time.
 *
 * [company-timezone 2026-08-15] The zone used to be a module-level Chicago
 * constant. It's a parameter now; omitting it keeps the prior behavior, so an
 * un-updated caller is stale rather than wrong.
 *
 * Correct ONLY for a row that really holds a UTC instant — see
 * punchMinsLocal below, which is what callers should use.
 */
export function clockInMinsLocal(at: Date, tz: string = DEFAULT_TZ): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/**
 * Minutes since local midnight for a punch, in whichever frame the row is
 * actually stored in.
 *
 * THE BUG THIS CLOSES (Maribel, 8/18): "0 lates this year" on a profile whose
 * owner had been clocking in 30–55 minutes late all month, and: "even when we
 * receive a notification that a cleaner has a late check-in, the late check-in
 * is not being recorded."
 *
 * `timeclock.clock_in_at` is `timestamp` (no zone) and holds TWO different
 * things. Since the [clock-tz 2026-06-17] fix, a field punch is stored as the
 * tenant's WALL-CLOCK — 9:55 AM Central is literally `09:55:00` in the column,
 * and `tz_normalized` marks it. Older rows are raw UTC instants: the same punch
 * stored as `14:55:00`.
 *
 * This sweep ran every row through clockInMinsLocal, which converts UTC→local.
 * On a wall-clock row that subtracts the offset a second time: 09:55 is read as
 * 09:55 UTC and reported as 04:55 Central — five hours EARLY. Against a 9:00
 * start that is 245 minutes early, not 55 late, so the row never became a
 * candidate. Every field punch since 6/17 was invisible to the sweep, which is
 * exactly why the ladder recorded nothing while the notifications kept firing
 * (the clock-in route measures lateness in a single consistent wall-clock frame,
 * so IT was right all along — the two surfaces simply disagreed).
 *
 * The frame is also server-dependent, which is what let this survive review:
 * on a machine whose TZ is already Central the double conversion is a no-op and
 * the sweep looks fine. Railway runs UTC.
 */
export function punchMinsLocal(at: Date, tzNormalized: boolean, tz: string = DEFAULT_TZ): number {
  // Wall-clock row: the digits in the column ARE the local time. node-postgres
  // parses a zone-less timestamp against the process TZ, so read the UTC
  // components back out rather than re-interpreting them.
  if (tzNormalized) return at.getUTCHours() * 60 + at.getUTCMinutes();
  return clockInMinsLocal(at, tz);
}

export type AutoTardyRow = {
  employee_id: number;
  company_id: number;
  minutes_late: number;
  job_id: number;
};

export type AutoTardySummary = {
  date: string;
  candidates: number;
  recorded: number;
  skipped_existing: number;
};

/** Sweep one service date (YYYY-MM-DD). Idempotent per (employee, date). */
export async function runAutoTardySweep(ymd: string): Promise<AutoTardySummary> {
  const jobs = await db
    .select({
      id: jobsTable.id,
      company_id: jobsTable.company_id,
      scheduled_time: jobsTable.scheduled_time,
    })
    .from(jobsTable)
    .where(eq(jobsTable.scheduled_date, ymd));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const jobIds = jobs.filter((j) => scheduledTimeToMins(j.scheduled_time) != null).map((j) => j.id);
  if (jobIds.length === 0) return { date: ymd, candidates: 0, recorded: 0, skipped_existing: 0 };

  const clocks = await db
    .select({
      job_id: timeclockTable.job_id,
      user_id: timeclockTable.user_id,
      company_id: timeclockTable.company_id,
      clock_in_at: timeclockTable.clock_in_at,
      source: timeclockTable.source,
      tz_normalized: timeclockTable.tz_normalized,
    })
    .from(timeclockTable)
    .where(inArray(timeclockTable.job_id, jobIds));

  // Per (employee): their first-scheduled job that day, and their earliest
  // real punch on that job.
  type Cand = { schedMins: number; clockMins: number; job_id: number; company_id: number };
  const firstJob = new Map<number, Cand>();
  for (const c of clocks) {
    if (c.source !== "punched") continue;
    const job = jobById.get(c.job_id);
    if (!job) continue;
    const schedMins = scheduledTimeToMins(job.scheduled_time);
    if (schedMins == null) continue;
    const clockMins = punchMinsLocal(new Date(c.clock_in_at), !!c.tz_normalized, tzOf(job.company_id));
    const prev = firstJob.get(c.user_id);
    if (!prev || schedMins < prev.schedMins || (schedMins === prev.schedMins && clockMins < prev.clockMins)) {
      firstJob.set(c.user_id, { schedMins, clockMins, job_id: c.job_id, company_id: job.company_id });
    }
  }

  const lateCands: Array<AutoTardyRow> = [];
  for (const [userId, cand] of firstJob) {
    const late = cand.clockMins - cand.schedMins;
    if (late > GRACE_MINUTES) {
      lateCands.push({ employee_id: userId, company_id: cand.company_id, minutes_late: late, job_id: cand.job_id });
    }
  }

  let recorded = 0;
  let skippedExisting = 0;
  for (const cand of lateCands) {
    // Never double-count a day that already has a tardy (manual or auto) —
    // and never resurrect one the office deleted as a mistake.
    const existing = await db
      .select({ id: employeeAttendanceLogTable.id })
      .from(employeeAttendanceLogTable)
      .where(
        and(
          eq(employeeAttendanceLogTable.company_id, cand.company_id),
          eq(employeeAttendanceLogTable.employee_id, cand.employee_id),
          eq(employeeAttendanceLogTable.type, "tardy"),
          gte(employeeAttendanceLogTable.log_date, ymd),
          lte(employeeAttendanceLogTable.log_date, ymd),
        ),
      )
      .limit(1);
    if (existing[0]) {
      skippedExisting++;
      continue;
    }
    try {
      await recordUnexcusedEntryAndDriveLadder(db, {
        company_id: cand.company_id,
        employee_id: cand.employee_id,
        log_date: ymd,
        hours: Math.round((cand.minutes_late / 60) * 100) / 100,
        type: "tardy",
        note: `auto: clocked in ${cand.minutes_late} min late (job #${cand.job_id})`,
        logged_by: null,
      });
      recorded++;
    } catch (err) {
      console.error(`[auto-tardy] record failed for employee ${cand.employee_id} on ${ymd}:`, err);
    }
  }
  const summary = { date: ymd, candidates: lateCands.length, recorded, skipped_existing: skippedExisting };
  console.log(
    `[auto-tardy] ${ymd}: ${summary.candidates} late first-job clock-ins, ${summary.recorded} recorded, ${summary.skipped_existing} already had a tardy that day`,
  );
  return summary;
}
