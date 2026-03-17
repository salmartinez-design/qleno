import { Router } from "express";
import { db } from "@workspace/db";
import { timeclockTable, usersTable, jobsTable, clientsTable, companiesTable, jobPhotosTable, clockInAttemptsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, desc, sql, count } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

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

router.get("/", requireAuth, async (req, res) => {
  try {
    const { user_id, job_id, flagged, date_from, date_to } = req.query;

    const conditions: any[] = [eq(timeclockTable.company_id, req.auth!.companyId)];
    if (user_id) conditions.push(eq(timeclockTable.user_id, parseInt(user_id as string)));
    if (job_id) conditions.push(eq(timeclockTable.job_id, parseInt(job_id as string)));
    if (flagged !== undefined) conditions.push(eq(timeclockTable.flagged, flagged === "true"));
    if (date_from) conditions.push(gte(timeclockTable.clock_in_at, new Date(date_from as string)));
    if (date_to) conditions.push(lte(timeclockTable.clock_in_at, new Date(date_to as string)));

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

    const [entry] = await db
      .insert(timeclockTable)
      .values({
        job_id,
        user_id: req.auth!.userId,
        company_id: req.auth!.companyId,
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

export default router;
