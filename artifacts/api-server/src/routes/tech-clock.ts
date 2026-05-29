/**
 * Cutover 1C — Tech execution engine routes.
 *
 * Routes mounted at /api/tech/jobs (alongside the 1B day view):
 *   POST   /:jobId/on-my-way        — one-tap; computes ETA; sends SMS
 *                                      gated by COMMS_ENABLED + tenant
 *                                      + client opt-in; records leg
 *                                      for the mileage piece (2A)
 *   POST   /:jobId/clock-in         — GPS MANDATORY; no skip path
 *   POST   /:jobId/clock-out        — same GPS rules; closes the shift
 *   GET    /:jobId/worksheet        — read-only worksheet payload
 *                                      (seeded from job + client on
 *                                      first read)
 *   POST   /:jobId/photos           — append a photo to the job
 *   POST   /:jobId/notes            — append a technician note
 *
 * Every route is tenant-scoped via req.auth!.companyId AND assigned-
 * to-this-tech-scoped via assigned_user_id = req.auth!.userId. There is
 * no admin override on this surface. The office-side correction +
 * exception-review routes live in routes/office-clock.ts.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  jobsTable,
  clientsTable,
  usersTable,
  companiesTable,
  jobClockEventsTable,
  jobWorksheetTable,
  jobPhotosTable,
  technicianNotesTable,
  onMyWayEventsTable,
} from "@workspace/db/schema";
import { and, eq, desc, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { validateClockGpsPayload } from "../lib/clock-integrity.js";
import { haversineMeters, companyGeofenceMeters } from "../lib/distance.js";
import { estimateEtaMinutes } from "../lib/eta.js";
import { sendOnMyWaySms } from "../lib/comms.js";
import { geocodeAddress } from "../lib/geocode.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Job ownership helper — every tech route routes through this so the
// "this is your job and your tenant" check is one line, not five.
// ─────────────────────────────────────────────────────────────────────────────

async function loadOwnedJob(
  companyId: number,
  userId: number,
  jobId: number,
): Promise<{
  id: number;
  company_id: number;
  assigned_user_id: number | null;
  client_id: number | null;
  scheduled_date: string;
  scheduled_time: string | null;
  status: string;
} | null> {
  const rows = await db
    .select({
      id: jobsTable.id,
      company_id: jobsTable.company_id,
      assigned_user_id: jobsTable.assigned_user_id,
      client_id: jobsTable.client_id,
      scheduled_date: jobsTable.scheduled_date,
      scheduled_time: jobsTable.scheduled_time,
      status: jobsTable.status,
    })
    .from(jobsTable)
    .where(
      and(eq(jobsTable.company_id, companyId), eq(jobsTable.id, jobId)),
    )
    .limit(1);
  const job = rows[0];
  if (!job) return null;
  if (job.assigned_user_id !== userId) return null;
  return job;
}

// Lazy geocode the client/job site coords. Cached on the clients row
// once resolved. NEVER blocks the clock event — returns null on miss.
async function ensureSiteCoords(
  companyId: number,
  clientId: number | null,
): Promise<{ lat: number; lng: number } | null> {
  if (!clientId) return null;
  const rows = await db
    .select({
      id: clientsTable.id,
      lat: clientsTable.lat,
      lng: clientsTable.lng,
      address: clientsTable.address,
      city: clientsTable.city,
      state: clientsTable.state,
      zip: clientsTable.zip,
    })
    .from(clientsTable)
    .where(
      and(eq(clientsTable.company_id, companyId), eq(clientsTable.id, clientId)),
    )
    .limit(1);
  const c = rows[0];
  if (!c) return null;
  const lat = c.lat ? Number(c.lat) : null;
  const lng = c.lng ? Number(c.lng) : null;
  if (lat != null && lng != null) return { lat, lng };
  // Try to geocode. Compose the full address string; bail if we have
  // nothing to work with.
  const parts = [c.address, c.city, c.state, c.zip].filter(Boolean);
  if (parts.length === 0) return null;
  const result = await geocodeAddress(parts.join(", "));
  if (!result) return null;
  // Cache on the client row so the next event is instant.
  await db
    .update(clientsTable)
    .set({ lat: String(result.lat), lng: String(result.lng) })
    .where(
      and(eq(clientsTable.company_id, companyId), eq(clientsTable.id, clientId)),
    );
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /:jobId/on-my-way — one-tap, ETA pre-solved, SMS gated, leg captured
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:jobId/on-my-way", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const userId = req.auth!.userId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId)) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid jobId" });
    }
    const job = await loadOwnedJob(companyId, userId, jobId);
    if (!job) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Job not found or not assigned to you" });
    }

    // Optional inputs from the client (tech's current location, ETA
    // adjustment, deferred flag, from_job_id). All optional. Defaults
    // keep the one-tap happy path frictionless.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fromLatRaw = body.from_latitude;
    const fromLngRaw = body.from_longitude;
    const fromLat =
      typeof fromLatRaw === "number" && Number.isFinite(fromLatRaw) ? fromLatRaw : null;
    const fromLng =
      typeof fromLngRaw === "number" && Number.isFinite(fromLngRaw) ? fromLngRaw : null;
    const fromJobId =
      typeof body.from_job_id === "number" && Number.isFinite(body.from_job_id)
        ? (body.from_job_id as number)
        : null;
    const techAdjustedEtaMinutesRaw = body.adjusted_eta_minutes;
    const techAdjustedEtaMinutes =
      typeof techAdjustedEtaMinutesRaw === "number" &&
      Number.isFinite(techAdjustedEtaMinutesRaw)
        ? Math.max(1, Math.round(techAdjustedEtaMinutesRaw))
        : null;
    const deferred = body.deferred === true;

    // Compute ETA. Try Distance Matrix → haversine fallback. If we
    // can't get a site coord at all (geocode fails AND tech sent no
    // from-coords) we skip the ETA estimate; the SMS still goes with
    // "shortly."
    const siteCoords = await ensureSiteCoords(companyId, job.client_id);
    let estimatedEtaMinutes: number | null = null;
    if (fromLat != null && fromLng != null && siteCoords) {
      estimatedEtaMinutes = await estimateEtaMinutes(
        fromLat,
        fromLng,
        siteCoords.lat,
        siteCoords.lng,
      );
    }
    const effectiveEta = techAdjustedEtaMinutes ?? estimatedEtaMinutes;
    const now = new Date();
    const promisedArrivalAt =
      effectiveEta != null
        ? new Date(now.getTime() + effectiveEta * 60_000)
        : null;

    // Late signal: tech-edited ETA puts the promised arrival AFTER the
    // scheduled start.
    let etaEditedAfterScheduledStart = false;
    if (techAdjustedEtaMinutes != null && promisedArrivalAt && job.scheduled_time) {
      const scheduledStart = parseScheduledStart(
        job.scheduled_date,
        job.scheduled_time,
      );
      if (scheduledStart && promisedArrivalAt.getTime() > scheduledStart.getTime()) {
        etaEditedAfterScheduledStart = true;
      }
    }

    // SMS send (only when not deferred).
    let smsResult: Awaited<ReturnType<typeof sendOnMyWaySms>> | null = null;
    if (!deferred) {
      smsResult = await sendOnMyWayForJob(companyId, userId, job, promisedArrivalAt);
    }
    const clientNotified = smsResult?.status === "sent";

    const inserted = await db
      .insert(onMyWayEventsTable)
      .values({
        company_id: companyId,
        job_id: job.id,
        user_id: userId,
        from_job_id: fromJobId,
        from_latitude: fromLat != null ? String(fromLat) : null,
        from_longitude: fromLng != null ? String(fromLng) : null,
        estimated_eta_minutes: estimatedEtaMinutes,
        promised_arrival_at: promisedArrivalAt,
        eta_adjusted_by_tech: techAdjustedEtaMinutes != null,
        eta_edited_after_scheduled_start: etaEditedAfterScheduledStart,
        sent_at: deferred ? null : now,
        client_notified: clientNotified,
        deferred,
      })
      .returning({ id: onMyWayEventsTable.id });

    return res.json({
      data: {
        id: inserted[0]!.id,
        estimated_eta_minutes: estimatedEtaMinutes,
        promised_arrival_at: promisedArrivalAt?.toISOString() ?? null,
        eta_adjusted_by_tech: techAdjustedEtaMinutes != null,
        eta_edited_after_scheduled_start: etaEditedAfterScheduledStart,
        client_notified: clientNotified,
        deferred,
        sms_result: smsResult?.status ?? null,
      },
    });
  } catch (err) {
    console.error("[tech-clock] on-my-way error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to record on-my-way" });
  }
});

async function sendOnMyWayForJob(
  companyId: number,
  userId: number,
  job: { id: number; client_id: number | null },
  promisedArrivalAt: Date | null,
) {
  // Load tenant SMS flag, tenant from-number, client phone + opt-in,
  // tech first/last. Everything we need to compose the SMS.
  const [tenantRows, clientRows, techRows] = await Promise.all([
    db
      .select({
        sms_on_my_way_enabled: companiesTable.sms_on_my_way_enabled,
        twilio_from_number: companiesTable.twilio_from_number,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1),
    job.client_id != null
      ? db
          .select({
            first_name: clientsTable.first_name,
            phone: clientsTable.phone,
            address: clientsTable.address,
            city: clientsTable.city,
            state: clientsTable.state,
            zip: clientsTable.zip,
            wants_on_my_way_notifications: clientsTable.wants_on_my_way_notifications,
          })
          .from(clientsTable)
          .where(
            and(
              eq(clientsTable.company_id, companyId),
              eq(clientsTable.id, job.client_id),
            ),
          )
          .limit(1)
      : Promise.resolve([] as Array<{
          first_name: string | null;
          phone: string | null;
          address: string | null;
          city: string | null;
          state: string | null;
          zip: string | null;
          wants_on_my_way_notifications: boolean | null;
        }>),
    db
      .select({
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1),
  ]);
  const tenant = tenantRows[0];
  const client = clientRows[0];
  const tech = techRows[0];
  const serviceAddress = [
    client?.address,
    client?.city,
    client?.state,
    client?.zip,
  ]
    .filter(Boolean)
    .join(", ");
  const promisedLabel = promisedArrivalAt
    ? promisedArrivalAt.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : "shortly";
  return sendOnMyWaySms({
    toPhone: client?.phone ?? null,
    fromPhone: tenant?.twilio_from_number ?? null,
    techName: `${tech?.first_name ?? ""} ${tech?.last_name ?? ""}`.trim(),
    clientFirstName: client?.first_name ?? "",
    serviceAddress,
    promisedArrivalLabel: promisedLabel,
    tenantSmsEnabled: !!tenant?.sms_on_my_way_enabled,
    clientOptedIn: client?.wants_on_my_way_notifications !== false,
  });
}

function parseScheduledStart(dateStr: string, time: string): Date | null {
  // scheduled_time is text on jobs — could be "09:00", "9:00 AM", or
  // "HH:MM:SS". Best-effort parse.
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
// POST /:jobId/clock-in — GPS MANDATORY, no decline path
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:jobId/clock-in", requireAuth, async (req, res) => {
  return handleClockEvent(req, res, "clock_in");
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:jobId/clock-out — same GPS rules as clock-in
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:jobId/clock-out", requireAuth, async (req, res) => {
  return handleClockEvent(req, res, "clock_out");
});

async function handleClockEvent(
  req: any,
  res: any,
  eventType: "clock_in" | "clock_out",
) {
  try {
    const companyId = req.auth!.companyId;
    const userId = req.auth!.userId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId)) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid jobId" });
    }
    const job = await loadOwnedJob(companyId, userId, jobId);
    if (!job) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Job not found or not assigned to you" });
    }

    // Route-layer half of the integrity guarantee. The DB CHECK is the
    // other half. Together they reject any shape that lacks either a
    // captured GPS fix or a flagged exception with reason + photo.
    const parsed = validateClockGpsPayload(req.body);
    if (!parsed.ok) {
      return res.status(parsed.status).json({
        error: parsed.error,
        message: parsed.message,
        code: parsed.code,
      });
    }

    // Compute distance + within_geofence on the captured path.
    let distanceMeters: number | null = null;
    let withinGeofence: boolean | null = null;
    if (parsed.payload.kind === "captured") {
      const siteCoords = await ensureSiteCoords(companyId, job.client_id);
      if (siteCoords) {
        distanceMeters = haversineMeters(
          parsed.payload.latitude,
          parsed.payload.longitude,
          siteCoords.lat,
          siteCoords.lng,
        );
        const tenantRows = await db
          .select({
            geofence_clockin_radius_ft: companiesTable.geofence_clockin_radius_ft,
          })
          .from(companiesTable)
          .where(eq(companiesTable.id, companyId))
          .limit(1);
        const radiusMeters = companyGeofenceMeters(
          tenantRows[0]?.geofence_clockin_radius_ft ?? null,
        );
        withinGeofence = distanceMeters <= radiusMeters;
      }
      // siteCoords missing → withinGeofence stays null + distance stays
      // null. The event still gets the GPS fix (spec: geocode failure
      // must not block the clock event). Office review queue can see
      // this case by filtering on within_geofence IS NULL.
    }

    const eventAt = new Date();

    // Insert event. The DB CHECK constraint enforces the same rule we
    // already validated at the route layer.
    const inserted = await db
      .insert(jobClockEventsTable)
      .values(
        parsed.payload.kind === "captured"
          ? {
              company_id: companyId,
              job_id: job.id,
              user_id: userId,
              event_type: eventType,
              event_at: eventAt,
              latitude: String(parsed.payload.latitude),
              longitude: String(parsed.payload.longitude),
              gps_accuracy_meters: String(parsed.payload.gps_accuracy_meters),
              distance_from_site_meters:
                distanceMeters != null ? String(distanceMeters.toFixed(1)) : null,
              within_geofence: withinGeofence,
              gps_status: "captured" as const,
              created_by_user_id: userId,
            }
          : {
              company_id: companyId,
              job_id: job.id,
              user_id: userId,
              event_type: eventType,
              event_at: eventAt,
              gps_status: "failed_exception" as const,
              exception_reason: parsed.payload.exception_reason,
              exception_photo_url: parsed.payload.exception_photo_url,
              created_by_user_id: userId,
            },
      )
      .returning({ id: jobClockEventsTable.id });

    // Mirror job status. clock_in → in_progress, clock_out → complete.
    // Status transitions live on jobs.status which the dispatch UI reads.
    if (eventType === "clock_in" && job.status !== "in_progress") {
      await db
        .update(jobsTable)
        .set({ status: "in_progress" })
        .where(
          and(eq(jobsTable.company_id, companyId), eq(jobsTable.id, job.id)),
        );
    } else if (eventType === "clock_out" && job.status !== "complete") {
      await db
        .update(jobsTable)
        .set({ status: "complete" })
        .where(
          and(eq(jobsTable.company_id, companyId), eq(jobsTable.id, job.id)),
        );
    }

    return res.json({
      data: {
        id: inserted[0]!.id,
        event_type: eventType,
        event_at: eventAt.toISOString(),
        gps_status: parsed.payload.kind === "captured" ? "captured" : "failed_exception",
        distance_from_site_meters: distanceMeters,
        within_geofence: withinGeofence,
      },
    });
  } catch (err) {
    console.error(`[tech-clock] ${eventType} error:`, err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to record clock event" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /:jobId/worksheet — read worksheet; seed defaults on first read
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:jobId/worksheet", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const userId = req.auth!.userId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId)) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid jobId" });
    }
    const job = await loadOwnedJob(companyId, userId, jobId);
    if (!job) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Job not found or not assigned to you" });
    }

    const existing = await db
      .select()
      .from(jobWorksheetTable)
      .where(
        and(
          eq(jobWorksheetTable.company_id, companyId),
          eq(jobWorksheetTable.job_id, job.id),
        ),
      )
      .limit(1);
    if (existing[0]) return res.json({ data: existing[0] });

    // Seed defaults from jobs + clients. One-time on first GET.
    const jobFull = await db
      .select({
        scope_deep_clean: jobsTable.scope_deep_clean,
        scope_first_time_in: jobsTable.scope_first_time_in,
        scope_priority: jobsTable.scope_priority,
        special_equipment_needed: jobsTable.special_equipment_needed,
        service_type: jobsTable.service_type,
        notes: jobsTable.notes,
      })
      .from(jobsTable)
      .where(
        and(eq(jobsTable.company_id, companyId), eq(jobsTable.id, job.id)),
      )
      .limit(1);
    const j = jobFull[0]!;
    const seeded = await db
      .insert(jobWorksheetTable)
      .values({
        company_id: companyId,
        job_id: job.id,
        service_set_name: j.service_type ?? null,
        scope_deep_clean: j.scope_deep_clean ?? false,
        scope_first_time_in: j.scope_first_time_in ?? false,
        scope_priority: j.scope_priority ?? false,
        special_equipment_needed: j.special_equipment_needed ?? false,
        directions_text: j.notes ?? null,
      })
      .returning();
    return res.json({ data: seeded[0] });
  } catch (err) {
    console.error("[tech-clock] worksheet error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load worksheet" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:jobId/photos — append a photo (URL-based; uploader provides URL)
// ─────────────────────────────────────────────────────────────────────────────
//
// The existing /api/photos service handles the actual upload + R2
// storage. This route is just the "associate the URL with the job"
// step. Body: { photo_url, photo_type?: "before"|"after", caption? }.

router.post("/:jobId/photos", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const userId = req.auth!.userId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId)) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid jobId" });
    }
    const job = await loadOwnedJob(companyId, userId, jobId);
    if (!job) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Job not found or not assigned to you" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const photoUrl = typeof body.photo_url === "string" ? body.photo_url.trim() : "";
    if (!photoUrl) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "photo_url is required" });
    }
    const photoType = body.photo_type === "after" ? "after" : "before";
    const inserted = await db
      .insert(jobPhotosTable)
      .values({
        company_id: companyId,
        job_id: job.id,
        photo_type: photoType,
        url: photoUrl,
        uploaded_by: userId,
      })
      .returning({ id: jobPhotosTable.id });
    return res.json({ data: { id: inserted[0]!.id, photo_url: photoUrl, photo_type: photoType } });
  } catch (err) {
    console.error("[tech-clock] photos error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to attach photo" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:jobId/notes — append a technician note
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:jobId/notes", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const userId = req.auth!.userId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId)) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid jobId" });
    }
    const job = await loadOwnedJob(companyId, userId, jobId);
    if (!job) {
      return res
        .status(404)
        .json({ error: "Not Found", message: "Job not found or not assigned to you" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "body is required" });
    }
    const inserted = await db
      .insert(technicianNotesTable)
      .values({
        company_id: companyId,
        job_id: job.id,
        user_id: userId,
        body: text,
      })
      .returning({ id: technicianNotesTable.id, created_at: technicianNotesTable.created_at });
    return res.json({
      data: {
        id: inserted[0]!.id,
        body: text,
        created_at: inserted[0]!.created_at,
      },
    });
  } catch (err) {
    console.error("[tech-clock] notes error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to attach note" });
  }
});

export default router;
