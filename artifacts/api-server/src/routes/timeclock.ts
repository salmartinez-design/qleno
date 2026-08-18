import { Router } from "express";
import { db } from "@workspace/db";
import { timeclockTable, usersTable, jobsTable, clientsTable, companiesTable, jobPhotosTable, clockInAttemptsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, desc, sql, count } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit, logJobStatusChange } from "../lib/audit.js";
import { revertJobIfGhostCompletion } from "../lib/completion-revert.js";
import { computePerTechCommissionRows, isCommercialJob, type JobTechRow } from "../lib/commission-paytype.js";
import { computeJobBilledNet } from "../lib/job-billed.js";
import { ensureInvoiceForCompletedJob } from "../lib/ensure-invoice.js";
import { parseResRatesRow } from "../lib/commission-rates.js";
import { unionHoursByKey } from "../lib/timeclock-hours.js";
import type { CommissionInputJob } from "../lib/commission-compute.js";
import { sendNotification, labelServiceType } from "../services/notificationService.js";
import { notifyOfficeUsers } from "../lib/notify.js";
import { LATE_THRESHOLD_MINUTES } from "../lib/job-status-constants.js";

// [geofence-ticket 2026-07-03] Raise an office "employee ticket" (in-app office
// broadcast) whenever a punch is RECORDED outside the job geofence — the office's
// coaching radar (Sal: "put a red flag on the time clock and give us an employee
// ticket when this occurs"). The timeclock row already carries the red flag
// (clock_in/out_outside_geofence + flagged); this adds the alert. Fire-and-forget:
// a notify failure must never break a clock punch.
async function raiseGeofenceTicket(
  companyId: number,
  userId: number | null | undefined,
  jobId: number | null | undefined,
  phase: "clock-in" | "clock-out",
  distanceFt: number | null,
): Promise<void> {
  try {
    if (jobId == null || userId == null) return;
    const [u] = await db.select({ first_name: usersTable.first_name, last_name: usersTable.last_name })
      .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const nameRows = await db.execute(sql`
      SELECT COALESCE(c.first_name || ' ' || COALESCE(c.last_name, ''), a.account_name, 'a job') AS client_name
        FROM jobs j
        LEFT JOIN clients c ON c.id = j.client_id
        LEFT JOIN accounts a ON a.id = j.account_id
       WHERE j.id = ${jobId} LIMIT 1
    `);
    const tech = `${u?.first_name ?? ""} ${u?.last_name ?? ""}`.trim() || "A technician";
    const client = String((nameRows.rows[0] as any)?.client_name ?? "a job").trim();
    const ft = distanceFt != null ? `${Math.round(distanceFt).toLocaleString()} ft` : "an unknown distance";
    await notifyOfficeUsers(companyId, {
      type: "geofence_violation",
      title: "Geofence violation — off-site punch",
      body: `${tech} clocked ${phase === "clock-in" ? "in" : "out"} ${ft} from ${client}. Review the time clock.`,
      link: "/jobs",
      meta: { job_id: jobId, user_id: userId, phase, distance_ft: distanceFt },
    });
  } catch (e) {
    console.warn("[geofence-ticket] failed (non-fatal):", e);
  }
}
import { isClientAccountCommsPaused } from "../lib/account-comms.js";
import { tzOf, DEFAULT_TZ } from "../lib/company-tz.js";

const router = Router();

// [clock-tz 2026-06-17] Clock times are stored as WALL-CLOCK (the office types
// "4:24 PM" and that's exactly what's stored + shown — see the time-clock UI's
// design note). Office-typed naive strings already round-trip correctly on a
// UTC server. But FIELD-app punches use `new Date()` (a real UTC instant), so a
// 4:24 PM Central punch was stored as 21:24 and the time-clock screen sliced it
// to "9:24 PM" (+5h). This converts a real instant to the tenant's local
// wall-clock and returns a Date whose UTC components equal those wall digits —
// so it stores into the `timestamp` column as the tenant's local wall-clock,
// matching the office convention.
//
// [company-timezone 2026-08-15] The zone is no longer hardcoded — the caller
// passes `tzOf(companyId)`. A tenant in Denver now stores a 4:24 PM punch as
// 16:24 the same way a Chicago tenant does. Omitting the argument keeps the
// old Central behavior, so nothing regresses if a call site is missed.
function centralWallClock(instant: Date, tz: string = DEFAULT_TZ): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(instant);
  const g = (t: string) => parts.find(p => p.type === t)!.value;
  let hh = g("hour"); if (hh === "24") hh = "00"; // Intl can emit 24 at midnight
  return new Date(`${g("year")}-${g("month")}-${g("day")}T${hh}:${g("minute")}:${g("second")}Z`);
}

// [late-fix 2026-07-15] The job's ACTUAL scheduled start, in the SAME frame as
// centralWallClock (a Date whose UTC components equal the Central wall digits).
// Building it this way makes the lateness math server-timezone-proof, since
// clockInAt is also a centralWallClock Date. Parses "HH:MM[:SS]" 24h or 12h AM/PM.
function scheduledStartWallClock(dateStr: string | null, timeStr: string | null): Date | null {
  if (!dateStr || !timeStr) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i.exec(String(timeStr).trim());
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3]?.toUpperCase();
  if (ap === "PM" && hh < 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  const d = new Date(`${dateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function calculateDistanceFt(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 20902231;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// [timeclock-cohesion 2026-06-05] Recompute jobs.actual_hours from the job's
// COMPLETED clock entries: earliest clock-in → latest clock-out = the job's
// actual on-site span (matches MC's single-tech case; for simultaneous
// multi-tech it's the job duration, not summed labor). This is the wire that
// makes a clock edit flow into reporting — it drives the allowed-vs-actual
// efficiency metric and the 'actual_hours' commission mode (under the default
// 'allowed_hours' mode it doesn't change commission $, so it's safe). Called
// after every office clock write so the clock and pay stay in sync. NULL when
// no entry is closed yet (actual isn't known until clock-out).
async function recomputeJobActualHours(jobId: number, companyId: number): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE jobs SET actual_hours = sub.h
      FROM (
        SELECT ROUND(GREATEST(
                 EXTRACT(EPOCH FROM (MAX(clock_out_at) - MIN(clock_in_at))) / 3600.0, 0)::numeric, 2) AS h
        FROM timeclock
        WHERE job_id = ${jobId} AND company_id = ${companyId} AND clock_out_at IS NOT NULL
      ) sub
      WHERE jobs.id = ${jobId} AND jobs.company_id = ${companyId}
    `);
  } catch (err) {
    console.error("[timeclock] recomputeJobActualHours failed:", err);
  }
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const { user_id, job_id, flagged, date_from, date_to, branch_id } = req.query;

    const conditions: any[] = [eq(timeclockTable.company_id, req.auth!.companyId)];
    if (user_id) conditions.push(eq(timeclockTable.user_id, parseInt(user_id as string)));
    if (job_id) conditions.push(eq(timeclockTable.job_id, parseInt(job_id as string)));
    if (flagged !== undefined) conditions.push(eq(timeclockTable.flagged, flagged === "true"));
    if (date_from) conditions.push(gte(timeclockTable.clock_in_at, new Date(date_from as string)));
    if (date_to) conditions.push(lte(timeclockTable.clock_in_at, new Date(date_to as string)));
    if (branch_id && branch_id !== "all") conditions.push(eq(timeclockTable.branch_id, parseInt(branch_id as string)));

    const entries = await db
      .select({
        id: timeclockTable.id,
        job_id: timeclockTable.job_id,
        user_id: timeclockTable.user_id,
        user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        clock_in_at: timeclockTable.clock_in_at,
        clock_out_at: timeclockTable.clock_out_at,
        clock_in_lat: timeclockTable.clock_in_lat,
        clock_in_lng: timeclockTable.clock_in_lng,
        clock_out_lat: timeclockTable.clock_out_lat,
        clock_out_lng: timeclockTable.clock_out_lng,
        distance_from_job_ft: timeclockTable.distance_from_job_ft,
        clock_in_distance_ft: timeclockTable.clock_in_distance_ft,
        clock_out_distance_ft: timeclockTable.clock_out_distance_ft,
        clock_in_outside_geofence: timeclockTable.clock_in_outside_geofence,
        clock_out_outside_geofence: timeclockTable.clock_out_outside_geofence,
        override_approved: timeclockTable.override_approved,
        flagged: timeclockTable.flagged,
      })
      .from(timeclockTable)
      .leftJoin(usersTable, eq(timeclockTable.user_id, usersTable.id))
      .where(and(...conditions))
      .orderBy(desc(timeclockTable.clock_in_at));

    return res.json({
      data: entries.map(e => ({
        ...e,
        distance_from_job_ft: e.distance_from_job_ft ? parseFloat(e.distance_from_job_ft) : null,
        clock_in_distance_ft: e.clock_in_distance_ft ? parseFloat(e.clock_in_distance_ft) : null,
        clock_out_distance_ft: e.clock_out_distance_ft ? parseFloat(e.clock_out_distance_ft) : null,
        duration_hours: e.clock_out_at
          ? (new Date(e.clock_out_at).getTime() - new Date(e.clock_in_at).getTime()) / 3600000
          : null,
      })),
      total: entries.length,
    });
  } catch (err) {
    console.error("List timeclock error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to list timeclock" });
  }
});

router.get("/violations", requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const violations = await db
      .select({
        id: timeclockTable.id,
        user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        job_id: timeclockTable.job_id,
        clock_in_at: timeclockTable.clock_in_at,
        clock_in_distance_ft: timeclockTable.clock_in_distance_ft,
        clock_out_distance_ft: timeclockTable.clock_out_distance_ft,
        clock_in_outside_geofence: timeclockTable.clock_in_outside_geofence,
        clock_out_outside_geofence: timeclockTable.clock_out_outside_geofence,
      })
      .from(timeclockTable)
      .leftJoin(usersTable, eq(timeclockTable.user_id, usersTable.id))
      .where(and(
        eq(timeclockTable.company_id, req.auth!.companyId),
        gte(timeclockTable.clock_in_at, new Date(`${today}T00:00:00`)),
        lte(timeclockTable.clock_in_at, new Date(`${today}T23:59:59`)),
        sql`(${timeclockTable.clock_in_outside_geofence} = true OR ${timeclockTable.clock_out_outside_geofence} = true)`
      ))
      .orderBy(desc(timeclockTable.clock_in_at));

    return res.json({
      data: violations.map(v => ({
        ...v,
        clock_in_distance_ft: v.clock_in_distance_ft ? parseFloat(v.clock_in_distance_ft) : null,
        clock_out_distance_ft: v.clock_out_distance_ft ? parseFloat(v.clock_out_distance_ft) : null,
      })),
    });
  } catch (err) {
    console.error("Violations error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/attempts", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { date_from, date_to, user_id } = req.query;
    const conditions: any[] = [eq(clockInAttemptsTable.company_id, req.auth!.companyId)];
    if (user_id) conditions.push(eq(clockInAttemptsTable.user_id, parseInt(user_id as string)));
    if (date_from) conditions.push(gte(clockInAttemptsTable.attempted_at, new Date(date_from as string)));
    if (date_to) conditions.push(lte(clockInAttemptsTable.attempted_at, new Date(date_to as string)));

    const attempts = await db
      .select({
        id: clockInAttemptsTable.id,
        user_id: clockInAttemptsTable.user_id,
        user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        job_id: clockInAttemptsTable.job_id,
        attempted_at: clockInAttemptsTable.attempted_at,
        distance_ft: clockInAttemptsTable.distance_ft,
        radius_ft: clockInAttemptsTable.radius_ft,
        result: clockInAttemptsTable.result,
        notes: clockInAttemptsTable.notes,
      })
      .from(clockInAttemptsTable)
      .leftJoin(usersTable, eq(clockInAttemptsTable.user_id, usersTable.id))
      .where(and(...conditions))
      .orderBy(desc(clockInAttemptsTable.attempted_at))
      .limit(200);

    return res.json({
      data: attempts.map(a => ({
        ...a,
        distance_ft: a.distance_ft ? parseFloat(a.distance_ft) : null,
      })),
    });
  } catch (err) {
    console.error("Attempts error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [open-clock-finder 2026-08-13] Maribel, blocked from clocking Alma in:
// "I tried to clock in Alma but this shows up everywhere. I looked and couldn't
// find where she is clocked in. There has to be a way for us to know where she
// is clocked in without having to check day by day."
//
// The one-open-clock rule (#1406) is correct — it's the wall she hit, not the
// bug. The bug is that the wall came with no map. The block already names the
// other job in `message`, but every office screen threw `message` away and
// rendered the raw code (that's the OPEN_PUNCH_ELSEWHERE she circled), and
// nothing anywhere listed running punches across dates. A clock left open on a
// job three days back is invisible on a screen that shows one day at a time,
// so the only way to find it was to step backward day by day — exactly what
// she's asking not to do.
//
// This returns EVERY still-running punch for the company, any date, oldest
// first, with the day to jump to so the office can close it in one hop.
// Open minutes are measured against the CENTRAL wall-clock because
// clock_in_at is stored as naive Central wall-clock, not a UTC instant —
// comparing it to a raw now() would read 5 hours long on every row.
router.get("/open", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const userId = req.query.user_id ? parseInt(String(req.query.user_id), 10) : null;
    const rows = (await db.execute(sql`
      SELECT tc.id, tc.user_id, tc.job_id, tc.source,
             to_char(tc.clock_in_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS clock_in_at,
             TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS user_name,
             COALESCE(NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''),
                      a.account_name, c.company_name, 'Client') AS job_name,
             j.client_id, j.account_id,
             -- The Time Clock day screen is keyed on jobs.scheduled_date, so
             -- that's the day the office must land on to close this punch.
             -- Orphan/undated jobs fall back to the punch's own date.
             COALESCE(j.scheduled_date::text, to_char(tc.clock_in_at, 'YYYY-MM-DD')) AS day,
             GREATEST(0, ROUND(EXTRACT(EPOCH FROM
               ((now() AT TIME ZONE ${tzOf(companyId)}) - tc.clock_in_at)) / 60))::int AS open_minutes
        FROM timeclock tc
        JOIN users u ON u.id = tc.user_id
        LEFT JOIN jobs j ON j.id = tc.job_id
        LEFT JOIN clients c ON c.id = j.client_id
        LEFT JOIN accounts a ON a.id = j.account_id
       WHERE tc.company_id = ${companyId}
         AND tc.clock_out_at IS NULL
         ${userId ? sql`AND tc.user_id = ${userId}` : sql``}
       ORDER BY tc.clock_in_at ASC`)).rows as any[];

    return res.json({
      data: rows.map(r => ({
        id: Number(r.id),
        user_id: Number(r.user_id),
        user_name: r.user_name || "Tech",
        job_id: Number(r.job_id),
        job_name: r.job_name || `Job #${r.job_id}`,
        client_id: r.client_id != null ? Number(r.client_id) : null,
        account_id: r.account_id != null ? Number(r.account_id) : null,
        clock_in_at: r.clock_in_at,
        day: r.day,
        open_minutes: Number(r.open_minutes ?? 0),
        source: r.source ?? null,
      })),
      total: rows.length,
    });
  } catch (err) {
    console.error("GET /timeclock/open error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to load open clocks" });
  }
});

router.post("/clock-in", requireAuth, async (req, res) => {
  try {
    const { job_id, lat, lng, accuracy, override_token, acting_for_user_id } = req.body;

    // [offline-clock 2026-06-11] The field app queues a punch when there's no
    // signal and replays it later. client_clock_in_at carries the REAL on-site
    // time the tech tapped (not the sync time). Accept only a sane past stamp
    // (≤ now + 5 min skew, ≥ 24h ago) so it can't be abused to back/forward-date.
    // Always set the stamp to the Central wall-clock of the real instant (the
    // DB default now() would store a UTC instant → the +5h bug). Default = now;
    // offline replay overrides with the queued on-site instant.
    let clockInAt: Date = centralWallClock(new Date(), tzOf(req.auth!.companyId));
    if (req.body?.client_clock_in_at) {
      const d = new Date(req.body.client_clock_in_at);
      const now = Date.now();
      if (!isNaN(d.getTime()) && d.getTime() <= now + 5 * 60 * 1000 && d.getTime() >= now - 24 * 60 * 60 * 1000) {
        clockInAt = centralWallClock(d, tzOf(req.auth!.companyId));
      }
    }

    // [acting-for 2026-06-10] The office can clock a tech in on their behalf —
    // testing via "view as", or a tech whose phone died on site. Only
    // owner/admin/office/super_admin may act for someone else, the target must
    // belong to the same company, and a remote (office-acted) clock skips the
    // hard geofence block because the office isn't standing at the job site.
    let effectiveUserId = req.auth!.userId;
    let actingForOther = false;
    if (acting_for_user_id != null && Number(acting_for_user_id) !== req.auth!.userId) {
      const role = req.auth!.role || "";
      if (!["owner", "admin", "office", "super_admin"].includes(role)) {
        return res.status(403).json({ error: "Forbidden", message: "Not allowed to clock in another user" });
      }
      const target = await db.select({ id: usersTable.id }).from(usersTable)
        .where(and(eq(usersTable.id, Number(acting_for_user_id)), eq(usersTable.company_id, req.auth!.companyId)))
        .limit(1);
      if (!target[0]) {
        return res.status(404).json({ error: "Not Found", message: "Target employee not found in this company" });
      }
      effectiveUserId = Number(acting_for_user_id);
      actingForOther = true;
    }

    const job = await db
      .select()
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .where(and(
        eq(jobsTable.id, job_id),
        eq(jobsTable.company_id, req.auth!.companyId)
      ))
      .limit(1);

    if (!job[0]) {
      return res.status(404).json({ error: "Not Found", message: "Job not found" });
    }

    const company = await db
      .select({
        geo_fence_threshold_ft: companiesTable.geo_fence_threshold_ft,
        geofence_enabled: companiesTable.geofence_enabled,
        geofence_clockin_radius_ft: companiesTable.geofence_clockin_radius_ft,
        geofence_override_allowed: companiesTable.geofence_override_allowed,
        geofence_soft_mode: companiesTable.geofence_soft_mode,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, req.auth!.companyId))
      .limit(1);

    const cfg = company[0];
    const geofenceEnabled = cfg?.geofence_enabled ?? true;
    const clockInRadius = cfg?.geofence_clockin_radius_ft ?? 500;
    const softMode = cfg?.geofence_soft_mode ?? false;
    const overrideAllowed = cfg?.geofence_override_allowed ?? true;

    const jobRow = job[0].jobs;
    const jobLat = jobRow.job_lat ? parseFloat(jobRow.job_lat) : null;
    const jobLng = jobRow.job_lng ? parseFloat(jobRow.job_lng) : null;
    const empLat = lat !== undefined && lat !== null ? parseFloat(lat) : null;
    const empLng = lng !== undefined && lng !== null ? parseFloat(lng) : null;

    let distanceFt: number | null = null;
    let outsideGeofence = false;
    let flagged = false;

    if (empLat !== null && empLng !== null && jobLat !== null && jobLng !== null) {
      distanceFt = calculateDistanceFt(empLat, empLng, jobLat, jobLng);
    }

    if (geofenceEnabled && distanceFt !== null) {
      outsideGeofence = distanceFt > clockInRadius;
      flagged = outsideGeofence && !softMode && !actingForOther;
    }

    const isOverride = override_token === "approved";

    if (geofenceEnabled && outsideGeofence && !softMode && !isOverride && !actingForOther) {
      await db.insert(clockInAttemptsTable).values({
        company_id: req.auth!.companyId,
        user_id: req.auth!.userId,
        job_id,
        employee_lat: empLat !== null ? String(empLat) : null,
        employee_lng: empLng !== null ? String(empLng) : null,
        job_lat: jobLat !== null ? String(jobLat) : null,
        job_lng: jobLng !== null ? String(jobLng) : null,
        distance_ft: distanceFt !== null ? String(distanceFt) : null,
        radius_ft: clockInRadius,
        result: "blocked",
      });

      return res.status(403).json({
        error: "GEOFENCE_BLOCKED",
        message: `You are too far from this job location. You must be within ${clockInRadius} feet to clock in. Current distance: ${Math.round(distanceFt!)} feet. Please drive to the job address and try again.`,
        distance_ft: distanceFt,
        radius_ft: clockInRadius,
        override_allowed: overrideAllowed,
      });
    }

    // [one-clock-at-a-time 2026-08-12] Maribel, on Jose Ardila showing punched
    // in at two overlapping jobs: "this shouldn't be allowed to happen, he
    // clocked in at both jobs."
    //
    // Nothing stopped it. This route had no open-punch check of any kind, and
    // the office route only looked for a duplicate on the SAME job — so a
    // second clock-in on a DIFFERENT job sailed through. A person cannot be at
    // two houses at once, and every downstream number believes the clock:
    // actual hours, the allowed-vs-actual efficiency score, the minute-weighted
    // commission split, and the payroll total all double-count the overlap.
    //
    // Blocked, not auto-closed. Closing the earlier punch here would invent a
    // clock-out time nobody observed and quietly rewrite pay for the first job;
    // the office decides that with the real end time. The message names the
    // other job so the tech knows exactly what to close.
    //
    // [open-clock-finder 2026-08-13] The block also has to say WHEN. Naming the
    // job alone isn't enough to find a punch that's been running since a job
    // three days ago — the office reads "still clocked in at Smith" and has no
    // idea which day's Smith to open. Every rejection now carries the clock-in
    // date + time in the message and the day to jump to in the payload.
    const openPunch = (await db.execute(sql`
      SELECT tc.id, tc.job_id,
             -- Wall-clock string, not a Date: JSON-serializing the raw column
             -- would push it through toISOString() and shift it by the server's
             -- UTC offset, the same trap the clock screens avoid.
             to_char(tc.clock_in_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS clock_in_at,
             CASE WHEN j.account_id IS NOT NULL THEN a.account_name
                  ELSE NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') END AS job_name,
             to_char(tc.clock_in_at, 'FMMon FMDD') AS in_date_label,
             to_char(tc.clock_in_at, 'FMHH12:MI AM') AS in_time_label,
             COALESCE(j.scheduled_date::text, to_char(tc.clock_in_at, 'YYYY-MM-DD')) AS open_day
        FROM timeclock tc
        LEFT JOIN jobs j ON j.id = tc.job_id
        LEFT JOIN clients c ON c.id = j.client_id
        LEFT JOIN accounts a ON a.id = j.account_id
       WHERE tc.user_id = ${effectiveUserId}
         AND tc.company_id = ${req.auth!.companyId}
         AND tc.clock_out_at IS NULL
       ORDER BY tc.clock_in_at DESC
       LIMIT 1`) as any).rows[0];

    if (openPunch) {
      const sameJob = Number(openPunch.job_id) === Number(job_id);
      const when = `${openPunch.in_date_label} at ${openPunch.in_time_label}`;
      return res.status(409).json({
        error: sameJob ? "ALREADY_CLOCKED_IN" : "OPEN_PUNCH_ELSEWHERE",
        message: sameJob
          ? `You're already clocked in on this job (since ${when}).`
          : `You're still clocked in at ${openPunch.job_name || `job #${openPunch.job_id}`} from ${when}. Clock out there first, then clock in here.`,
        open_entry_id: Number(openPunch.id),
        open_job_id: Number(openPunch.job_id),
        open_job_name: openPunch.job_name ?? null,
        open_clock_in_at: openPunch.clock_in_at,
        open_day: openPunch.open_day ?? null,
      });
    }

    const attemptResult = isOverride ? "override_approved" : outsideGeofence ? "soft_warned" : "success";

    // Model A: stamp branch_id at clock-in from the job's branch (default Oak
    // Lawn for the handful of legacy jobs whose branch_id is null). Reports
    // group hours-by-branch off this column so later dispatch corrections
    // don't shift historical payroll attribution.
    const stampedBranchId = jobRow.branch_id ?? 1;

    // ── How late is this punch? ──────────────────────────────────────────────
    // [late-fix 2026-07-15] Measured against the job's ACTUAL scheduled_time
    // (Sal: the rule is 20 min, but this was firing at 8 min). The old code
    // compared to the generic arrival window — hardcoded 8:00 AM for "morning" —
    // so ANY clock-in after 8:20 AM was flagged late regardless of the job's
    // real time. Now: real scheduled start + the shared LATE_THRESHOLD_MINUTES
    // (20), the same rule as the dispatch late count.
    //
    // [late-clockin-record 2026-08-18] Computed BEFORE the insert now, because
    // the number is stored on the punch as well as announced. Maribel: "Even
    // when we receive a notification that a cleaner has a late check-in, the
    // late check-in is not being recorded in the cleaner's profile or service
    // history." It fired a notification into a feed and wrote nothing down —
    // and the instant the tech clocked in, the dispatch tile flipped from LATE
    // to ACTIVE, so the last trace of it disappeared from the board too.
    //
    // One computation, two consumers: the stored column and the notification
    // can no longer disagree about who was late and by how much.
    let lateByMin: number | null = null;
    try {
      const scheduledDate = jobRow.scheduled_date ? String(jobRow.scheduled_date).slice(0, 10) : null;
      const scheduledStart = scheduledStartWallClock(scheduledDate, (jobRow as any).scheduled_time ?? null);
      if (scheduledStart) {
        const delta = Math.floor((clockInAt.getTime() - scheduledStart.getTime()) / 60000);
        if (delta >= LATE_THRESHOLD_MINUTES) lateByMin = delta;
      }
    } catch (lateErr) {
      console.error("[late_clockin] could not measure lateness:", lateErr);
    }

    const [entry] = await db
      .insert(timeclockTable)
      .values({
        job_id,
        user_id: effectiveUserId,
        company_id: req.auth!.companyId,
        branch_id: stampedBranchId,
        clock_in_at: clockInAt,
        late_by_min: lateByMin,
        tz_normalized: true, // stored as Central wall-clock above — exclude from backfill
        clock_in_lat: empLat !== null ? String(empLat) : null,
        clock_in_lng: empLng !== null ? String(empLng) : null,
        clock_in_distance_ft: distanceFt !== null ? String(distanceFt) : null,
        distance_from_job_ft: distanceFt !== null ? String(distanceFt) : null,
        clock_in_outside_geofence: outsideGeofence,
        clock_in_location_accuracy: accuracy !== undefined ? String(accuracy) : null,
        override_approved: isOverride,
        flagged,
      })
      .returning();

    await db.insert(clockInAttemptsTable).values({
      company_id: req.auth!.companyId,
      user_id: effectiveUserId,
      job_id,
      employee_lat: empLat !== null ? String(empLat) : null,
      employee_lng: empLng !== null ? String(empLng) : null,
      job_lat: jobLat !== null ? String(jobLat) : null,
      job_lng: jobLng !== null ? String(jobLng) : null,
      distance_ft: distanceFt !== null ? String(distanceFt) : null,
      radius_ft: clockInRadius,
      result: attemptResult,
    });

    // ── Late clock-in notification ───────────────────────────────────────────
    // Announces the same `lateByMin` that was just written onto the punch — the
    // record is the source, the notification is a copy of it. The alert links
    // to the job card, which now carries the mark permanently, so "I saw a
    // notification, where do I go" has an answer.
    if (lateByMin != null) {
      try {
        const techRow = await db.select({ first_name: usersTable.first_name, last_name: usersTable.last_name })
          .from(usersTable).where(eq(usersTable.id, effectiveUserId)).limit(1);
        const techName = techRow[0] ? `${techRow[0].first_name} ${techRow[0].last_name}` : "A technician";
        const clientName = job[0].clients ? `${(job[0].clients as any).first_name} ${(job[0].clients as any).last_name}` : "a client";
        const notifTitle = `Late Clock-In — ${techName}`;
        const notifBody = `${techName} clocked in ${lateByMin} min late for ${clientName}'s job.`;
        await db.execute(
          sql`INSERT INTO notifications (company_id, type, title, body, link, meta)
            VALUES (${req.auth!.companyId}, 'late_clockin', ${notifTitle}, ${notifBody}, ${`/dispatch`}, ${JSON.stringify({ job_id, user_id: effectiveUserId, tech_name: techName, late_by_min: lateByMin })}::jsonb)`
        );
      } catch (notifErr) {
        console.error("[late_clockin notify] failed:", notifErr);
      }
    }

    // [geofence-ticket 2026-07-03] Punch recorded outside the fence → office ticket.
    if (geofenceEnabled && outsideGeofence) {
      await raiseGeofenceTicket(req.auth!.companyId as number, effectiveUserId, job_id, "clock-in", distanceFt);
    }

    return res.json({
      ...entry,
      distance_from_job_ft: distanceFt,
      clock_in_distance_ft: distanceFt,
      flagged,
      soft_warned: outsideGeofence && softMode,
    });
  } catch (err) {
    console.error("Clock in error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to clock in" });
  }
});

router.post("/:id/clock-out", requireAuth, async (req, res) => {
  try {
    const entryId = parseInt(req.params.id);
    const { lat, lng } = req.body;

    // [offline-clock 2026-06-11] Queued clock-out replays the REAL on-site time
    // (client_clock_out_at), not the sync time — so a dead-zone job doesn't
    // record a clock-out 30 min late at the tech's house. Same sanity window.
    // Store the Central wall-clock of the real instant (matches office-typed
    // times + the time-clock screen's wall-clock display; raw new Date() would
    // store a UTC instant → the +5h bug).
    let clockOutAt = centralWallClock(new Date(), tzOf(req.auth!.companyId));
    if (req.body?.client_clock_out_at) {
      const d = new Date(req.body.client_clock_out_at);
      const now = Date.now();
      if (!isNaN(d.getTime()) && d.getTime() <= now + 5 * 60 * 1000 && d.getTime() >= now - 24 * 60 * 60 * 1000) {
        clockOutAt = centralWallClock(d, tzOf(req.auth!.companyId));
      }
    }

    const existing = await db
      .select()
      .from(timeclockTable)
      .where(and(
        eq(timeclockTable.id, entryId),
        eq(timeclockTable.company_id, req.auth!.companyId)
      ))
      .limit(1);

    if (!existing[0]) {
      return res.status(404).json({ error: "Not Found", message: "Time clock entry not found" });
    }

    const jobData = await db
      .select({
        after_count: count(jobPhotosTable.id),
        job_lat: jobsTable.job_lat,
        job_lng: jobsTable.job_lng,
      })
      .from(jobsTable)
      .leftJoin(jobPhotosTable, and(
        eq(jobPhotosTable.job_id, existing[0].job_id),
        eq(jobPhotosTable.photo_type, "after")
      ))
      .where(eq(jobsTable.id, existing[0].job_id))
      .groupBy(jobsTable.id)
      .limit(1);

    if (!jobData[0]) {
      return res.status(404).json({ error: "Not Found", message: "Job not found for this clock entry" });
    }

    const company = await db
      .select({
        geofence_enabled: companiesTable.geofence_enabled,
        geofence_clockout_radius_ft: companiesTable.geofence_clockout_radius_ft,
        geofence_soft_mode: companiesTable.geofence_soft_mode,
        require_after_photo_for_clockout: companiesTable.require_after_photo_for_clockout,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, req.auth!.companyId))
      .limit(1);

    const cfg = company[0];
    const geofenceEnabled = cfg?.geofence_enabled ?? true;
    const clockOutRadius = cfg?.geofence_clockout_radius_ft ?? 1000;
    const softMode = cfg?.geofence_soft_mode ?? false;

    // After-photo gate is OPT-IN (default off). Only block clock-out on a
    // missing "after" photo when the owner enabled it in Clock In/Out settings.
    if ((cfg?.require_after_photo_for_clockout ?? false) && jobData[0].after_count === 0) {
      return res.status(400).json({ error: "PHOTOS_REQUIRED", message: "At least 1 after photo required before clock out" });
    }

    const jobLat = jobData[0].job_lat ? parseFloat(jobData[0].job_lat) : null;
    const jobLng = jobData[0].job_lng ? parseFloat(jobData[0].job_lng) : null;
    const empLat = lat !== undefined && lat !== null ? parseFloat(lat) : null;
    const empLng = lng !== undefined && lng !== null ? parseFloat(lng) : null;

    let distanceFt: number | null = null;
    let outsideGeofence = false;

    if (empLat !== null && empLng !== null && jobLat !== null && jobLng !== null) {
      distanceFt = calculateDistanceFt(empLat, empLng, jobLat, jobLng);
    }

    if (geofenceEnabled && distanceFt !== null) {
      outsideGeofence = distanceFt > clockOutRadius;
    }

    if (geofenceEnabled && outsideGeofence && !softMode) {
      return res.status(403).json({
        error: "GEOFENCE_BLOCKED",
        message: `You are too far from the job location to clock out. You must be within ${clockOutRadius} feet. Current distance: ${Math.round(distanceFt!)} feet.`,
        distance_ft: distanceFt,
        radius_ft: clockOutRadius,
      });
    }

    const [updated] = await db
      .update(timeclockTable)
      .set({
        clock_out_at: clockOutAt,
        clock_out_lat: empLat !== null ? String(empLat) : null,
        clock_out_lng: empLng !== null ? String(empLng) : null,
        clock_out_distance_ft: distanceFt !== null ? String(distanceFt) : null,
        clock_out_outside_geofence: outsideGeofence,
        flagged: existing[0].flagged || (outsideGeofence && !softMode),
      })
      .where(and(
        eq(timeclockTable.id, entryId),
        eq(timeclockTable.company_id, req.auth!.companyId)
      ))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Not Found", message: "Time clock entry not found" });
    }

    // [geofence-ticket 2026-07-03] Clock-out recorded outside the fence → office ticket.
    if (geofenceEnabled && outsideGeofence) {
      await raiseGeofenceTicket(req.auth!.companyId as number, updated.user_id, updated.job_id, "clock-out", distanceFt);
    }

    // [GAP2 end-job completion] When the LAST open clock entry for a job closes,
    // the job is done (the "day is derived" model). Mark the job complete and
    // fire the post-job satisfaction survey — the field-app End Job previously
    // did neither, so the survey only fired from the office "Mark Complete".
    // The guarded UPDATE (status NOT IN complete/cancelled) makes this a no-op
    // if the office already completed it, and the 30-day throttle in
    // /satisfaction/send prevents a double survey either way. Best-effort —
    // never blocks the clock-out response.
    try {
      const jobId = existing[0].job_id;
      const openLeft = await db.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM timeclock
        WHERE job_id = ${jobId} AND clock_out_at IS NULL
      `);
      if (((openLeft.rows[0] as any)?.cnt ?? 0) === 0) {
        const done = await db.execute(sql`
          UPDATE jobs
          SET status = 'complete', actual_end_time = ${clockOutAt}, completed_by_user_id = ${req.auth!.userId}
          WHERE id = ${jobId} AND company_id = ${req.auth!.companyId}
            AND status NOT IN ('complete', 'cancelled')
          RETURNING client_id
        `);
        // RETURNING is non-empty only when THIS call flipped the status — so the
        // survey + retention + auto-invoice fire exactly once, on the transition.
        const clientId = (done.rows[0] as any)?.client_id;
        if (done.rows[0]) {
          // [completion-audit 2026-07-28] Record the field clock-out completion in
          // the Customer Activity feed ("Marked complete — clock-out · <tech>").
          // Prior status is scheduled/in_progress (the guarded UPDATE excludes
          // complete/cancelled). Non-blocking.
          void logJobStatusChange({
            companyId: req.auth!.companyId,
            jobId,
            actorUserId: req.auth!.userId ?? null,
            priorStatus: "in_progress",
            newStatus: "complete",
            source: "clock-out",
          });
          // Generate the job's draft invoice on field clock-out — same idempotent
          // path the office PATCH uses. Fire-and-forget so a slow/failed invoice
          // never blocks the clock-out response (helper is internally non-fatal).
          ensureInvoiceForCompletedJob(req.auth!.companyId, jobId, req.auth!.userId)
            .catch((e: Error) => console.error("[end-job invoice] non-fatal:", e));
        }
        // [redo-service 2026-07-10] Skip survey + retention drip after a redo.
        const [_redoChk] = await db.select({ nb: jobsTable.non_billable, ro: jobsTable.redo_of_job_id }).from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
        if (clientId && !(_redoChk?.nb || _redoChk?.ro != null)) {
          // [one-completion-email] Survey response says whether the survey EMAIL
          // went out; the thank-you email below only sends when it didn't.
          const surveyPromise: Promise<any> = fetch(`http://localhost:${process.env.PORT || 8080}/api/satisfaction/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": req.headers.authorization || "" },
            body: JSON.stringify({ job_id: jobId, customer_id: clientId }),
          }).then(r => r.json()).catch((e: Error) => { console.error("[end-job survey] non-fatal:", e); return null; });
          import("../services/followUpService.js").then(({ enrollForJobComplete }) =>
            enrollForJobComplete(req.auth!.companyId, jobId, clientId).catch(() => {})
          ).catch(() => {});
          // ── job_completed notification — mirrors jobs.ts PATCH path ──
          Promise.resolve().then(async () => {
            try {
              if (await isClientAccountCommsPaused(clientId)) return;
              const [cl] = await db.select({
                email: clientsTable.email, phone: clientsTable.phone,
                first_name: clientsTable.first_name,
                address: clientsTable.address, city: clientsTable.city, state: clientsTable.state,
              }).from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
              if (!cl) return;
              const [jobRow] = await db.select({ service_type: jobsTable.service_type, scheduled_date: jobsTable.scheduled_date })
                .from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
              const mv = {
                first_name: cl.first_name || "",
                appointment_date: String(jobRow?.scheduled_date || "").slice(0, 10),
                scope: labelServiceType((jobRow as any)?.service_type),
                service_address: [cl.address, cl.city, cl.state].filter(Boolean).join(", "),
              };
              // Pass the client id so the per-client channel preference gate
              // applies (an explicit email/SMS OFF override was ignored here).
              const survey = await surveyPromise;
              if (!survey?.survey_email_sent) {
                sendNotification("job_completed", "email", req.auth!.companyId, cl.email, null, mv, false, undefined, clientId).catch(() => {});
              }
              sendNotification("job_completed", "sms", req.auth!.companyId, null, cl.phone, mv, false, undefined, clientId).catch(() => {});
            } catch (e) {
              console.error("[timeclock] job_completed notify non-fatal:", (e as Error).message);
            }
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.error("[end-job completion] non-fatal:", e);
    }

    const user = await db
      .select({ first_name: usersTable.first_name, last_name: usersTable.last_name })
      .from(usersTable)
      .where(eq(usersTable.id, updated.user_id))
      .limit(1);

    const durationHours = updated.clock_out_at
      ? (new Date(updated.clock_out_at).getTime() - new Date(updated.clock_in_at).getTime()) / 3600000
      : null;

    return res.json({
      ...updated,
      user_name: `${user[0]?.first_name || ""} ${user[0]?.last_name || ""}`.trim(),
      distance_from_job_ft: updated.distance_from_job_ft ? parseFloat(updated.distance_from_job_ft) : null,
      clock_out_distance_ft: distanceFt,
      duration_hours: durationHours,
      soft_warned: outsideGeofence && softMode,
    });
  } catch (err) {
    console.error("Clock out error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to clock out" });
  }
});

router.patch("/:id/unflag", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const entryId = parseInt(req.params.id);
    const [updated] = await db
      .update(timeclockTable)
      .set({ flagged: false })
      .where(and(
        eq(timeclockTable.id, entryId),
        eq(timeclockTable.company_id, req.auth!.companyId)
      ))
      .returning();
    if (!updated) return res.status(404).json({ error: "Not Found" });
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/:id/override", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const entryId = parseInt(req.params.id);
    const [updated] = await db
      .update(timeclockTable)
      .set({ override_approved: true, override_by: req.auth!.userId, flagged: false })
      .where(and(
        eq(timeclockTable.id, entryId),
        eq(timeclockTable.company_id, req.auth!.companyId)
      ))
      .returning();
    if (!updated) return res.status(404).json({ error: "Not Found" });
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Office-initiated clock in/out (desktop dispatch board) ───────────────────
// The field-app tech clock locks to req.auth.userId, so it can't cover the
// office clocking the team in/out on the tech's behalf from the board. These
// role-gated endpoints stamp a SPECIFIC tech's clock pair on a job — no
// GPS/geofence (office override), source stays 'punched' so payroll and the
// proportional-by-minutes commission split treat it as real clocked time.
// Writes the legacy timeclock table (the one payroll + commission read), not
// the GPS job_clock_events model. from_job_id is NOT a timeclock column — the
// mileage hook lives on on_my_way_events and is untouched here.
router.post("/office/clock-in", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const job_id = parseInt(String(req.body?.job_id));
    const user_id = parseInt(String(req.body?.user_id));
    if (!job_id || !user_id) return res.status(400).json({ error: "job_id and user_id are required" });
    // Typed time = naive wall-clock string, stored as-is (round-trips on a UTC
    // server). No time given → stamp the Central wall-clock of now (not a raw
    // UTC instant).
    const clockInAt = req.body?.clock_in_at ? new Date(req.body.clock_in_at) : centralWallClock(new Date(), tzOf(req.auth!.companyId));
    if (isNaN(clockInAt.getTime())) return res.status(400).json({ error: "Invalid clock_in_at" });

    const [jobRow] = await db.select({
      id: jobsTable.id, branch_id: jobsTable.branch_id,
      // [late-clockin-record 2026-08-18] Needed to measure the punch against
      // the job's scheduled start.
      scheduled_date: jobsTable.scheduled_date, scheduled_time: jobsTable.scheduled_time,
    })
      .from(jobsTable).where(and(eq(jobsTable.id, job_id), eq(jobsTable.company_id, companyId))).limit(1);
    if (!jobRow) return res.status(404).json({ error: "Job not found" });
    const [techRow] = await db.select({ id: usersTable.id })
      .from(usersTable).where(and(eq(usersTable.id, user_id), eq(usersTable.company_id, companyId))).limit(1);
    if (!techRow) return res.status(404).json({ error: "Employee not found" });

    // Idempotent: if this tech already has an OPEN entry on this job, return it
    // instead of stacking a second open punch.
    const [open] = await db.select().from(timeclockTable).where(and(
      eq(timeclockTable.company_id, companyId), eq(timeclockTable.job_id, job_id),
      eq(timeclockTable.user_id, user_id), sql`${timeclockTable.clock_out_at} IS NULL`
    )).limit(1);
    if (open) return res.json({ ...open, already_open: true });

    // [punch-dedup 2026-07-01] Also block a CLOSED entry that already COVERS this
    // clock-in time for the same tech+job. This is the case the open-check above
    // misses and it's exactly what skewed payroll: a completed field-app punch,
    // then a manual office punch stacked on top of it. The commission split
    // weights by clocked minutes summed per (job, tech), so two overlapping
    // punches double-count the tech's minutes and over-pay them (Juliana got 2/3
    // of a shared job, Norma 1/3, instead of 50/50). A clock-in strictly AFTER a
    // prior clock-out (e.g. a lunch break, same job) is still allowed — only a
    // punch whose start falls INSIDE an existing entry's span is rejected.
    const [covered] = await db.select({ id: timeclockTable.id }).from(timeclockTable).where(and(
      eq(timeclockTable.company_id, companyId), eq(timeclockTable.job_id, job_id),
      eq(timeclockTable.user_id, user_id),
      sql`${timeclockTable.clock_out_at} IS NOT NULL`,
      sql`${timeclockTable.clock_in_at} <= ${clockInAt}`,
      sql`${timeclockTable.clock_out_at} > ${clockInAt}`,
    )).limit(1);
    if (covered) {
      return res.status(409).json({
        error: "Duplicate punch",
        message: "This cleaner already has a time entry covering that time on this job — edit the existing entry instead of adding a new one.",
      });
    }

    // [one-clock-at-a-time 2026-08-12] The check above is scoped to THIS job,
    // so a second clock-in on a DIFFERENT job passed it — which is how a tech
    // ended up punched in at two overlapping jobs (Maribel). Same rule as the
    // field route: one open clock per person, blocked rather than auto-closed,
    // with the other job named. The office CAN still key in a closed entry with
    // explicit in/out times for a job worked earlier — this only rejects
    // leaving a second clock RUNNING.
    //
    // [open-clock-finder 2026-08-13] Say WHEN, not just where. This is the exact
    // 409 Maribel hit trying to clock Alma in, and "still clocked in at <name>"
    // sent her stepping backward through the day view looking for it. The
    // clock-in date + time go in the message; open_day is the date the Time
    // Clock screen must land on to close the punch.
    const openElsewhere = (await db.execute(sql`
      SELECT tc.id, tc.job_id,
             CASE WHEN j.account_id IS NOT NULL THEN a.account_name
                  ELSE NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') END AS job_name,
             to_char(tc.clock_in_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS clock_in_at,
             to_char(tc.clock_in_at, 'FMMon FMDD') AS in_date_label,
             to_char(tc.clock_in_at, 'FMHH12:MI AM') AS in_time_label,
             COALESCE(j.scheduled_date::text, to_char(tc.clock_in_at, 'YYYY-MM-DD')) AS open_day
        FROM timeclock tc
        LEFT JOIN jobs j ON j.id = tc.job_id
        LEFT JOIN clients c ON c.id = j.client_id
        LEFT JOIN accounts a ON a.id = j.account_id
       WHERE tc.user_id = ${user_id} AND tc.company_id = ${companyId}
         AND tc.clock_out_at IS NULL AND tc.job_id <> ${job_id}
       ORDER BY tc.clock_in_at DESC LIMIT 1`) as any).rows[0];
    if (openElsewhere) {
      return res.status(409).json({
        error: "OPEN_PUNCH_ELSEWHERE",
        message: `This cleaner is still clocked in at ${openElsewhere.job_name || `job #${openElsewhere.job_id}`} from ${openElsewhere.in_date_label} at ${openElsewhere.in_time_label}. Close that entry first — nobody can be on two jobs at once.`,
        open_entry_id: Number(openElsewhere.id),
        open_job_id: Number(openElsewhere.job_id),
        open_job_name: openElsewhere.job_name ?? null,
        open_clock_in_at: openElsewhere.clock_in_at,
        open_day: openElsewhere.open_day ?? null,
      });
    }

    // [late-clockin-record 2026-08-18] An office-keyed punch is measured by the
    // same rule as a field punch. Both times are wall-clock here, so the
    // subtraction is frame-safe. No notification: this is the office typing in
    // a time it already knows about, so alerting itself would be noise.
    let officeLateByMin: number | null = null;
    try {
      const schedStart = scheduledStartWallClock(
        jobRow.scheduled_date ? String(jobRow.scheduled_date).slice(0, 10) : null,
        (jobRow as any).scheduled_time ?? null,
      );
      if (schedStart) {
        const delta = Math.floor((clockInAt.getTime() - schedStart.getTime()) / 60000);
        if (delta >= LATE_THRESHOLD_MINUTES) officeLateByMin = delta;
      }
    } catch { /* an unmeasurable punch is simply not marked late */ }

    const [entry] = await db.insert(timeclockTable).values({
      job_id, user_id, company_id: companyId,
      branch_id: jobRow.branch_id ?? 1,
      clock_in_at: clockInAt,
      late_by_min: officeLateByMin,
      tz_normalized: true, // office-typed = wall-clock; exclude from backfill
      override_approved: true,
      source: "punched",
    }).returning();
    // [clock-history 2026-08-12] Audit the CREATE too, not just later edits.
    // Without this the clock history could show every correction but never who
    // put the punch there in the first place — which is half of "who changed it
    // when" when the office keys in a clock the cleaner never punched.
    logAudit(req, "TIMECLOCK_OFFICE_IN", "timeclock", entry.id,
      null, { clock_in_at: entry.clock_in_at, job_id, user_id });
    return res.json(entry);
  } catch (err) {
    console.error("POST /timeclock/office/clock-in error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/office/clock-out", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const job_id = parseInt(String(req.body?.job_id));
    const user_id = parseInt(String(req.body?.user_id));
    if (!job_id || !user_id) return res.status(400).json({ error: "job_id and user_id are required" });
    const [open] = await db.select().from(timeclockTable).where(and(
      eq(timeclockTable.company_id, companyId), eq(timeclockTable.job_id, job_id),
      eq(timeclockTable.user_id, user_id), sql`${timeclockTable.clock_out_at} IS NULL`
    )).orderBy(desc(timeclockTable.clock_in_at)).limit(1);
    if (!open) return res.status(400).json({ error: "No open clock-in for this employee on this job" });

    // [clock-out-frame 2026-08-07] Stamp the clock-out in the SAME time frame the
    // stored clock-in is written in. This is why "Clock Out" on the job card had
    // never worked (Francisco: "clock in yes, out no"; Maribel: "I don't think
    // it ever worked").
    //
    // `tz_normalized` DEFAULTS TO FALSE, and only the two clock-in paths set it
    // true — so every legacy row, and any row written before that flag existed,
    // holds a raw UTC instant. Clock-out unconditionally stamped
    // centralWallClock(now), which is 5-6 hours BEHIND the UTC value for the
    // very same moment. The guard below then read that as travelling backwards
    // and refused: "Clock-out cannot be before clock-in". Clock-out was
    // therefore impossible on those rows, while clock-in — which compares
    // nothing — always worked.
    //
    // Matching the frame fixes both eras without touching stored history: a
    // normalized row gets a wall-clock stamp, a legacy row gets the raw instant,
    // and the pair is internally consistent either way. The backfill at
    // /clock-tz-backfill still converts legacy rows properly when it runs.
    const nowInRowFrame = open.tz_normalized ? centralWallClock(new Date(), tzOf(req.auth!.companyId)) : new Date();
    const clockOutAt = req.body?.clock_out_at ? new Date(req.body.clock_out_at) : nowInRowFrame;
    if (isNaN(clockOutAt.getTime())) return res.status(400).json({ error: "Invalid clock_out_at" });

    if (clockOutAt.getTime() < new Date(open.clock_in_at).getTime()) {
      // Still possible with a hand-typed time. Say what the clock-in actually
      // was, so the office can correct it rather than guess.
      const inStr = new Date(open.clock_in_at).toISOString().slice(11, 16);
      return res.status(400).json({
        error: `Clock-out cannot be before clock-in (clocked in at ${inStr})`,
      });
    }

    const [updated] = await db.update(timeclockTable)
      .set({ clock_out_at: clockOutAt })
      .where(eq(timeclockTable.id, open.id)).returning();
    await recomputeJobActualHours(job_id, companyId);
    logAudit(req, "TIMECLOCK_OFFICE_OUT", "timeclock", updated.id,
      { clock_out_at: open.clock_out_at ?? null }, { clock_out_at: updated.clock_out_at });
    return res.json(updated);
  } catch (err) {
    console.error("POST /timeclock/office/clock-out error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ─── Clock timezone backfill (one-time, owner-reviewed) ──────────────────────
// [clock-tz-backfill 2026-06-17] Field-app punches recorded before the
// wall-clock fix were stored as UTC instants (a 4:24 PM Central punch saved as
// 21:24). These two endpoints let the owner PREVIEW and then APPLY a one-time
// UTC→Central shift to those rows. Identified by: tz_normalized=false AND a
// field GPS stamp (clock_in_lat) — office-typed rows (no GPS) are already
// wall-clock and are left alone. Rows with a field clock-IN but an office
// clock-OUT (clock_out_lat NULL) are flagged "mixed" and NOT auto-converted —
// the owner fixes those by hand via the per-entry editor.
const tzCandidateWhere = (companyId: number, from: string, to: string) => sql`
  tc.company_id = ${companyId} AND tc.tz_normalized = false
  AND tc.clock_in_lat IS NOT NULL
  AND tc.clock_in_at::date BETWEEN ${from}::date AND ${to}::date`;

router.get("/tz-audit", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const from = String(req.query.from || "").slice(0, 10);
    const to = String(req.query.to || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: "from and to (YYYY-MM-DD) required" });
    }
    const rows = await db.execute(sql`
      SELECT tc.id, tc.user_id,
             TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS tech,
             to_char(tc.clock_in_at, 'YYYY-MM-DD HH24:MI') AS in_before,
             to_char((tc.clock_in_at AT TIME ZONE 'UTC') AT TIME ZONE ${tzOf(companyId)}, 'YYYY-MM-DD HH24:MI') AS in_after,
             to_char(tc.clock_out_at, 'YYYY-MM-DD HH24:MI') AS out_before,
             to_char((tc.clock_out_at AT TIME ZONE 'UTC') AT TIME ZONE ${tzOf(companyId)}, 'YYYY-MM-DD HH24:MI') AS out_after,
             (tc.clock_out_at IS NOT NULL AND tc.clock_out_lat IS NULL) AS mixed
        FROM timeclock tc
        LEFT JOIN users u ON u.id = tc.user_id
       WHERE ${tzCandidateWhere(companyId, from, to)}
       ORDER BY tc.clock_in_at DESC
       LIMIT 1000
    `);
    const data = rows.rows as any[];
    return res.json({
      from, to,
      convertible: data.filter(r => !r.mixed),
      mixed: data.filter(r => r.mixed),
      counts: { total: data.length, convertible: data.filter(r => !r.mixed).length, mixed: data.filter(r => r.mixed).length },
    });
  } catch (err) {
    console.error("GET /timeclock/tz-audit error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/tz-backfill", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const from = String(req.body?.from || "").slice(0, 10);
    const to = String(req.body?.to || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: "from and to (YYYY-MM-DD) required" });
    }
    // Convert only "clean" field punches (clock-out is itself a field punch or
    // absent). Mixed rows are left for manual correction. Marker prevents any
    // double-shift on re-run.
    const result = await db.execute(sql`
      UPDATE timeclock tc
         SET clock_in_at  = (tc.clock_in_at  AT TIME ZONE 'UTC') AT TIME ZONE ${tzOf(companyId)},
             clock_out_at = CASE WHEN tc.clock_out_at IS NOT NULL
                                 THEN (tc.clock_out_at AT TIME ZONE 'UTC') AT TIME ZONE ${tzOf(companyId)}
                                 ELSE NULL END,
             tz_normalized = true
       WHERE ${tzCandidateWhere(companyId, from, to)}
         AND (tc.clock_out_at IS NULL OR tc.clock_out_lat IS NOT NULL)
      RETURNING tc.id, tc.job_id
    `);
    const updated = result.rows as any[];
    // Re-derive each affected job's actual hours off the corrected times.
    const jobIds = [...new Set(updated.map(r => Number(r.job_id)))];
    for (const jid of jobIds) { try { await recomputeJobActualHours(jid, companyId); } catch { /* non-fatal */ } }
    return res.json({ ok: true, converted: updated.length, jobs_recomputed: jobIds.length });
  } catch (err) {
    console.error("POST /timeclock/tz-backfill error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [paytype-parity 2026-06-05] Per-tech pay-type override. The office sets a
// timesheet's pay type (fee_split | allowed_hours | hourly) + rate/% and an
// optional breakage deduction; the parity engine (lib/commission-paytype.ts)
// reads these off job_technicians. NULL = inherit the job's smart default
// (commercial → allowed_hours; residential → fee_split). Upserts the
// job_technicians row; only edits an existing assignment or the primary tech.
// PUT /api/timeclock/office/job/:jobId/tech/:userId/pay-note
//
// [pay-note 2026-08-12] Maribel + Francisco, after the clock history landed:
// "and also a comment box under every job ... to leave notes like 'Paid for
// trainees', 'Job was $30 per hour', or stuff like that — so you know why some
// has the pay they have." Francisco's mock-up annotated a real timesheet with
// "Alma forgot to clock out" and "we paid an extra hour because she is cool".
// Sal: "kind of like you do in excel."
//
// Deliberately NOT the same thing as the clock history. The history records
// what the system already knows — who moved a punch and when. This carries
// what only a person knows: why the money on this line is what it is. Both
// were asked for, for those two different reasons.
//
// Stored on job_technicians because that row IS the pay line: same (job, tech)
// grain as pay_override / final_pay, so the note sits with the number it
// explains. Empty or whitespace clears it, along with its stamps, so a cleared
// note leaves no "edited by" ghost behind.
router.put("/office/job/:jobId/tech/:userId/pay-note", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const jobId = parseInt(req.params.jobId, 10);
    const userId = parseInt(req.params.userId, 10);
    const companyId = req.auth!.companyId!;
    const actorId = req.auth!.userId ?? null;
    if (!Number.isFinite(jobId) || !Number.isFinite(userId)) return res.status(400).json({ error: "Bad job or tech id" });

    const raw = req.body?.pay_note;
    const note = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 2000) : null;

    const jobRows = (await db.execute(sql`
      SELECT id FROM jobs WHERE id = ${jobId} AND company_id = ${companyId} LIMIT 1`) as any).rows;
    if (!jobRows.length) return res.status(404).json({ error: "Job not found" });

    // Upsert: a tech can have a pay line on the Time Clock screen without a
    // job_technicians row yet (assigned_user_id only). is_primary follows the
    // job's assigned tech — same rule as the pay-override upsert, so writing a
    // note can never silently re-seat the roster.
    await db.execute(sql`
      INSERT INTO job_technicians (job_id, user_id, company_id, is_primary, pay_note, pay_note_by, pay_note_at)
      SELECT ${jobId}, ${userId}, ${companyId}, (j.assigned_user_id = ${userId}),
             ${note}, ${note ? actorId : null}, ${note ? sql`NOW()` : sql`NULL`}
        FROM jobs j WHERE j.id = ${jobId} AND j.company_id = ${companyId}
      ON CONFLICT (job_id, user_id) DO UPDATE SET
        pay_note = EXCLUDED.pay_note,
        pay_note_by = EXCLUDED.pay_note_by,
        pay_note_at = EXCLUDED.pay_note_at`);

    logAudit(req, note ? "PAY_NOTE_SET" : "PAY_NOTE_CLEARED", "job_technicians", jobId,
      null, { job_id: jobId, user_id: userId, pay_note: note });

    return res.json({ ok: true, pay_note: note });
  } catch (err) {
    console.error("PUT /timeclock/office/job/:jobId/tech/:userId/pay-note error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/office/job/:jobId/tech/:userId/pay", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const jobId = parseInt(req.params.jobId);
    const userId = parseInt(req.params.userId);
    if (!jobId || !userId) return res.status(400).json({ error: "jobId and userId are required" });

    const payType = req.body?.pay_type ?? null;
    // [trainee-paytype 2026-07-27] 'trainee' is accepted as a distinct stored
    // label; the pay engine (asPayType) resolves it to 'hourly' so it excludes
    // the tech from the fee-split pool and pays $/hr — identical money, clearer
    // intent than picking "Hourly".
    if (payType !== null && !["fee_split", "allowed_hours", "hourly", "trainee"].includes(payType))
      return res.status(400).json({ error: "pay_type must be fee_split, allowed_hours, hourly, trainee, or null" });

    const numOrNull = (v: any): number | null => {
      if (v === null || v === undefined || v === "") return null;
      const n = parseFloat(String(v));
      return Number.isFinite(n) ? n : NaN as any;
    };
    const hourlyRate = numOrNull(req.body?.hourly_rate);
    const commissionPct = numOrNull(req.body?.commission_pct);
    const dedPct = numOrNull(req.body?.pay_deduction_pct);
    const dedFlat = numOrNull(req.body?.pay_deduction_flat);
    for (const [k, v] of Object.entries({ hourly_rate: hourlyRate, commission_pct: commissionPct, pay_deduction_pct: dedPct, pay_deduction_flat: dedFlat }))
      if (Number.isNaN(v)) return res.status(400).json({ error: `${k} must be a number or null` });

    const [job] = await db.select({ id: jobsTable.id, assigned_user_id: jobsTable.assigned_user_id })
      .from(jobsTable).where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId))).limit(1);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const existing = (await db.execute(
      sql`SELECT id FROM job_technicians WHERE company_id = ${companyId} AND job_id = ${jobId} AND user_id = ${userId} LIMIT 1`,
    )).rows[0] as any;

    if (existing) {
      await db.execute(sql`
        UPDATE job_technicians
           SET pay_type = ${payType}, hourly_rate = ${hourlyRate}, commission_pct = ${commissionPct},
               pay_deduction_pct = ${dedPct}, pay_deduction_flat = ${dedFlat}
         WHERE id = ${existing.id}`);
    } else if (job.assigned_user_id === userId) {
      // Primary tech with no row yet — create it (already mirrors assigned_user_id).
      await db.execute(sql`
        INSERT INTO job_technicians (job_id, user_id, company_id, is_primary, pay_type, hourly_rate, commission_pct, pay_deduction_pct, pay_deduction_flat)
        VALUES (${jobId}, ${userId}, ${companyId}, true, ${payType}, ${hourlyRate}, ${commissionPct}, ${dedPct}, ${dedFlat})`);
    } else {
      return res.status(404).json({ error: "Tech is not assigned to this job" });
    }

    logAudit(req, "TIMECLOCK_PAYTYPE", "job_technicians", jobId,
      null, { user_id: userId, pay_type: payType, hourly_rate: hourlyRate, commission_pct: commissionPct, pay_deduction_pct: dedPct, pay_deduction_flat: dedFlat });
    return res.json({ ok: true, job_id: jobId, user_id: userId, pay_type: payType, hourly_rate: hourlyRate, commission_pct: commissionPct, pay_deduction_pct: dedPct, pay_deduction_flat: dedFlat });
  } catch (err) {
    console.error("PUT /timeclock/office/job/:jobId/tech/:userId/pay error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Time Clock portal: whole-day grid + office edit/delete ───────────────────
// The office reconciles Qleno's per-job clock times against MaidCentral so
// commission (proportional by actual minutes) and hourly pay match. /day pulls
// every job for a date with its assigned tech(s) and the clock on each, grouped
// by employee — so missing/short/extra punches are obvious and MC's exact times
// can be keyed in. The create path is the existing /office/clock-in|out; these
// add EDIT and DELETE. Every correction is audit-logged.
// [addr-audit 2026-07-16] Read-only diagnostic: which jobs will render with NO
// street (only a zip) because no source has one — after the full resolution
// chain (job street → linked property → client address → account's single
// property). These are genuine data gaps that need the real address entered;
// we never guess one. Bucketed by root cause so the office can fix at the
// source. GET /api/timeclock/address-audit?from=YYYY-MM-DD&to=YYYY-MM-DD
// (defaults to the last 30 days through 30 days ahead).
router.get("/address-audit", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const d = (n: number) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || "")) ? String(req.query.from) : d(-30);
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to   || "")) ? String(req.query.to)   : d(30);
    const rows = (await db.execute(sql`
      SELECT j.id, j.scheduled_date::text AS date, j.account_id, j.client_id,
             NULLIF(j.address_zip,'') AS zip,
             CASE WHEN j.account_id IS NOT NULL THEN a.account_name
                  ELSE NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') END AS name,
             NULLIF(TRIM(j.address_street),'')  AS job_street,
             NULLIF(TRIM(ap.address),'')        AS linked_property,
             NULLIF(TRIM(c.address),'')         AS client_address,
             (SELECT MAX(NULLIF(TRIM(ap2.address),'')) FROM account_properties ap2
               WHERE ap2.account_id = j.account_id HAVING COUNT(*) = 1) AS account_single_property,
             (SELECT COUNT(*) FROM account_properties ap2 WHERE ap2.account_id = j.account_id) AS account_property_count
        FROM jobs j
        LEFT JOIN clients c ON c.id = j.client_id
        LEFT JOIN accounts a ON a.id = j.account_id
        LEFT JOIN account_properties ap ON ap.id = j.account_property_id
       WHERE j.company_id = ${companyId}
         AND j.scheduled_date::date BETWEEN ${from}::date AND ${to}::date
         AND j.status IS DISTINCT FROM 'cancelled'
       ORDER BY j.scheduled_date DESC, j.id
    `)).rows as any[];

    // A job "has a street somewhere" if any resolution source supplies one.
    const hasStreet = (r: any) => !!(r.job_street || r.linked_property || r.client_address || r.account_single_property);
    const gaps = rows.filter(r => !hasStreet(r));
    const sample = (r: any) => ({ job_id: r.id, name: r.name || "(no name)", date: r.date, zip: r.zip || null });

    // Root-cause buckets — where the real street should be entered.
    const residentialNoClientAddr = gaps.filter(r => r.client_id && !r.account_id);
    const commercialNoProperty    = gaps.filter(r => r.account_id && Number(r.account_property_count) === 0);
    const commercialMultiPropUnlinked = gaps.filter(r => r.account_id && Number(r.account_property_count) > 1);
    const other = gaps.filter(r =>
      !(r.client_id && !r.account_id) &&
      !(r.account_id && Number(r.account_property_count) === 0) &&
      !(r.account_id && Number(r.account_property_count) > 1));

    return res.json({
      window: { from, to },
      jobs_scanned: rows.length,
      jobs_missing_street: gaps.length,
      buckets: {
        residential_no_client_address: {
          count: residentialNoClientAddr.length,
          fix: "Add the address on the client's profile (or the job).",
          samples: residentialNoClientAddr.slice(0, 25).map(sample),
        },
        commercial_account_has_no_property: {
          count: commercialNoProperty.length,
          fix: "Add a property (with address) to the account, then link the job.",
          samples: commercialNoProperty.slice(0, 25).map(sample),
        },
        commercial_multi_property_job_unlinked: {
          count: commercialMultiPropUnlinked.length,
          fix: "Link the job to the correct account property (account has several).",
          samples: commercialMultiPropUnlinked.slice(0, 25).map(sample),
        },
        other: { count: other.length, fix: "Add the address on the job.", samples: other.slice(0, 25).map(sample) },
      },
    });
  } catch (err) {
    console.error("[address-audit]", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/day", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const date = String(req.query.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date=YYYY-MM-DD required" });
    // [timeclock-show-jobs 2026-06-05] Show EVERY job scheduled that day for the
    // company — NO branch filter. The portal was filtering by the selected
    // branch and hiding the day's jobs (today had 15 scheduled but the portal
    // showed 0) because many jobs carry a null/mismatched branch_id from the MC
    // import. Reconciliation is company-wide anyway; a branch filter can return
    // once branch_id is reliably stamped on every job.
    const jobsRes = await db.execute(sql`
      SELECT j.id AS job_id, j.scheduled_time, j.assigned_user_id,
             j.service_type::text AS service_type, j.address_street,
             j.job_lat, j.job_lng, j.address_lat, j.address_lng,
             j.account_id, j.client_id, j.base_fee, j.billed_amount, j.commission_base, j.allowed_hours, j.estimated_hours, j.branch_id, j.scheduled_date::text AS scheduled_date,
             -- [billed-reconcile 2026-07-27] hourly_rate + manual_rate_override feed
             -- the canonical BILLED total (lib/job-billed.ts) so the clock's revenue
             -- matches the Jobs page ($50/hr × 8h + parking), not the stale
             -- commission_base cache.
             j.hourly_rate, j.manual_rate_override,
             c.client_type, c.lat AS client_lat, c.lng AS client_lng,
             -- Service address so the office can tell apart multiple jobs for the
             -- same client/account on one day (e.g. several PPM units) without
             -- opening the schedule.
             -- [addr-fix 2026-07-16] A job that carries ONLY a zip (no street —
             -- common on MC-imported / recurring-child jobs) used to render as a
             -- bare "60634" and, worse, SHADOW the fuller client/property address
             -- (COALESCE picked the non-empty zip-only string first). Now the
             -- job's own address is used only WHEN IT HAS A STREET; otherwise we
             -- fall through to the account property, then the client address, and
             -- only as a last resort show the job's city/state/zip so nothing is
             -- fully blank. Commercial accounts have no address column of their
             -- own — their street lives on account_properties (ap.address).
             COALESCE(
               CASE WHEN NULLIF(TRIM(j.address_street),'') IS NOT NULL THEN NULLIF(TRIM(
                 j.address_street ||
                 CASE WHEN NULLIF(j.address_city,'')  IS NOT NULL THEN ', ' || j.address_city  ELSE '' END ||
                 CASE WHEN NULLIF(j.address_state,'') IS NOT NULL THEN ', ' || j.address_state ELSE '' END ||
                 CASE WHEN NULLIF(j.address_zip,'')   IS NOT NULL THEN ' '  || j.address_zip   ELSE '' END
               ), '') END,
               NULLIF(TRIM(
                 COALESCE(ap.address,'') ||
                 CASE WHEN NULLIF(ap.property_name,'') IS NOT NULL THEN ' (' || ap.property_name || ')' ELSE '' END
               ), ''),
               NULLIF(TRIM(c.address), ''),
               -- [addr-fix-2 2026-07-16] Commercial job with no street and no
               -- LINKED property: fall back to the account's property address, but
               -- ONLY when the account has exactly one property (HAVING COUNT=1) —
               -- so a multi-property account (e.g. PPM's many buildings) is never
               -- shown a guessed/wrong building. Naturally skips residential jobs
               -- (no account_id → no match).
               (SELECT MAX(NULLIF(TRIM(ap2.address ||
                   CASE WHEN NULLIF(ap2.property_name,'') IS NOT NULL THEN ' (' || ap2.property_name || ')' ELSE '' END), ''))
                  FROM account_properties ap2
                 WHERE ap2.account_id = j.account_id
                HAVING COUNT(*) = 1),
               NULLIF(TRIM(
                 COALESCE(j.address_city,'') ||
                 CASE WHEN NULLIF(j.address_state,'') IS NOT NULL THEN ', ' || j.address_state ELSE '' END ||
                 CASE WHEN NULLIF(j.address_zip,'')   IS NOT NULL THEN ' '  || j.address_zip   ELSE '' END
               ), '')
             ) AS address,
             -- Commercial jobs carry their customer on account_id (client_id is
             -- NULL), so fall back to the account name — otherwise the row read
             -- a useless literal "Client" and the office couldn't reconcile it.
             COALESCE(NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''),
                      a.account_name, c.company_name, 'Client') AS client_name
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN accounts a ON a.id = j.account_id
      LEFT JOIN account_properties ap ON ap.id = j.account_property_id
      WHERE j.company_id = ${companyId}
        AND j.scheduled_date::date = ${date}::date
        AND j.status IS DISTINCT FROM 'cancelled'
      ORDER BY j.scheduled_time NULLS LAST, j.id
    `);
    const jobs = jobsRes.rows as any[];
    console.log(`[TC-DAY] company=${companyId} date=${date} jobsRes=${jobs.length} auth_user=${req.auth?.userId ?? "?"} auth_role=${req.auth?.role ?? "?"}`);
    const jobIds = jobs.map(j => Number(j.job_id)).filter(n => Number.isFinite(n));
    const inList = jobIds.length ? sql.raw(jobIds.join(",")) : null;

    // Pay-type columns are newer than the rest of job_technicians. If the
    // cold-start migration that adds them hasn't applied on this DB yet,
    // selecting them throws and would 500 the WHOLE day (hiding every job).
    // Try the full SELECT, fall back to base columns so the day always loads.
    let techRows: any[] = [];
    if (inList) {
      try {
        techRows = (await db.execute(sql`
          SELECT jt.job_id, jt.user_id, jt.is_primary,
                 jt.pay_type, jt.hourly_rate, jt.commission_pct,
                 jt.pay_deduction_pct, jt.pay_deduction_flat,
                 -- [pay-note 2026-08-12] Carried on the row so the Time Clock
                 -- screen can show the marker without a second round trip.
                 jt.pay_note,
                 to_char(jt.pay_note_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS pay_note_at,
                 NULLIF(TRIM(COALESCE(nu.first_name,'') || ' ' || COALESCE(nu.last_name,'')), '') AS pay_note_by_name,
                 TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name
          FROM job_technicians jt JOIN users u ON u.id = jt.user_id
          LEFT JOIN users nu ON nu.id = jt.pay_note_by
          WHERE jt.job_id IN (${inList})
        `)).rows as any[];
      } catch {
        techRows = (await db.execute(sql`
          SELECT jt.job_id, jt.user_id, jt.is_primary,
                 NULL::text AS pay_type, NULL::numeric AS hourly_rate, NULL::numeric AS commission_pct,
                 NULL::numeric AS pay_deduction_pct, NULL::numeric AS pay_deduction_flat,
                 NULL::text AS pay_note, NULL::text AS pay_note_at, NULL::text AS pay_note_by_name,
                 TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name
          FROM job_technicians jt JOIN users u ON u.id = jt.user_id
          WHERE jt.job_id IN (${inList})
        `)).rows as any[];
      }
    }
    const payByJobUser = new Map<string, any>();
    for (const t of techRows) payByJobUser.set(`${Number(t.job_id)}:${Number(t.user_id)}`, t);

    const clockRows = inList ? ((await db.execute(sql`
      SELECT t.id, t.job_id, t.user_id, t.clock_in_at, t.clock_out_at, t.flagged, t.source,
             t.clock_in_distance_ft, t.clock_out_distance_ft,
             t.clock_in_outside_geofence, t.clock_out_outside_geofence,
             t.clock_in_lat, t.clock_in_lng, t.clock_out_lat, t.clock_out_lng,
             TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name
      FROM timeclock t JOIN users u ON u.id = t.user_id
      WHERE t.company_id = ${companyId} AND t.job_id IN (${inList})
    `)).rows as any[]) : [];

    // [orphan-open-punch 2026-08-13] Maribel, on the open-clocks strip pointing
    // her at Alma's 66-day-old punch: it named the day, she went there, and the
    // row wasn't on it.
    //
    // The day grid is built from jobs SCHEDULED that date, and the clock query
    // above is scoped to those job ids (`t.job_id IN (inList)`). The jobs query
    // also drops anything cancelled. So a punch left running on a job that was
    // later cancelled — or whose scheduled_date moved off this day — is fetched
    // by nothing and renders nowhere. It sits in `timeclock` forever, blocking
    // that tech's next clock-in, with no surface anywhere that can close it.
    // The strip made the punch findable but still pointed at a day that
    // couldn't show it, which is a promise the day view has to honor.
    //
    // So: also pull punches by their OWN date, whatever became of the job. The
    // unmatched-clock loop below already renders rows for clocks with no
    // job/tech pair; these just need to reach it, and the display fields ride
    // along on the row since the job isn't in `jobById`.
    //
    // Deliberately OPEN punches only (clock_out_at IS NULL). A closed punch
    // contributes real minutes, so sweeping those in would silently move worked
    // hours — and the pay/efficiency numbers computed off them — for every past
    // day with a cancelled job. An open punch is worth 0 minutes, so this can
    // add a row to close but can never shift a total.
    const orphanOpen = (await db.execute(sql`
      SELECT t.id, t.job_id, t.user_id, t.clock_in_at, t.clock_out_at, t.flagged, t.source,
             t.clock_in_distance_ft, t.clock_out_distance_ft,
             t.clock_in_outside_geofence, t.clock_out_outside_geofence,
             t.clock_in_lat, t.clock_in_lng, t.clock_out_lat, t.clock_out_lng,
             TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name,
             COALESCE(NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''),
                      a.account_name, c.company_name, 'Client') AS orphan_client_name,
             j.service_type::text AS orphan_service_type,
             j.scheduled_time AS orphan_scheduled_time,
             j.status::text AS orphan_job_status,
             j.scheduled_date::text AS orphan_job_date,
             j.client_id AS orphan_client_id, j.account_id AS orphan_account_id
        FROM timeclock t
        JOIN users u ON u.id = t.user_id
        LEFT JOIN jobs j ON j.id = t.job_id
        LEFT JOIN clients c ON c.id = j.client_id
        LEFT JOIN accounts a ON a.id = j.account_id
       WHERE t.company_id = ${companyId}
         AND t.clock_out_at IS NULL
         AND t.clock_in_at >= ${date}::date
         AND t.clock_in_at < (${date}::date + INTERVAL '1 day')
         ${inList ? sql`AND t.job_id NOT IN (${inList})` : sql``}
    `)).rows as any[];
    for (const o of orphanOpen) clockRows.push(o);

    const jobById = new Map<number, any>(jobs.map(j => [Number(j.job_id), j]));

    // [billed-reconcile 2026-07-27] Canonical BILLED total per job — the number
    // the client was invoiced — via the same computation the dispatch board uses
    // (lib/job-billed.ts). The parking fee and every other add-on live in
    // job_add_ons, NOT in base_fee/billed_amount/commission_base, so the clock's
    // old feeOf() read a figure that silently dropped them (National Able #4357
    // showed $380 here vs the correct $420 on the Jobs page). We sum rate-mods,
    // add-ons, and discounts once (keyed by job_id) and feed them to the helper.
    // Display-only — commission is unaffected (it flows through the pay engine).
    const modSumByJob = new Map<number, { mods: number; flatMods: number }>();
    const addOnSumByJob = new Map<number, number>();
    const discountSumByJob = new Map<number, number>();
    if (inList) {
      try {
        const modRows = (await db.execute(sql`
          SELECT job_id, COALESCE(SUM(amount),0)::numeric AS total,
                 COALESCE(SUM(amount) FILTER (WHERE mod_type = 'flat'),0)::numeric AS flat_total
            FROM job_rate_mods WHERE job_id IN (${inList}) GROUP BY job_id`)).rows as any[];
        for (const r of modRows) modSumByJob.set(Number(r.job_id), { mods: parseFloat(String(r.total ?? "0")), flatMods: parseFloat(String(r.flat_total ?? "0")) });
      } catch { /* job_rate_mods absent — treat as 0 */ }
      try {
        const addRows = (await db.execute(sql`
          SELECT job_id, COALESCE(SUM(subtotal),0)::numeric AS total
            FROM job_add_ons WHERE job_id IN (${inList}) GROUP BY job_id`)).rows as any[];
        for (const r of addRows) addOnSumByJob.set(Number(r.job_id), parseFloat(String(r.total ?? "0")));
      } catch { /* job_add_ons absent — treat as 0 */ }
      try {
        const discRows = (await db.execute(sql`
          SELECT job_id, COALESCE(SUM(amount),0)::numeric AS total
            FROM job_discounts WHERE job_id IN (${inList}) GROUP BY job_id`)).rows as any[];
        for (const r of discRows) discountSumByJob.set(Number(r.job_id), parseFloat(String(r.total ?? "0")));
      } catch { /* job_discounts absent — treat as 0 */ }
    }
    const billedOf = (j: any): number => {
      const jid = Number(j.job_id ?? j.id);
      const m = modSumByJob.get(jid);
      return computeJobBilledNet(
        { base_fee: j.base_fee, billed_amount: j.billed_amount, hourly_rate: j.hourly_rate, allowed_hours: j.allowed_hours, manual_rate_override: j.manual_rate_override },
        { mods: m?.mods ?? 0, flatMods: m?.flatMods ?? 0, addOns: addOnSumByJob.get(jid) ?? 0, discount: discountSumByJob.get(jid) ?? 0 },
        isCommercialJob(j.account_id, j.service_type, j.client_type)
      );
    };

    const techsByJob = new Map<number, { user_id: number; name: string; is_primary: boolean }[]>();
    for (const t of techRows) {
      const arr = techsByJob.get(Number(t.job_id)) || [];
      arr.push({ user_id: Number(t.user_id), name: t.name || "Tech", is_primary: !!t.is_primary });
      techsByJob.set(Number(t.job_id), arr);
    }
    // [second-hidden-clock 2026-08-13] Maribel, after the open-clocks strip sent
    // her to Alma's Jun 8 and the row there showed a DIFFERENT, closed punch:
    // "must be like a second hidden clock since around that time we still
    // allowed those." She's right, and that is exactly the bug.
    //
    // This was `Map<string, any>` with `.set(key, e)` in a loop — last write
    // wins. A (job, tech) pair with two punches rendered ONE row and silently
    // dropped the other, with no marker anywhere that a second entry existed.
    // Before the one-clock-at-a-time rule (#1406) duplicates were allowed, so
    // every pair created back then can carry one. Alma's National Able job has
    // two: a 6:00 AM punch nobody closed, and the 10:58 AM–7:12 PM estimated
    // pair the grid drew instead. The open one was unreachable — invisible in
    // the grid, yet still blocking every clock-in she has attempted since.
    //
    // Now every punch gets its own row. Order is deterministic (a real closed
    // punch first, then by clock-in) so the row that has always carried the
    // day's hours and pay stays the primary and no historical number moves;
    // the extras render beneath it, flagged, contributing $0 and 0 minutes so
    // surfacing them can't inflate a total. The office reconciles from there.
    const entriesByJobUser = new Map<string, any[]>();
    for (const e of clockRows) {
      const k = `${e.job_id}:${e.user_id}`;
      const arr = entriesByJobUser.get(k) || [];
      arr.push(e);
      entriesByJobUser.set(k, arr);
    }
    for (const arr of entriesByJobUser.values()) {
      arr.sort((a, b) => {
        const aClosed = a.clock_out_at ? 0 : 1, bClosed = b.clock_out_at ? 0 : 1;
        if (aClosed !== bClosed) return aClosed - bClosed;
        return String(a.clock_in_at ?? "").localeCompare(String(b.clock_in_at ?? ""));
      });
    }
    const nameByUser = new Map<number, string>();
    for (const t of techRows) if (t.name) nameByUser.set(Number(t.user_id), t.name);
    for (const e of clockRows) if (e.name) nameByUser.set(Number(e.user_id), e.name);

    // Commission per (job, tech) using the SAME engine the Payroll period-lock
    // uses (lib/commission-paytype.ts) — so the portal's pay numbers match the
    // Payroll screen by construction. Pay flows: clock + pay-type here →
    // computePerTechCommissionRows → shown here AND applied at period-lock.
    const payByKey = new Map<string, number>();
    // Declared in the outer scope (not inside the try) because payRowOf below
    // reads them when building each row — a try-local const would be out of
    // scope there (the "chargedCancelJobIds is not defined" 500).
    const chargedCancelJobIds = new Set<number>();
    const cancelPayByKey = new Map<string, number>();
    const cancelActionByJob = new Map<number, string>();
    try {
      let comp: any = { res_tech_pay_pct: 0.35, deep_clean_pay_pct: 0.32, move_in_out_pay_pct: 0.32, commercial_hourly_rate: 20, commercial_comp_mode: "allowed_hours" };
      try {
        const cr = await db.execute(sql`SELECT res_tech_pay_pct, deep_clean_pay_pct, move_in_out_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
        if (cr.rows[0]) comp = cr.rows[0];
      } catch { /* tiered columns absent — keep defaults */ }
      const resRates = parseResRatesRow(comp);
      const commercial = {
        commercial_hourly_rate: parseFloat(String(comp.commercial_hourly_rate ?? 20)),
        commercial_comp_mode: (comp.commercial_comp_mode === "actual_hours" ? "actual_hours" : "allowed_hours") as "actual_hours" | "allowed_hours",
      };
      const serviceTypePctBySlug = new Map<string, number>();
      try {
        const svc = await db.execute(sql`SELECT slug, commission_pct FROM service_types WHERE company_id = ${companyId} AND commission_pct IS NOT NULL`);
        for (const r of svc.rows as any[]) { const p = parseFloat(String(r.commission_pct)); if (Number.isFinite(p)) serviceTypePctBySlug.set(String(r.slug).toLowerCase(), p); }
      } catch { /* per-service column absent */ }
      // Only REAL punches drive pay — exactly what the Payroll period-lock
      // counts (source='punched'). Synthetic 'estimated' pre-seeds show as a
      // row but contribute $0 until the office enters/verifies a real time
      // (which flips them to punched via PATCH).
      // [punch-union 2026-07-01] Count the UNION of each tech's punches per job,
      // not the raw sum — so a duplicate/overlapping entry (invisible behind the
      // grid's single row) can't double-count the fee split. Real split shifts
      // (disjoint punches) still add up.
      const techHoursByKey = unionHoursByKey(
        clockRows.filter((e: any) => e.source === "punched" && e.clock_in_at && e.clock_out_at)
      );
      // [lockout-pay 2026-06-17] Jobs charged via Cancel/Lockout pay the tech
      // the cancellation fee (an additional_pay 'cancellation_pay' row), NOT the
      // job's normal commission — exclude them from the commission calc so the
      // tech isn't double-paid (commission + cancellation fee).
      if (inList) {
        try {
          const cc = await db.execute(sql`
            SELECT DISTINCT job_id, cancel_action FROM cancellation_log
             WHERE company_id = ${companyId} AND job_id IN (${inList})
               AND cancel_action IN ('cancel','lockout')`);
          for (const r of cc.rows as any[]) {
            chargedCancelJobIds.add(Number(r.job_id));
            if (r.cancel_action) cancelActionByJob.set(Number(r.job_id), String(r.cancel_action));
          }
        } catch { /* cancellation_log absent — no exclusion */ }
        // The cancellation fee paid to the tech lives in additional_pay
        // (type 'cancellation_pay'). Surface it per job:tech so the time
        // clock shows the $X the tech is owed for the lockout/cancel
        // instead of a blank "—" (Sal: "no indication of the cancel
        // impacting Hilda's pay"). Keyed by the JOB's date via job_id, not the
        // row's pay day (which is when the office reclassified).
        try {
          const cp = await db.execute(sql`
            SELECT job_id, user_id, COALESCE(SUM(amount), 0)::float AS amount
              FROM additional_pay
             WHERE company_id = ${companyId} AND job_id IN (${inList})
               AND type = 'cancellation_pay' AND status <> 'voided'
             GROUP BY job_id, user_id`);
          for (const r of cp.rows as any[]) cancelPayByKey.set(`${r.job_id}:${r.user_id}`, Number(r.amount));
        } catch { /* additional_pay absent */ }
      }
      const jobTechsForCalc: JobTechRow[] = techRows
        .filter((t: any) => !chargedCancelJobIds.has(Number(t.job_id)))
        .map((t: any) => ({
          job_id: Number(t.job_id), user_id: Number(t.user_id), is_primary: t.is_primary === true,
          pay_type: t.pay_type ?? null, hourly_rate: t.hourly_rate ?? null, commission_pct: t.commission_pct ?? null,
          pay_deduction_pct: t.pay_deduction_pct ?? null, pay_deduction_flat: t.pay_deduction_flat ?? null,
        }));
      const jobsForCalc = jobs
        .filter((j: any) => !chargedCancelJobIds.has(Number(j.job_id)))
        .map((j: any) => ({
          id: Number(j.job_id), assigned_user_id: j.assigned_user_id != null ? Number(j.assigned_user_id) : null,
          service_type: j.service_type ?? null, account_id: j.account_id ?? null, base_fee: j.base_fee ?? null,
          billed_amount: j.billed_amount ?? null, commission_base: j.commission_base ?? null, allowed_hours: j.allowed_hours ?? null, actual_hours: null,
          branch_id: j.branch_id ?? null, scheduled_date: j.scheduled_date ?? date, client_type: j.client_type ?? null,
        })) as CommissionInputJob[];
      for (const r of computePerTechCommissionRows({ jobs: jobsForCalc, jobTechs: jobTechsForCalc, techHoursByKey, serviceTypePctBySlug, resRates, commercial })) {
        payByKey.set(`${r.job_id}:${r.user_id}`, r.amount);
      }
    } catch (e) { console.error("[TC-DAY] pay compute error:", e); }

    type Row = { job_id: number; client_name: string; service_type: string; scheduled_time: string | null;
                 // address + ids so the office can tell apart same-client jobs and
                 // click through to the customer/account + employee profiles.
                 address: string | null; client_id: number | null; account_id: number | null;
                 entry_id: number | null; clock_in_at: string | null; clock_out_at: string | null;
                 flagged: boolean; minutes: number | null;
                 // [orphan-open-punch 2026-08-13] Set when the row exists ONLY to
                 // close a still-running clock whose job isn't on this day's
                 // schedule (cancelled, or moved). Null on every normal row.
                 orphan_reason?: string | null;
                 // [second-hidden-clock 2026-08-13] A SECOND (or later) punch on
                 // the same job+tech. Rendered so it can be closed or deleted,
                 // but excluded from the day's hours and pay — the primary row
                 // already carries those.
                 duplicate?: boolean; duplicate_reason?: string | null;
                 // [pay-note 2026-08-12] Why this line was paid the way it was.
                 pay_note?: string | null; pay_note_at?: string | null; pay_note_by_name?: string | null;
                 // [allowed-hrs-display 2026-07-04] The job's allowed-hours budget
                 // — the number that DRIVES pay on an Allowed Hours line (pay =
                 // allowed_hours × rate × share) and the denominator for budget-vs-
                 // actual efficiency. Was never sent, so Allowed-Hours rows showed a
                 // rate and a $ with no visible hours.
                 allowed_hours: number | null;
                 // [sched-window 2026-07-04] estimated_hours is the fallback
                 // duration for deriving a scheduled STOP time (start + duration)
                 // when allowed_hours isn't set. The meta line showed only the
                 // scheduled start ("sched 6:00 AM") with no end.
                 estimated_hours: number | null;
                 // [fee-split-verify 2026-07-16] The client fee this row's pay is
                 // computed from, so a Fee Split row can show `fee × pct = pay`
                 // inline (Sal: "I need to know what the client paid" without
                 // opening the job). Mirrors the commission engine's base:
                 // commission_base ?? max(base_fee, billed_amount).
                 fee: number | null;
                 // [billed-reconcile 2026-07-27] The canonical BILLED total the
                 // client was invoiced (service + add-ons + mods − discounts),
                 // matching the Jobs page. Distinct from `fee`: `fee` is the
                 // residential fee-split commission base (base_fee, which already
                 // folds add-ons in), while `billed` is the all-in revenue that
                 // ADDS the parking fee on commercial jobs. The UI shows `billed`
                 // as "billed $X"; `fee` stays the commission math input.
                 billed: number | null;
                 // The pay type this row resolves to (override or smart default),
                 // so the UI shows the right verification chip for every client.
                 effective_pay_type: "fee_split" | "allowed_hours" | "hourly";
                 pay_type: string | null; hourly_rate: string | null; commission_pct: string | null;
                 pay_deduction_pct: string | null; pay_deduction_flat: string | null; pay: number | null;
                 // pay_kind tells the UI whether `pay` is normal commission or
                 // a cancellation/lockout fee (so it can label it and skip the
                 // pay-type editor). cancel_action is 'cancel' | 'lockout' when set.
                 pay_kind: "commission" | "cancellation"; cancel_action: string | null;
                 source: string | null;
                 // [gps-on-timeclock 2026-06-11] GPS captured at clock-in/out so
                 // the office can audit field punches right here. has_gps=false
                 // means the punch carried no location (denied permission, or an
                 // office-entered correction).
                 gps_in_ft: number | null; gps_out_ft: number | null;
                 gps_in_outside: boolean | null; gps_out_outside: boolean | null; has_gps: boolean;
                 // Raw punch coordinates so the office can open the exact spot on
                 // a map — surfaced even when distance is null (job not geocoded).
                 gps_in_lat: number | null; gps_in_lng: number | null;
                 gps_out_lat: number | null; gps_out_lng: number | null;
                 // The job's own coordinates (the expected spot) so the GPS
                 // map modal can drop a second pin + show the punch-vs-job gap.
                 job_lat: number | null; job_lng: number | null };
    // Job pin coords: prefer the job's own geocode, then the per-job address
    // geocode, then fall back to the (already-geocoded) client coords so the
    // map pin shows even for jobs that were never geocoded (e.g. recurring
    // children created before on-create geocoding).
    const coordsOf = (j: any) => {
      const lat = j?.job_lat ?? j?.address_lat ?? j?.client_lat;
      const lng = j?.job_lng ?? j?.address_lng ?? j?.client_lng;
      return { job_lat: lat != null ? Number(lat) : null, job_lng: lng != null ? Number(lng) : null };
    };
    // [fee-split-verify 2026-07-16] The client fee the row's commission is based
    // on — same resolution as lib/commission-paytype.ts (commission_base wins;
    // else the larger of base_fee / billed_amount). Lets a Fee Split row display
    // `fee × pct = pay` so the office can verify pay without opening the job.
    const numOrNull = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const feeOf = (j: any): number | null => {
      const cb = numOrNull(j?.commission_base);
      if (cb != null) return cb;
      const bf = numOrNull(j?.base_fee) ?? 0;
      const ba = numOrNull(j?.billed_amount) ?? 0;
      return Math.max(bf, ba);
    };
    // [fee-split-verify 2026-07-16] The pay type a row RESOLVES to — the per-tech
    // override when set, else the job's smart default (commercial → allowed_hours,
    // residential → fee_split). Mirrors lib/commission-paytype.ts exactly
    // (defaultPayForJob + isCommercialJob), so the UI decides which chip to show
    // from the same source that computed the pay — no client-side account_id
    // guess that would misclassify commercial-by-service-type / client_type jobs.
    const asPT = (v: any): "fee_split" | "allowed_hours" | "hourly" | null =>
      // [trainee-paytype 2026-07-27] 'trainee' is a display label for the
      // existing exclude-from-pool behavior — it resolves to 'hourly' for all
      // pay math (excluded from the fee-split pool, paid $/hr). The raw
      // 'trainee' string stays on the row so the dropdown shows "Trainee".
      v === "trainee" ? "hourly" :
      v === "fee_split" || v === "allowed_hours" || v === "hourly" ? v : null;
    const resolvedPayTypeOf = (j: any, rawPayType: any): "fee_split" | "allowed_hours" | "hourly" => {
      const override = asPT(rawPayType);
      if (override) return override;
      return isCommercialJob(j?.account_id, j?.service_type, j?.client_type) ? "allowed_hours" : "fee_split";
    };
    const gpsOf = (e: any) => ({
      gps_in_ft: e?.clock_in_distance_ft != null ? Math.round(parseFloat(String(e.clock_in_distance_ft))) : null,
      gps_out_ft: e?.clock_out_distance_ft != null ? Math.round(parseFloat(String(e.clock_out_distance_ft))) : null,
      gps_in_outside: e?.clock_in_outside_geofence ?? null,
      gps_out_outside: e?.clock_out_outside_geofence ?? null,
      has_gps: !!(e && (e.clock_in_lat != null || e.clock_out_lat != null || e.clock_in_distance_ft != null)),
      gps_in_lat: e?.clock_in_lat != null ? Number(e.clock_in_lat) : null,
      gps_in_lng: e?.clock_in_lng != null ? Number(e.clock_in_lng) : null,
      gps_out_lat: e?.clock_out_lat != null ? Number(e.clock_out_lat) : null,
      gps_out_lng: e?.clock_out_lng != null ? Number(e.clock_out_lng) : null,
    });
    const payOf = (jid: number, uid: number) => {
      const p = payByJobUser.get(`${jid}:${uid}`);
      return {
        pay_type: p?.pay_type ?? null,
        hourly_rate: p?.hourly_rate != null ? String(p.hourly_rate) : null,
        commission_pct: p?.commission_pct != null ? String(p.commission_pct) : null,
        pay_deduction_pct: p?.pay_deduction_pct != null ? String(p.pay_deduction_pct) : null,
        pay_deduction_flat: p?.pay_deduction_flat != null ? String(p.pay_deduction_flat) : null,
      };
    };
    // Resolve a row's pay: charged-cancellation jobs are excluded from
    // commission (above) and instead pay the cancellation fee, so surface that
    // amount + flag it. Normal jobs use the computed commission.
    const payRowOf = (jid: number, uid: number): { pay: number | null; pay_kind: "commission" | "cancellation"; cancel_action: string | null } => {
      if (chargedCancelJobIds.has(jid)) {
        return { pay: cancelPayByKey.get(`${jid}:${uid}`) ?? 0, pay_kind: "cancellation", cancel_action: cancelActionByJob.get(jid) ?? "cancel" };
      }
      return { pay: payByKey.get(`${jid}:${uid}`) ?? null, pay_kind: "commission", cancel_action: null };
    };
    // [pay-note 2026-08-12] The office's own explanation of this pay line,
    // carried on the row so the Time Clock screen can render its marker without
    // a second request. Absent on rows with no job_technicians record.
    const payNoteOf = (jid: number, uid: number) => {
      const t = payByJobUser.get(`${jid}:${uid}`);
      const note = t?.pay_note ? String(t.pay_note) : null;
      return note
        ? { pay_note: note, pay_note_at: t.pay_note_at ?? null, pay_note_by_name: t.pay_note_by_name ?? null }
        : { pay_note: null, pay_note_at: null, pay_note_by_name: null };
    };
    const emp = new Map<number, { user_id: number; name: string; rows: Row[] }>();
    const ensureEmp = (uid: number) => {
      if (!emp.has(uid)) emp.set(uid, { user_id: uid, name: nameByUser.get(uid) || "Tech", rows: [] });
      return emp.get(uid)!;
    };
    const minutesOf = (a: string | null, b: string | null) =>
      a && b ? Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000)) : null;

    // [cancel-no-clock 2026-07-01] A plain office CANCEL (not a lockout) means
    // the visit never happened — keep it off the time clock entirely (Sal:
    // "when we cancel a job it should not have any effect on the clocks as the
    // job was never completed"). Hide such jobs from the per-tech grid UNLESS
    // the tech actually punched on it OR was granted cancellation pay (legacy
    // cancels booked before this change) — so we never hide real worked time or
    // pay already owed. Lockouts always stay visible; the tech earned the fee.
    const jobsWithPunch = new Set<number>(clockRows.map((e: any) => Number(e.job_id)));
    const hiddenCancelJobIds = new Set<number>();
    for (const [jid, act] of cancelActionByJob) {
      if (act !== "cancel") continue;
      if (jobsWithPunch.has(jid)) continue;
      const anyCancelPay = [...cancelPayByKey.entries()]
        .some(([k, amt]) => Number(String(k).split(":")[0]) === jid && (amt ?? 0) > 0);
      if (anyCancelPay) continue;
      hiddenCancelJobIds.add(jid);
    }

    const seen = new Set<string>();
    // Entry ids already drawn. The unmatched-clock loop below used to skip on
    // the job:user key, which meant a duplicate punch on an already-rendered
    // pair was dropped there too — the second half of why the extra clock had
    // nowhere to appear. Skipping by entry id lets every punch land exactly
    // once.
    const renderedEntryIds = new Set<number>();
    for (const j of jobs) {
      const jid = Number(j.job_id);
      if (hiddenCancelJobIds.has(jid)) continue;
      let techs = techsByJob.get(jid) || [];
      if (techs.length === 0 && j.assigned_user_id != null) techs = [{ user_id: Number(j.assigned_user_id), name: nameByUser.get(Number(j.assigned_user_id)) || "Tech", is_primary: true }];
      for (const t of techs) {
        const key = `${jid}:${t.user_id}`;
        seen.add(key);
        const entries = entriesByJobUser.get(key) || [];
        // No punch at all → one empty row to type into, exactly as before.
        const list: (any | null)[] = entries.length ? entries : [null];
        list.forEach((e, idx) => {
          if (e) renderedEntryIds.add(Number(e.id));
          // Only the primary carries the pair's pay and minutes. An extra punch
          // shows its own times so the office can see and close it, but adds
          // nothing to the day's money or hours — the pay engine bills this
          // pair once, and double-counting here is what over-paid Juliana and
          // Norma before the union fix.
          const dup = idx > 0;
          ensureEmp(t.user_id).rows.push({
            job_id: jid, client_name: j.client_name, service_type: j.service_type, scheduled_time: j.scheduled_time ?? null,
            address: j.address ?? null, client_id: j.client_id != null ? Number(j.client_id) : null, account_id: j.account_id != null ? Number(j.account_id) : null,
            entry_id: e ? Number(e.id) : null, clock_in_at: e?.clock_in_at ?? null, clock_out_at: e?.clock_out_at ?? null,
            flagged: !!e?.flagged, minutes: e ? minutesOf(e.clock_in_at, e.clock_out_at) : null,
            allowed_hours: j.allowed_hours != null ? Number(j.allowed_hours) : null,
            estimated_hours: j.estimated_hours != null ? Number(j.estimated_hours) : null,
            fee: feeOf(j),
            billed: billedOf(j),
            effective_pay_type: resolvedPayTypeOf(j, payByJobUser.get(`${jid}:${t.user_id}`)?.pay_type ?? null),
            ...payOf(jid, t.user_id), ...payRowOf(jid, t.user_id), ...payNoteOf(jid, t.user_id), source: e?.source ?? null,
            ...gpsOf(e), ...coordsOf(j),
            ...(dup ? {
              duplicate: true,
              duplicate_reason: e?.clock_out_at
                ? "extra punch on this job — reconcile or delete"
                : "extra punch still running — close or delete",
              pay: null,
            } : {}),
          });
        });
      }
    }
    for (const e of clockRows) {
      const key = `${e.job_id}:${e.user_id}`;
      if (renderedEntryIds.has(Number(e.id))) continue;
      if (seen.has(key) && entriesByJobUser.has(key)) continue;
      const j = jobById.get(Number(e.job_id));
      // [orphan-open-punch 2026-08-13] A punch pulled in by its own date carries
      // its own display fields — its job isn't in `jobById` (cancelled, or moved
      // to another day), so without these the row would read a useless bare
      // "Client" and the office couldn't tell which house to close.
      // orphan_reason explains WHY a row is showing on a day with no such job,
      // so a cancelled-job punch doesn't look like a grid bug.
      const orphanReason = e.orphan_job_status === "cancelled"
        ? "job cancelled — clock left running"
        : e.orphan_job_date && e.orphan_job_date !== date
          ? `job moved to ${e.orphan_job_date} — clock left running`
          : e.orphan_client_name != null
            ? "clock left running — job not on this day"
            : null;
      ensureEmp(Number(e.user_id)).rows.push({
        job_id: Number(e.job_id), client_name: e.orphan_client_name ?? j?.client_name ?? "Client", service_type: e.orphan_service_type ?? j?.service_type ?? "",
        address: j?.address ?? null,
        client_id: (e.orphan_client_id ?? j?.client_id) != null ? Number(e.orphan_client_id ?? j.client_id) : null,
        account_id: (e.orphan_account_id ?? j?.account_id) != null ? Number(e.orphan_account_id ?? j.account_id) : null,
        orphan_reason: orphanReason,
        scheduled_time: e.orphan_scheduled_time ?? j?.scheduled_time ?? null, entry_id: Number(e.id), clock_in_at: e.clock_in_at ?? null,
        clock_out_at: e.clock_out_at ?? null, flagged: !!e.flagged, minutes: minutesOf(e.clock_in_at, e.clock_out_at),
        allowed_hours: j?.allowed_hours != null ? Number(j.allowed_hours) : null,
        estimated_hours: j?.estimated_hours != null ? Number(j.estimated_hours) : null,
        fee: feeOf(j),
        billed: j ? billedOf(j) : null,
        effective_pay_type: resolvedPayTypeOf(j, payByJobUser.get(`${Number(e.job_id)}:${Number(e.user_id)}`)?.pay_type ?? null),
        ...payOf(Number(e.job_id), Number(e.user_id)), ...payRowOf(Number(e.job_id), Number(e.user_id)),
        ...payNoteOf(Number(e.job_id), Number(e.user_id)), source: e.source ?? null,
        ...gpsOf(e), ...coordsOf(j),
      });
    }

    const employees = [...emp.values()].map(ev => {
      // [second-hidden-clock 2026-08-13] Duplicate rows are visibility only —
      // they must never move the day's hours or pay. Excluded from both sums so
      // surfacing a punch that was hidden yesterday can't change what anyone
      // gets paid today.
      const counted = ev.rows.filter(r => !r.duplicate);
      const worked = counted.reduce((s, r) => s + (r.minutes ?? 0), 0);
      const ins = ev.rows.map(r => r.clock_in_at).filter(Boolean) as string[];
      const outs = ev.rows.map(r => r.clock_out_at).filter(Boolean) as string[];
      const payTotal = counted.reduce((s, r) => s + (r.pay ?? 0), 0);
      return {
        ...ev,
        rows: ev.rows.sort((a, b) => String(a.scheduled_time || "~").localeCompare(String(b.scheduled_time || "~"))),
        worked_minutes: worked,
        pay_total: Math.round(payTotal * 100) / 100,
        day_start: ins.length ? ins.reduce((a, b) => (a < b ? a : b)) : null,
        day_end: outs.length ? outs.reduce((a, b) => (a > b ? a : b)) : null,
        open: ev.rows.some(r => r.clock_in_at && !r.clock_out_at),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    // Day-level business metrics for the summary bar. Revenue is summed per
    // UNIQUE job (not per tech-row, which would double-count multi-tech jobs).
    const pf = (v: any) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : 0; };
    // [billed-reconcile 2026-07-27] Top-line revenue must reconcile to the
    // dispatch board / invoice — sum the canonical all-in billed per job
    // (service + add-ons + mods − discounts), NOT the stale
    // billed_amount/base_fee columns which drop the parking fee. National
    // Able #4357 read $380 here vs $420 on Jobs before this fix.
    const revenue = Math.round(jobs.reduce((s, j: any) => s + billedOf(j), 0) * 100) / 100;
    const allowedHoursTotal = Math.round(jobs.reduce((s, j: any) => s + pf(j.allowed_hours), 0) * 100) / 100;

    // Today's additional pay (bonuses, sick/holiday, etc.) so the Payroll %
    // reflects full payroll, not commission alone. Day-scoped by created_at.
    let additionalPayTotal = 0;
    try {
      const ap = await db.execute(sql`
        SELECT COALESCE(SUM(amount), 0)::float AS total
        FROM additional_pay
        WHERE company_id = ${companyId}
          AND status <> 'voided'
          AND type <> 'cancellation_pay'
          AND created_at::date = ${date}::date
      `);
      additionalPayTotal = Math.round(Number((ap.rows[0] as any)?.total ?? 0) * 100) / 100;
    } catch { /* additional_pay table absent — leave 0 */ }

    console.log(`[TC-DAY] company=${companyId} date=${date} RESULT jobs=${jobs.length} techRows=${techRows.length} clockRows=${clockRows.length} employees=${employees.length}`);
    return res.json({ date, employees, revenue, allowed_hours_total: allowedHoursTotal, additional_pay_total: additionalPayTotal, diagnostics: { jobCount: jobs.length, techRows: techRows.length, clockRows: clockRows.length } });
  } catch (err: any) {
    // Surface the failure to the UI instead of a silent 500 → empty screen.
    // The Time Clock empty-state renders this so we can diagnose without
    // DevTools. 200 keeps the front-end from swallowing it.
    console.error("GET /timeclock/day error:", err);
    return res.status(200).json({ date: String(req.query.date || "").slice(0, 10), employees: [], diagnostics: { error: String(err?.message || err) } });
  }
});

router.patch("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });
    const [existing] = await db.select().from(timeclockTable)
      .where(and(eq(timeclockTable.id, id), eq(timeclockTable.company_id, companyId))).limit(1);
    if (!existing) return res.status(404).json({ error: "Not found" });

    const set: Record<string, any> = {};
    if (req.body?.clock_in_at !== undefined) {
      const d = new Date(req.body.clock_in_at);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "Invalid clock_in_at" });
      set.clock_in_at = d;
    }
    if (req.body?.clock_out_at !== undefined) {
      if (req.body.clock_out_at === null) set.clock_out_at = null;
      else {
        const d = new Date(req.body.clock_out_at);
        if (isNaN(d.getTime())) return res.status(400).json({ error: "Invalid clock_out_at" });
        set.clock_out_at = d;
      }
    }
    if (Object.keys(set).length === 0) return res.status(400).json({ error: "Nothing to update" });

    const inAt = set.clock_in_at ?? existing.clock_in_at;
    const outAt = set.clock_out_at !== undefined ? set.clock_out_at : existing.clock_out_at;
    if (inAt && outAt && new Date(outAt).getTime() < new Date(inAt).getTime())
      return res.status(400).json({ error: "Clock-out cannot be before clock-in" });

    // [clock-out-frame 2026-08-07] An office-typed time is a WALL-CLOCK time, so
    // the row must be marked normalized. Without this an edited legacy row keeps
    // tz_normalized=false while now holding wall-clock digits, and the clock-out
    // frame check would pick the wrong frame for it next time — reintroducing
    // the bug fixed in #1372 on exactly the rows the office just corrected.
    if (set.clock_in_at !== undefined || set.clock_out_at !== undefined) set.tz_normalized = true;

    // An office edit is a verified real time — promote a synthetic 'estimated'
    // punch to 'punched' so it counts in payroll (period-lock uses punched
    // only) and matches what the portal shows.
    set.source = "punched";

    const [updated] = await db.update(timeclockTable).set(set).where(eq(timeclockTable.id, id)).returning();
    await recomputeJobActualHours(existing.job_id, companyId);
    logAudit(req, "TIMECLOCK_EDIT", "timeclock", id,
      { clock_in_at: existing.clock_in_at, clock_out_at: existing.clock_out_at },
      { clock_in_at: updated.clock_in_at, clock_out_at: updated.clock_out_at });

    // [manual-clock-completion 2026-07-01] Mirror the field-app clock-out (GAP2):
    // when this office edit leaves the job with a closed clock and NO open
    // entries, the job is done — mark it complete so the dispatch card shows the
    // completion check. Previously fixing clocks manually left status untouched,
    // so the green check never appeared (office bug report). Guarded + idempotent
    // (no-op if already complete/cancelled); generates the draft invoice like the
    // field path so a manually-completed job isn't left invoice-less. The
    // satisfaction survey is intentionally NOT fired here — an office data-fix
    // (often days later) shouldn't message the customer about an old job.
    const completedJobId = existing.job_id;
    if (outAt && completedJobId != null) {
      try {
        const openLeft = await db.execute(sql`
          SELECT COUNT(*)::int AS cnt FROM timeclock
          WHERE job_id = ${completedJobId} AND clock_out_at IS NULL
        `);
        if (((openLeft.rows[0] as any)?.cnt ?? 0) === 0) {
          const done = await db.execute(sql`
            UPDATE jobs
            SET status = 'complete', actual_end_time = ${outAt}, completed_by_user_id = ${req.auth!.userId}
            WHERE id = ${completedJobId} AND company_id = ${companyId}
              AND status NOT IN ('complete', 'cancelled')
            RETURNING id
          `);
          if (done.rows[0]) {
            // [completion-audit 2026-07-28] Audit the office clock-edit completion
            // ("Marked complete — office clock edit · <user>"). Non-blocking.
            void logJobStatusChange({
              companyId,
              jobId: completedJobId!,
              actorUserId: req.auth!.userId ?? null,
              priorStatus: "in_progress",
              newStatus: "complete",
              source: "office clock edit",
            });
            // completedJobId is non-null (guarded above); the assertion just
            // restores the narrowing TS drops across the awaits.
            ensureInvoiceForCompletedJob(companyId, completedJobId!, req.auth!.userId)
              .catch((e: Error) => console.error("[manual-clock invoice] non-fatal:", e));
          }
        }
      } catch (e) {
        console.error("[manual-clock completion] non-fatal:", e);
      }
    }

    return res.json(updated);
  } catch (err) {
    console.error("PATCH /timeclock/:id error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });
    const [existing] = await db.select().from(timeclockTable)
      .where(and(eq(timeclockTable.id, id), eq(timeclockTable.company_id, companyId))).limit(1);
    if (!existing) return res.status(404).json({ error: "Not found" });
    await db.delete(timeclockTable).where(eq(timeclockTable.id, id));
    await recomputeJobActualHours(existing.job_id, companyId);
    logAudit(req, "TIMECLOCK_DELETE", "timeclock", id,
      { clock_in_at: existing.clock_in_at, clock_out_at: existing.clock_out_at, job_id: existing.job_id, user_id: existing.user_id }, null);
    // [ghost-completion-revert 2026-07-28] If deleting this punch just emptied a
    // clock-out-completed job's timeclock, revert it out of Complete (tight
    // predicate — no-op for office / bulk / charged completions). Non-fatal.
    let reverted = false;
    if (existing.job_id != null) {
      reverted = await revertJobIfGhostCompletion({ companyId, jobId: existing.job_id, actorUserId: req.auth!.userId ?? null });
    }
    return res.json({ success: true, reverted });
  } catch (err) {
    console.error("DELETE /timeclock/:id error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/timeclock/:id/history — who touched this clock, and when.
//
// [clock-history 2026-08-12] Maribel, on the office keying in clock times:
// "show like a history when we hover over about this clock or something, so we
// can see who changed it when." Francisco had asked for a free-text Note field
// per service; Maribel's version is better and Sal agreed — the office should
// not have to REMEMBER to write down what the system already knows. A note
// records what someone chose to say; this records what actually happened.
//
// Two sources, one timeline:
//   - the entry itself: how the punch originated (field punch vs office-keyed
//     vs a synthetic 'estimated' row) and when it was created.
//   - app_audit_log rows for this entry: every office create, edit and delete,
//     with the actor resolved to a name and the before/after times.
// Office-only: techs never see who edited their clock (same posture as the
// overtime surfaces).
router.get("/:id/history", requireAuth, requireRole("owner", "admin", "office", "super_admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    // [clock-history-500 2026-08-13] Maribel: "the history says this though" —
    // Internal Server Error, on every entry. This SELECT asked for
    // `tc.created_at`, and there IS no created_at on `timeclock` (see
    // lib/db/src/schema/timeclock.ts — the row records clock_in_at/clock_out_at
    // and nothing about when it was written). Postgres answers "column
    // tc.created_at does not exist", the route's catch turns that into a 500,
    // and the popover prints it. The History button shipped yesterday (#1406)
    // and has failed on every click since — it never worked once.
    //
    // Not adding the column to fix this. Backfilling it would have to invent a
    // creation time for every historical punch, and a history panel that makes
    // up timestamps is worse than one that admits what it doesn't know. The
    // origin time is derived below from signals that are actually recorded.
    const entryRows = (await db.execute(sql`
      SELECT tc.id, tc.source, tc.clock_in_at, tc.clock_out_at, tc.override_approved,
             NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS tech_name
        FROM timeclock tc
        LEFT JOIN users u ON u.id = tc.user_id
       WHERE tc.id = ${id} AND tc.company_id = ${companyId} LIMIT 1`) as any).rows;
    if (!entryRows.length) return res.status(404).json({ error: "Time entry not found" });
    const entry = entryRows[0] as any;

    const auditRows = (await db.execute(sql`
      SELECT a.action, a.old_value, a.new_value, a.performed_at,
             NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS actor_name
        FROM app_audit_log a
        LEFT JOIN users u ON u.id = a.performed_by
       WHERE a.company_id = ${companyId}
         AND a.target_type = 'timeclock'
         AND a.target_id = ${String(id)}
       ORDER BY a.performed_at ASC`) as any).rows;

    // The origin line. A 'punched' row with no office-create audit came from the
    // field app; anything the office keyed in has its own audit row below, so we
    // do not guess an actor here — an honest blank beats a wrong name.
    const officeCreate = auditRows.find((r: any) => r.action === "TIMECLOCK_OFFICE_IN");
    const hasOfficeCreate = !!officeCreate;
    // Origin time, from what's actually on record. An office-keyed row has an
    // audit entry stamped when it was written — that IS the creation moment. A
    // field punch has no such row, and for it clock_in_at is the creation
    // moment: the row exists because the tech tapped Clock In at that time.
    // Null only when neither exists, which the UI already renders as "—".
    const createdAt = officeCreate?.performed_at ?? entry.clock_in_at ?? null;
    const events = [
      {
        kind: "created",
        at: createdAt,
        actor_name: officeCreate?.actor_name ?? null,
        detail: hasOfficeCreate
          ? "Entered by the office"
          : entry.source === "estimated"
            ? "Estimated entry — no punch recorded"
            : "Punched from the field app",
      },
      ...auditRows.map((r: any) => ({
        kind: r.action === "TIMECLOCK_EDIT" ? "edited"
            : r.action === "TIMECLOCK_DELETE" ? "deleted"
            : r.action === "TIMECLOCK_OFFICE_IN" ? "office_in"
            : r.action === "TIMECLOCK_OFFICE_OUT" ? "office_out"
            : "changed",
        at: r.performed_at,
        actor_name: r.actor_name ?? null,
        old_value: r.old_value ?? null,
        new_value: r.new_value ?? null,
      })),
    ];

    return res.json({
      entry: {
        id: entry.id, source: entry.source, tech_name: entry.tech_name,
        clock_in_at: entry.clock_in_at, clock_out_at: entry.clock_out_at,
      },
      events,
    });
  } catch (err) {
    console.error("GET /timeclock/:id/history error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
