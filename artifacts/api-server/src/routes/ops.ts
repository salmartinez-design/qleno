/**
 * Cutover 1D — Office command-center surface.
 *
 * Five GET endpoints under /api/ops, all gated to owner / admin /
 * office / super_admin and all tenant-scoped via req.auth!.companyId.
 * Techs receive 403 explicitly.
 *
 *   GET /api/ops/today/summary         — count cards for the strip
 *   GET /api/ops/today/active-jobs     — workhorse list (filterable)
 *   GET /api/ops/today/exceptions      — failed_exception queue
 *   GET /api/ops/today/live-locations  — currently on-shift pins
 *   GET /api/ops/jobs/:jobId/detail    — drawer payload (worksheet
 *                                        + photos + notes + clock
 *                                        timeline including
 *                                        corrections)
 *
 * The clock-correction + exception-review WRITE endpoints already
 * live in /api/office/* from 1C (routes/office-clock.ts). 1D's
 * surface consumes them; this route file is read-only.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  jobsTable,
  clientsTable,
  usersTable,
  accountsTable,
  accountPropertiesTable,
  serviceTypesTable,
  jobClockEventsTable,
  jobWorksheetTable,
  jobPhotosTable,
  technicianNotesTable,
  onMyWayEventsTable,
} from "@workspace/db/schema";
import { and, asc, desc, eq, inArray, isNull, isNotNull, sql, count } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { LATE_THRESHOLD_MINUTES } from "../lib/job-status-constants.js";

const router = Router();

// Office-only gate for every endpoint here. Techs explicitly 403.
const officeOnly = requireRole("owner", "admin", "office", "super_admin");

router.use(requireAuth, officeOnly);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function todayIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function resolveDateParam(raw: unknown): string | null {
  if (raw == null || raw === "") return todayIso();
  if (typeof raw !== "string" || !ISO_DATE_RE.test(raw)) return null;
  return raw;
}

/**
 * Parse jobs.scheduled_time (text — "09:00", "9:00 AM", "HH:MM:SS")
 * into a Date for a given scheduled_date (YYYY-MM-DD). Returns null on
 * unparseable input — late detection skips those rows rather than
 * mis-classifying them.
 */
function parseScheduledStart(dateStr: string, time: string | null): Date | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i.exec(time.trim());
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && hh < 12) hh += 12;
  if (ampm === "AM" && hh === 12) hh = 0;
  const [y, mo, d] = dateStr.split("-").map(Number);
  const out = new Date(y, mo - 1, d, hh, mm);
  return Number.isFinite(out.getTime()) ? out : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ops/today/summary — count cards for Section 1
// ─────────────────────────────────────────────────────────────────────────────

router.get("/today/summary", async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const date = resolveDateParam(req.query.date);
    if (date == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "date must be YYYY-MM-DD" });
    }

    // Pull every job touching today + the latest clock_in event per
    // (job, user). Late detection happens in JS so we can use the
    // shared LATE_THRESHOLD_MINUTES constant.
    const jobs = await db
      .select({
        id: jobsTable.id,
        assigned_user_id: jobsTable.assigned_user_id,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        status: jobsTable.status,
      })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.scheduled_date, date),
        ),
      );

    const jobIds = jobs.map((j) => j.id);

    // Open clock-in events (no matching clock-out yet) for today's jobs.
    let openClockEvents: Array<{
      job_id: number;
      user_id: number;
      event_at: Date;
    }> = [];
    if (jobIds.length > 0) {
      openClockEvents = await db
        .select({
          job_id: jobClockEventsTable.job_id,
          user_id: jobClockEventsTable.user_id,
          event_at: jobClockEventsTable.event_at,
        })
        .from(jobClockEventsTable)
        .where(
          and(
            eq(jobClockEventsTable.company_id, companyId),
            eq(jobClockEventsTable.event_type, "clock_in"),
            inArray(jobClockEventsTable.job_id, jobIds),
          ),
        );
    }
    // Resolve actual clock-in per job: latest clock_in_at, then filter
    // out the ones with a later clock_out_at.
    const clockInByJob = new Map<number, { user_id: number; event_at: Date }>();
    for (const ev of openClockEvents) {
      const prev = clockInByJob.get(ev.job_id);
      if (!prev || ev.event_at > prev.event_at) {
        clockInByJob.set(ev.job_id, {
          user_id: ev.user_id,
          event_at: ev.event_at,
        });
      }
    }

    // On-my-way late signals for today's jobs.
    let earlyLateSignals = new Set<number>();
    if (jobIds.length > 0) {
      const rows = await db
        .select({ job_id: onMyWayEventsTable.job_id })
        .from(onMyWayEventsTable)
        .where(
          and(
            eq(onMyWayEventsTable.company_id, companyId),
            eq(onMyWayEventsTable.eta_edited_after_scheduled_start, true),
            inArray(onMyWayEventsTable.job_id, jobIds),
          ),
        );
      for (const r of rows) earlyLateSignals.add(r.job_id);
    }

    // Compute the counts.
    const techsOnShift = new Set<number>();
    let jobsInProgress = 0;
    let jobsComplete = 0;
    let jobsPending = 0;
    let lateCount = 0;
    for (const j of jobs) {
      const status = j.status;
      if (status === "in_progress") {
        jobsInProgress++;
        if (j.assigned_user_id != null) techsOnShift.add(j.assigned_user_id);
      } else if (status === "complete") {
        jobsComplete++;
      } else {
        jobsPending++;
      }

      // Late detection — two paths:
      //   1. on_my_way_event flagged eta_edited_after_scheduled_start
      //   2. actual clock_in_at past scheduled_start by LATE_THRESHOLD_MINUTES
      if (earlyLateSignals.has(j.id)) {
        lateCount++;
        continue;
      }
      const clockIn = clockInByJob.get(j.id);
      const scheduledStart = parseScheduledStart(j.scheduled_date, j.scheduled_time);
      if (clockIn && scheduledStart) {
        const diffMin =
          (clockIn.event_at.getTime() - scheduledStart.getTime()) / 60000;
        if (diffMin >= LATE_THRESHOLD_MINUTES) lateCount++;
      }
    }

    // Unreviewed exceptions count.
    const exceptionsRows = await db
      .select({ c: count() })
      .from(jobClockEventsTable)
      .where(
        and(
          eq(jobClockEventsTable.company_id, companyId),
          eq(jobClockEventsTable.gps_status, "failed_exception"),
          isNull(jobClockEventsTable.exception_reviewed_at),
        ),
      );
    const exceptionsAwaitingReview = Number(exceptionsRows[0]?.c ?? 0);

    return res.json({
      data: {
        date,
        on_shift_now: techsOnShift.size,
        jobs_in_progress: jobsInProgress,
        jobs_complete_today: jobsComplete,
        jobs_pending_later_today: jobsPending,
        gps_exceptions_awaiting_review: exceptionsAwaitingReview,
        late_arrivals_today: lateCount,
      },
    });
  } catch (err) {
    console.error("[ops] summary error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load summary" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ops/today/active-jobs — Section 3 list with filter pills
// ─────────────────────────────────────────────────────────────────────────────
//
// Query params:
//   date    — YYYY-MM-DD (default today)
//   filter  — all | in_progress | late | exceptions | complete | pending
//   q       — search term against tech name or client display name

router.get("/today/active-jobs", async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const date = resolveDateParam(req.query.date);
    if (date == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "date must be YYYY-MM-DD" });
    }
    const filter = String(req.query.filter ?? "all");
    const q = (req.query.q as string | undefined)?.trim().toLowerCase() ?? "";

    const rows = await db
      .select({
        id: jobsTable.id,
        assigned_user_id: jobsTable.assigned_user_id,
        tech_first_name: usersTable.first_name,
        tech_last_name: usersTable.last_name,
        client_id: jobsTable.client_id,
        client_first_name: clientsTable.first_name,
        client_last_name: clientsTable.last_name,
        client_company_name: clientsTable.company_name,
        account_name: accountsTable.account_name,
        property_name: accountPropertiesTable.property_name,
        address_street: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.address} ELSE ${clientsTable.address} END`,
        address_city: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.city} ELSE ${clientsTable.city} END`,
        address_state: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.state} ELSE ${clientsTable.state} END`,
        address_zip: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.zip} ELSE ${clientsTable.zip} END`,
        service_type_slug: jobsTable.service_type,
        service_type_name: serviceTypesTable.name,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        allowed_hours: jobsTable.allowed_hours,
        job_kind: jobsTable.job_kind,
      })
      .from(jobsTable)
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(
        accountPropertiesTable,
        eq(jobsTable.account_property_id, accountPropertiesTable.id),
      )
      .leftJoin(
        serviceTypesTable,
        and(
          eq(serviceTypesTable.company_id, companyId),
          eq(serviceTypesTable.slug, jobsTable.service_type),
        ),
      )
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.scheduled_date, date),
        ),
      )
      .orderBy(
        // In-progress first, then by scheduled_time.
        sql`CASE ${jobsTable.status} WHEN 'in_progress' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'complete' THEN 2 ELSE 3 END`,
        asc(jobsTable.scheduled_time),
        asc(jobsTable.id),
      );

    const jobIds = rows.map((r) => r.id);

    // Clock-in events (latest per job) for actual_clock_in_at + within_geofence.
    const clockMap = new Map<
      number,
      {
        clock_in_at: Date | null;
        clock_in_within_geofence: boolean | null;
        clock_in_gps_status: string | null;
        clock_in_event_id: number | null;
      }
    >();
    if (jobIds.length > 0) {
      const clockRows = await db
        .select({
          id: jobClockEventsTable.id,
          job_id: jobClockEventsTable.job_id,
          event_type: jobClockEventsTable.event_type,
          event_at: jobClockEventsTable.event_at,
          within_geofence: jobClockEventsTable.within_geofence,
          gps_status: jobClockEventsTable.gps_status,
        })
        .from(jobClockEventsTable)
        .where(
          and(
            eq(jobClockEventsTable.company_id, companyId),
            inArray(jobClockEventsTable.job_id, jobIds),
            eq(jobClockEventsTable.event_type, "clock_in"),
          ),
        )
        .orderBy(desc(jobClockEventsTable.event_at));
      // Take the most recent clock_in per job.
      for (const c of clockRows) {
        if (!clockMap.has(c.job_id)) {
          clockMap.set(c.job_id, {
            clock_in_at: c.event_at,
            clock_in_within_geofence: c.within_geofence,
            clock_in_gps_status: c.gps_status,
            clock_in_event_id: c.id,
          });
        }
      }
    }

    // Late signals from on_my_way_events.
    const earlyLate = new Set<number>();
    if (jobIds.length > 0) {
      const rows2 = await db
        .select({ job_id: onMyWayEventsTable.job_id })
        .from(onMyWayEventsTable)
        .where(
          and(
            eq(onMyWayEventsTable.company_id, companyId),
            eq(onMyWayEventsTable.eta_edited_after_scheduled_start, true),
            inArray(onMyWayEventsTable.job_id, jobIds),
          ),
        );
      for (const r of rows2) earlyLate.add(r.job_id);
    }

    // Unreviewed exception markers per job (we surface a flag on the
    // row so the office sees "this job has an exception" without a
    // separate fetch).
    const jobsWithException = new Set<number>();
    if (jobIds.length > 0) {
      const rows3 = await db
        .select({ job_id: jobClockEventsTable.job_id })
        .from(jobClockEventsTable)
        .where(
          and(
            eq(jobClockEventsTable.company_id, companyId),
            eq(jobClockEventsTable.gps_status, "failed_exception"),
            isNull(jobClockEventsTable.exception_reviewed_at),
            inArray(jobClockEventsTable.job_id, jobIds),
          ),
        );
      for (const r of rows3) jobsWithException.add(r.job_id);
    }

    // Decorate + filter.
    const decorated = rows.map((r) => {
      const clock = clockMap.get(r.id);
      const scheduledStart = parseScheduledStart(r.scheduled_date, r.scheduled_time);
      let minutesLate: number | null = null;
      let isLate = false;
      if (earlyLate.has(r.id)) isLate = true;
      if (clock?.clock_in_at && scheduledStart) {
        const diff = (clock.clock_in_at.getTime() - scheduledStart.getTime()) / 60000;
        if (diff >= LATE_THRESHOLD_MINUTES) {
          isLate = true;
          minutesLate = Math.round(diff);
        }
      }
      const techName = r.tech_first_name
        ? `${r.tech_first_name ?? ""} ${r.tech_last_name ?? ""}`.trim()
        : null;
      const clientDisplayName = resolveClientDisplayName(r);
      return {
        id: r.id,
        tech_user_id: r.assigned_user_id,
        tech_name: techName,
        client_display_name: clientDisplayName,
        address_street: r.address_street,
        address_city: r.address_city,
        address_state: r.address_state,
        address_zip: r.address_zip,
        service_type_name: r.service_type_name ?? r.service_type_slug,
        scheduled_date: r.scheduled_date,
        scheduled_time: r.scheduled_time,
        allowed_hours: r.allowed_hours != null ? Number(r.allowed_hours) : null,
        status: r.status,
        job_kind: r.job_kind,
        clock_in_at: clock?.clock_in_at ? clock.clock_in_at.toISOString() : null,
        clock_in_event_id: clock?.clock_in_event_id ?? null,
        clock_in_within_geofence: clock?.clock_in_within_geofence ?? null,
        clock_in_gps_status: clock?.clock_in_gps_status ?? null,
        is_late: isLate,
        minutes_late: minutesLate,
        has_unreviewed_exception: jobsWithException.has(r.id),
      };
    });

    const filtered = decorated.filter((j) => {
      if (q) {
        const hay = `${j.tech_name ?? ""} ${j.client_display_name}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      switch (filter) {
        case "in_progress":
          return j.status === "in_progress";
        case "late":
          return j.is_late;
        case "exceptions":
          return j.has_unreviewed_exception;
        case "complete":
          return j.status === "complete";
        case "pending":
          return (
            j.status !== "in_progress" &&
            j.status !== "complete" &&
            j.status !== "cancelled"
          );
        case "all":
        default:
          return true;
      }
    });

    return res.json({ data: filtered });
  } catch (err) {
    console.error("[ops] active-jobs error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load active jobs" });
  }
});

function resolveClientDisplayName(r: {
  job_kind: string | null;
  account_name: string | null;
  property_name: string | null;
  client_company_name: string | null;
  client_first_name: string | null;
  client_last_name: string | null;
}): string {
  if (r.job_kind === "office_event" || r.job_kind === "meeting") {
    return r.account_name ?? "Office event";
  }
  if (r.account_name) {
    return r.property_name
      ? `${r.account_name} — ${r.property_name}`
      : r.account_name;
  }
  if (r.client_company_name) return r.client_company_name;
  const first = (r.client_first_name ?? "").trim();
  const last = (r.client_last_name ?? "").trim();
  return [first, last].filter(Boolean).join(" ") || "Client";
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ops/today/exceptions — Section 4 queue
// ─────────────────────────────────────────────────────────────────────────────

router.get("/today/exceptions", async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const rows = await db
      .select({
        id: jobClockEventsTable.id,
        job_id: jobClockEventsTable.job_id,
        user_id: jobClockEventsTable.user_id,
        event_type: jobClockEventsTable.event_type,
        event_at: jobClockEventsTable.event_at,
        exception_reason: jobClockEventsTable.exception_reason,
        exception_photo_url: jobClockEventsTable.exception_photo_url,
        tech_first_name: usersTable.first_name,
        tech_last_name: usersTable.last_name,
        client_id: jobsTable.client_id,
        client_first_name: clientsTable.first_name,
        client_last_name: clientsTable.last_name,
        client_company_name: clientsTable.company_name,
        account_name: accountsTable.account_name,
        property_name: accountPropertiesTable.property_name,
        job_kind: jobsTable.job_kind,
        scheduled_date: jobsTable.scheduled_date,
      })
      .from(jobClockEventsTable)
      .leftJoin(usersTable, eq(jobClockEventsTable.user_id, usersTable.id))
      .leftJoin(jobsTable, eq(jobClockEventsTable.job_id, jobsTable.id))
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(
        accountPropertiesTable,
        eq(jobsTable.account_property_id, accountPropertiesTable.id),
      )
      .where(
        and(
          eq(jobClockEventsTable.company_id, companyId),
          eq(jobClockEventsTable.gps_status, "failed_exception"),
          isNull(jobClockEventsTable.exception_reviewed_at),
        ),
      )
      .orderBy(desc(jobClockEventsTable.event_at))
      .limit(200);

    return res.json({
      data: rows.map((r) => ({
        id: r.id,
        job_id: r.job_id,
        scheduled_date: r.scheduled_date,
        event_type: r.event_type,
        event_at: r.event_at?.toISOString() ?? null,
        exception_reason: r.exception_reason,
        exception_photo_url: r.exception_photo_url,
        tech_user_id: r.user_id,
        tech_name: r.tech_first_name
          ? `${r.tech_first_name ?? ""} ${r.tech_last_name ?? ""}`.trim()
          : null,
        client_display_name: resolveClientDisplayName(r),
      })),
    });
  } catch (err) {
    console.error("[ops] exceptions error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load queue" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ops/today/live-locations — Section 2 map pins (optional v1)
// ─────────────────────────────────────────────────────────────────────────────
//
// One pin per tech currently clocked in (open clock_in with no
// matching clock_out). Pin location is the site's lat/lng (clients.lat/lng).
// Cheap query, polled.

router.get("/today/live-locations", async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const rows = await db
      .select({
        job_id: jobsTable.id,
        tech_user_id: jobsTable.assigned_user_id,
        tech_first_name: usersTable.first_name,
        tech_last_name: usersTable.last_name,
        client_first_name: clientsTable.first_name,
        client_last_name: clientsTable.last_name,
        client_company_name: clientsTable.company_name,
        account_name: accountsTable.account_name,
        property_name: accountPropertiesTable.property_name,
        job_kind: jobsTable.job_kind,
        lat: clientsTable.lat,
        lng: clientsTable.lng,
      })
      .from(jobsTable)
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(
        accountPropertiesTable,
        eq(jobsTable.account_property_id, accountPropertiesTable.id),
      )
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.status, "in_progress"),
        ),
      );

    return res.json({
      data: rows
        .filter((r) => r.lat != null && r.lng != null)
        .map((r) => ({
          job_id: r.job_id,
          tech_user_id: r.tech_user_id,
          tech_name: r.tech_first_name
            ? `${r.tech_first_name ?? ""} ${r.tech_last_name ?? ""}`.trim()
            : null,
          tech_initials: techInitials(r.tech_first_name, r.tech_last_name),
          client_display_name: resolveClientDisplayName(r),
          lat: Number(r.lat),
          lng: Number(r.lng),
        })),
    });
  } catch (err) {
    console.error("[ops] live-locations error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load locations" });
  }
});

function techInitials(first: string | null, last: string | null): string {
  const f = first?.trim()?.[0] ?? "";
  const l = last?.trim()?.[0] ?? "";
  return `${f}${l}`.toUpperCase() || "?";
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ops/jobs/:jobId/detail — drawer payload
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns worksheet + photos + technician notes + the full clock
// timeline (every job_clock_events row including corrections, in
// chronological order). The clock timeline is the centerpiece — the
// office reads it to verify the audit trail.

router.get("/jobs/:jobId/detail", async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId)) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid jobId" });
    }

    // Tenant gate on the job.
    const jobRows = await db
      .select({
        id: jobsTable.id,
        assigned_user_id: jobsTable.assigned_user_id,
        client_id: jobsTable.client_id,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        scheduled_time: jobsTable.scheduled_time,
        allowed_hours: jobsTable.allowed_hours,
        notes: jobsTable.notes,
        client_first_name: clientsTable.first_name,
        client_last_name: clientsTable.last_name,
        client_company_name: clientsTable.company_name,
        client_phone: clientsTable.phone,
        account_name: accountsTable.account_name,
        property_name: accountPropertiesTable.property_name,
        address_street: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.address} ELSE ${clientsTable.address} END`,
        address_city: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.city} ELSE ${clientsTable.city} END`,
        address_state: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.state} ELSE ${clientsTable.state} END`,
        address_zip: sql<string | null>`CASE WHEN ${jobsTable.account_property_id} IS NOT NULL THEN ${accountPropertiesTable.zip} ELSE ${clientsTable.zip} END`,
        tech_first_name: usersTable.first_name,
        tech_last_name: usersTable.last_name,
        job_kind: jobsTable.job_kind,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .leftJoin(accountsTable, eq(jobsTable.account_id, accountsTable.id))
      .leftJoin(
        accountPropertiesTable,
        eq(jobsTable.account_property_id, accountPropertiesTable.id),
      )
      .leftJoin(usersTable, eq(jobsTable.assigned_user_id, usersTable.id))
      .where(
        and(
          eq(jobsTable.company_id, companyId),
          eq(jobsTable.id, jobId),
        ),
      )
      .limit(1);
    const job = jobRows[0];
    if (!job) {
      return res.status(404).json({ error: "Not Found", message: "Job not found" });
    }

    const [worksheet, clockEvents, photos, notes] = await Promise.all([
      db
        .select()
        .from(jobWorksheetTable)
        .where(
          and(
            eq(jobWorksheetTable.company_id, companyId),
            eq(jobWorksheetTable.job_id, jobId),
          ),
        )
        .limit(1)
        .then((r) => r[0] ?? null),
      // EVERY clock event for this job, ordered chronologically.
      // Includes corrections (is_correction=true) so the timeline
      // shows the original AND the corrected event side by side.
      db
        .select({
          id: jobClockEventsTable.id,
          event_type: jobClockEventsTable.event_type,
          event_at: jobClockEventsTable.event_at,
          latitude: jobClockEventsTable.latitude,
          longitude: jobClockEventsTable.longitude,
          distance_from_site_meters: jobClockEventsTable.distance_from_site_meters,
          within_geofence: jobClockEventsTable.within_geofence,
          gps_status: jobClockEventsTable.gps_status,
          gps_accuracy_meters: jobClockEventsTable.gps_accuracy_meters,
          exception_reason: jobClockEventsTable.exception_reason,
          exception_photo_url: jobClockEventsTable.exception_photo_url,
          exception_reviewed_at: jobClockEventsTable.exception_reviewed_at,
          exception_reviewed_by_user_id: jobClockEventsTable.exception_reviewed_by_user_id,
          is_correction: jobClockEventsTable.is_correction,
          correction_of_event_id: jobClockEventsTable.correction_of_event_id,
          correction_old_value: jobClockEventsTable.correction_old_value,
          created_by_user_id: jobClockEventsTable.created_by_user_id,
          created_at: jobClockEventsTable.created_at,
        })
        .from(jobClockEventsTable)
        .where(
          and(
            eq(jobClockEventsTable.company_id, companyId),
            eq(jobClockEventsTable.job_id, jobId),
          ),
        )
        .orderBy(asc(jobClockEventsTable.event_at), asc(jobClockEventsTable.created_at)),
      db
        .select({
          id: jobPhotosTable.id,
          url: jobPhotosTable.url,
          photo_type: jobPhotosTable.photo_type,
          timestamp: jobPhotosTable.timestamp,
        })
        .from(jobPhotosTable)
        .where(
          and(
            eq(jobPhotosTable.company_id, companyId),
            eq(jobPhotosTable.job_id, jobId),
          ),
        )
        .orderBy(asc(jobPhotosTable.timestamp)),
      db
        .select({
          id: technicianNotesTable.id,
          body: technicianNotesTable.body,
          created_at: technicianNotesTable.created_at,
          user_id: technicianNotesTable.user_id,
        })
        .from(technicianNotesTable)
        .where(
          and(
            eq(technicianNotesTable.company_id, companyId),
            eq(technicianNotesTable.job_id, jobId),
          ),
        )
        .orderBy(asc(technicianNotesTable.created_at)),
    ]);

    return res.json({
      data: {
        job: {
          id: job.id,
          status: job.status,
          scheduled_date: job.scheduled_date,
          scheduled_time: job.scheduled_time,
          allowed_hours: job.allowed_hours != null ? Number(job.allowed_hours) : null,
          notes: job.notes,
          job_kind: job.job_kind,
          tech_name: job.tech_first_name
            ? `${job.tech_first_name ?? ""} ${job.tech_last_name ?? ""}`.trim()
            : null,
          client_display_name: resolveClientDisplayName(job),
          client_phone: job.client_phone,
          address_street: job.address_street,
          address_city: job.address_city,
          address_state: job.address_state,
          address_zip: job.address_zip,
        },
        worksheet,
        clock_timeline: clockEvents.map((e) => ({
          ...e,
          event_at: e.event_at?.toISOString() ?? null,
          created_at: e.created_at?.toISOString() ?? null,
          exception_reviewed_at: e.exception_reviewed_at?.toISOString() ?? null,
          latitude: e.latitude != null ? Number(e.latitude) : null,
          longitude: e.longitude != null ? Number(e.longitude) : null,
          distance_from_site_meters:
            e.distance_from_site_meters != null
              ? Number(e.distance_from_site_meters)
              : null,
          gps_accuracy_meters:
            e.gps_accuracy_meters != null ? Number(e.gps_accuracy_meters) : null,
        })),
        photos: photos.map((p) => ({
          ...p,
          timestamp: p.timestamp?.toISOString() ?? null,
        })),
        notes: notes.map((n) => ({
          ...n,
          created_at: n.created_at?.toISOString() ?? null,
        })),
      },
    });
  } catch (err) {
    console.error("[ops] detail error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load detail" });
  }
});

export default router;
