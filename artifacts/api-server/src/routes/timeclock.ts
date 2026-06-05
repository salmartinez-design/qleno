import { Router } from "express";
import { db } from "@workspace/db";
import { timeclockTable, usersTable, jobsTable, clientsTable, companiesTable, jobPhotosTable, clockInAttemptsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, desc, sql, count } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";

const router = Router();

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

router.post("/clock-in", requireAuth, async (req, res) => {
  try {
    const { job_id, lat, lng, accuracy, override_token } = req.body;

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
      flagged = outsideGeofence && !softMode;
    }

    const isOverride = override_token === "approved";

    if (geofenceEnabled && outsideGeofence && !softMode && !isOverride) {
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

    const attemptResult = isOverride ? "override_approved" : outsideGeofence ? "soft_warned" : "success";

    // Model A: stamp branch_id at clock-in from the job's branch (default Oak
    // Lawn for the handful of legacy jobs whose branch_id is null). Reports
    // group hours-by-branch off this column so later dispatch corrections
    // don't shift historical payroll attribution.
    const stampedBranchId = jobRow.branch_id ?? 1;

    const [entry] = await db
      .insert(timeclockTable)
      .values({
        job_id,
        user_id: req.auth!.userId,
        company_id: req.auth!.companyId,
        branch_id: stampedBranchId,
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
      user_id: req.auth!.userId,
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
    try {
      const scheduledDate = jobRow.scheduled_date ? String(jobRow.scheduled_date).slice(0, 10) : null;
      if (scheduledDate) {
        const arrivalWindow = (jobRow as any).arrival_window || "morning";
        const startHour = arrivalWindow === "afternoon" ? 13 : 8;
        const scheduledStart = new Date(`${scheduledDate}T${String(startHour).padStart(2, '0')}:00:00-06:00`);
        const lateThreshold = new Date(scheduledStart.getTime() + 20 * 60 * 1000);
        if (new Date() > lateThreshold) {
          const techRow = await db.select({ first_name: usersTable.first_name, last_name: usersTable.last_name })
            .from(usersTable).where(eq(usersTable.id, req.auth!.userId)).limit(1);
          const techName = techRow[0] ? `${techRow[0].first_name} ${techRow[0].last_name}` : "A technician";
          const clientName = job[0].clients ? `${(job[0].clients as any).first_name} ${(job[0].clients as any).last_name}` : "a client";
          const notifTitle = `Late Clock-In — ${techName}`;
          const notifBody = `${techName} clocked in late for ${clientName}'s job (scheduled ${arrivalWindow}).`;
          await db.execute(
            sql`INSERT INTO notifications (company_id, type, title, body, link, meta)
              VALUES (${req.auth!.companyId}, 'late_clockin', ${notifTitle}, ${notifBody}, ${`/dispatch`}, ${JSON.stringify({ job_id, user_id: req.auth!.userId, tech_name: techName })}::jsonb)`
          );
        }
      }
    } catch (notifErr) {
      console.error("[late_clockin notify] failed:", notifErr);
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

    if (!jobData[0] || jobData[0].after_count === 0) {
      return res.status(400).json({ error: "PHOTOS_REQUIRED", message: "At least 1 after photo required before clock out" });
    }

    const company = await db
      .select({
        geofence_enabled: companiesTable.geofence_enabled,
        geofence_clockout_radius_ft: companiesTable.geofence_clockout_radius_ft,
        geofence_soft_mode: companiesTable.geofence_soft_mode,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, req.auth!.companyId))
      .limit(1);

    const cfg = company[0];
    const geofenceEnabled = cfg?.geofence_enabled ?? true;
    const clockOutRadius = cfg?.geofence_clockout_radius_ft ?? 1000;
    const softMode = cfg?.geofence_soft_mode ?? false;

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
        clock_out_at: new Date(),
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
router.post("/office/clock-in", requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const job_id = parseInt(String(req.body?.job_id));
    const user_id = parseInt(String(req.body?.user_id));
    if (!job_id || !user_id) return res.status(400).json({ error: "job_id and user_id are required" });
    const clockInAt = req.body?.clock_in_at ? new Date(req.body.clock_in_at) : new Date();
    if (isNaN(clockInAt.getTime())) return res.status(400).json({ error: "Invalid clock_in_at" });

    const [jobRow] = await db.select({ id: jobsTable.id, branch_id: jobsTable.branch_id })
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

    const [entry] = await db.insert(timeclockTable).values({
      job_id, user_id, company_id: companyId,
      branch_id: jobRow.branch_id ?? 1,
      clock_in_at: clockInAt,
      override_approved: true,
      source: "punched",
    }).returning();
    return res.json(entry);
  } catch (err) {
    console.error("POST /timeclock/office/clock-in error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/office/clock-out", requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const job_id = parseInt(String(req.body?.job_id));
    const user_id = parseInt(String(req.body?.user_id));
    if (!job_id || !user_id) return res.status(400).json({ error: "job_id and user_id are required" });
    const clockOutAt = req.body?.clock_out_at ? new Date(req.body.clock_out_at) : new Date();
    if (isNaN(clockOutAt.getTime())) return res.status(400).json({ error: "Invalid clock_out_at" });

    const [open] = await db.select().from(timeclockTable).where(and(
      eq(timeclockTable.company_id, companyId), eq(timeclockTable.job_id, job_id),
      eq(timeclockTable.user_id, user_id), sql`${timeclockTable.clock_out_at} IS NULL`
    )).orderBy(desc(timeclockTable.clock_in_at)).limit(1);
    if (!open) return res.status(400).json({ error: "No open clock-in for this employee on this job" });
    if (clockOutAt.getTime() < new Date(open.clock_in_at).getTime())
      return res.status(400).json({ error: "Clock-out cannot be before clock-in" });

    const [updated] = await db.update(timeclockTable)
      .set({ clock_out_at: clockOutAt })
      .where(eq(timeclockTable.id, open.id)).returning();
    await recomputeJobActualHours(job_id, companyId);
    return res.json(updated);
  } catch (err) {
    console.error("POST /timeclock/office/clock-out error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [paytype-parity 2026-06-05] Per-tech pay-type override. The office sets a
// timesheet's pay type (fee_split | allowed_hours | hourly) + rate/% and an
// optional breakage deduction; the parity engine (lib/commission-paytype.ts)
// reads these off job_technicians. NULL = inherit the job's smart default
// (commercial → allowed_hours; residential → fee_split). Upserts the
// job_technicians row; only edits an existing assignment or the primary tech.
router.put("/office/job/:jobId/tech/:userId/pay", requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const jobId = parseInt(req.params.jobId);
    const userId = parseInt(req.params.userId);
    if (!jobId || !userId) return res.status(400).json({ error: "jobId and userId are required" });

    const payType = req.body?.pay_type ?? null;
    if (payType !== null && !["fee_split", "allowed_hours", "hourly"].includes(payType))
      return res.status(400).json({ error: "pay_type must be fee_split, allowed_hours, hourly, or null" });

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
router.get("/day", requireRole("owner", "admin", "office"), async (req, res) => {
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
             COALESCE(NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''),
                      c.company_name, 'Client') AS client_name
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.company_id = ${companyId}
        AND j.scheduled_date::date = ${date}::date
        AND j.status IS DISTINCT FROM 'cancelled'
      ORDER BY j.scheduled_time NULLS LAST, j.id
    `);
    const jobs = jobsRes.rows as any[];
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
                 TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name
          FROM job_technicians jt JOIN users u ON u.id = jt.user_id
          WHERE jt.job_id IN (${inList})
        `)).rows as any[];
      } catch {
        techRows = (await db.execute(sql`
          SELECT jt.job_id, jt.user_id, jt.is_primary,
                 NULL::text AS pay_type, NULL::numeric AS hourly_rate, NULL::numeric AS commission_pct,
                 NULL::numeric AS pay_deduction_pct, NULL::numeric AS pay_deduction_flat,
                 TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name
          FROM job_technicians jt JOIN users u ON u.id = jt.user_id
          WHERE jt.job_id IN (${inList})
        `)).rows as any[];
      }
    }
    const payByJobUser = new Map<string, any>();
    for (const t of techRows) payByJobUser.set(`${Number(t.job_id)}:${Number(t.user_id)}`, t);

    const clockRows = inList ? ((await db.execute(sql`
      SELECT t.id, t.job_id, t.user_id, t.clock_in_at, t.clock_out_at, t.flagged,
             TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name
      FROM timeclock t JOIN users u ON u.id = t.user_id
      WHERE t.company_id = ${companyId} AND t.job_id IN (${inList})
    `)).rows as any[]) : [];

    const jobById = new Map<number, any>(jobs.map(j => [Number(j.job_id), j]));
    const techsByJob = new Map<number, { user_id: number; name: string; is_primary: boolean }[]>();
    for (const t of techRows) {
      const arr = techsByJob.get(Number(t.job_id)) || [];
      arr.push({ user_id: Number(t.user_id), name: t.name || "Tech", is_primary: !!t.is_primary });
      techsByJob.set(Number(t.job_id), arr);
    }
    const entryByJobUser = new Map<string, any>();
    for (const e of clockRows) entryByJobUser.set(`${e.job_id}:${e.user_id}`, e);
    const nameByUser = new Map<number, string>();
    for (const t of techRows) if (t.name) nameByUser.set(Number(t.user_id), t.name);
    for (const e of clockRows) if (e.name) nameByUser.set(Number(e.user_id), e.name);

    type Row = { job_id: number; client_name: string; service_type: string; scheduled_time: string | null;
                 entry_id: number | null; clock_in_at: string | null; clock_out_at: string | null;
                 flagged: boolean; minutes: number | null;
                 pay_type: string | null; hourly_rate: string | null; commission_pct: string | null;
                 pay_deduction_pct: string | null; pay_deduction_flat: string | null };
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
    const emp = new Map<number, { user_id: number; name: string; rows: Row[] }>();
    const ensureEmp = (uid: number) => {
      if (!emp.has(uid)) emp.set(uid, { user_id: uid, name: nameByUser.get(uid) || "Tech", rows: [] });
      return emp.get(uid)!;
    };
    const minutesOf = (a: string | null, b: string | null) =>
      a && b ? Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000)) : null;

    const seen = new Set<string>();
    for (const j of jobs) {
      const jid = Number(j.job_id);
      let techs = techsByJob.get(jid) || [];
      if (techs.length === 0 && j.assigned_user_id != null) techs = [{ user_id: Number(j.assigned_user_id), name: nameByUser.get(Number(j.assigned_user_id)) || "Tech", is_primary: true }];
      for (const t of techs) {
        const key = `${jid}:${t.user_id}`;
        seen.add(key);
        const e = entryByJobUser.get(key) || null;
        ensureEmp(t.user_id).rows.push({
          job_id: jid, client_name: j.client_name, service_type: j.service_type, scheduled_time: j.scheduled_time ?? null,
          entry_id: e ? Number(e.id) : null, clock_in_at: e?.clock_in_at ?? null, clock_out_at: e?.clock_out_at ?? null,
          flagged: !!e?.flagged, minutes: e ? minutesOf(e.clock_in_at, e.clock_out_at) : null,
          ...payOf(jid, t.user_id),
        });
      }
    }
    for (const e of clockRows) {
      const key = `${e.job_id}:${e.user_id}`;
      if (seen.has(key)) continue;
      const j = jobById.get(Number(e.job_id));
      ensureEmp(Number(e.user_id)).rows.push({
        job_id: Number(e.job_id), client_name: j?.client_name ?? "Client", service_type: j?.service_type ?? "",
        scheduled_time: j?.scheduled_time ?? null, entry_id: Number(e.id), clock_in_at: e.clock_in_at ?? null,
        clock_out_at: e.clock_out_at ?? null, flagged: !!e.flagged, minutes: minutesOf(e.clock_in_at, e.clock_out_at),
        ...payOf(Number(e.job_id), Number(e.user_id)),
      });
    }

    const employees = [...emp.values()].map(ev => {
      const worked = ev.rows.reduce((s, r) => s + (r.minutes ?? 0), 0);
      const ins = ev.rows.map(r => r.clock_in_at).filter(Boolean) as string[];
      const outs = ev.rows.map(r => r.clock_out_at).filter(Boolean) as string[];
      return {
        ...ev,
        rows: ev.rows.sort((a, b) => String(a.scheduled_time || "~").localeCompare(String(b.scheduled_time || "~"))),
        worked_minutes: worked,
        day_start: ins.length ? ins.reduce((a, b) => (a < b ? a : b)) : null,
        day_end: outs.length ? outs.reduce((a, b) => (a > b ? a : b)) : null,
        open: ev.rows.some(r => r.clock_in_at && !r.clock_out_at),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ date, employees, diagnostics: { jobCount: jobs.length, techRows: techRows.length, clockRows: clockRows.length } });
  } catch (err: any) {
    // Surface the failure to the UI instead of a silent 500 → empty screen.
    // The Time Clock empty-state renders this so we can diagnose without
    // DevTools. 200 keeps the front-end from swallowing it.
    console.error("GET /timeclock/day error:", err);
    return res.status(200).json({ date: String(req.query.date || "").slice(0, 10), employees: [], diagnostics: { error: String(err?.message || err) } });
  }
});

router.patch("/:id", requireRole("owner", "admin", "office"), async (req, res) => {
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

    const [updated] = await db.update(timeclockTable).set(set).where(eq(timeclockTable.id, id)).returning();
    await recomputeJobActualHours(existing.job_id, companyId);
    logAudit(req, "TIMECLOCK_EDIT", "timeclock", id,
      { clock_in_at: existing.clock_in_at, clock_out_at: existing.clock_out_at },
      { clock_in_at: updated.clock_in_at, clock_out_at: updated.clock_out_at });
    return res.json(updated);
  } catch (err) {
    console.error("PATCH /timeclock/:id error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id", requireRole("owner", "admin", "office"), async (req, res) => {
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
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /timeclock/:id error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
