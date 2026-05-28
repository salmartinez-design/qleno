/**
 * Cutover 1C — Office-side clock corrections + exception review.
 *
 * Mounted at /api/office. Three endpoints:
 *   POST /jobs/:jobId/clock-correction       — append-only correction event
 *   GET  /clock-exceptions                    — review queue (unreviewed)
 *   POST /clock-exceptions/:id/review         — mark exception reviewed
 *
 * Office-only: requireRole('owner', 'admin', 'office', 'super_admin').
 * Corrections NEVER overwrite or delete an original event. The
 * correction is a NEW row with is_correction=true, correction_of_event_id
 * pointing at the original, and correction_old_value carrying a JSON
 * snapshot of prior values. Surfaces that read clock history must show
 * both the original AND the correction (the office UI for this lands
 * in 1D / 1E; the data model is complete here).
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  jobClockEventsTable,
  jobsTable,
} from "@workspace/db/schema";
import { and, eq, isNull, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

const officeOnly = requireRole("owner", "admin", "office", "super_admin");

// ─────────────────────────────────────────────────────────────────────────────
// POST /jobs/:jobId/clock-correction
// ─────────────────────────────────────────────────────────────────────────────
//
// Body:
//   {
//     correction_of_event_id: number,        // original event being corrected
//     corrected_values: { event_at?, latitude?, longitude?, within_geofence? },
//     reason: string                          // free-text audit reason
//   }
//
// Writes a NEW jobClockEvents row with is_correction=true. Sets
// correction_old_value to a JSON snapshot of the original's mutable
// fields so the audit trail captures what changed.

router.post(
  "/jobs/:jobId/clock-correction",
  requireAuth,
  officeOnly,
  async (req, res) => {
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

      const body = (req.body ?? {}) as Record<string, unknown>;
      const correctionOfEventId = Number(body.correction_of_event_id);
      if (!Number.isFinite(correctionOfEventId)) {
        return res.status(400).json({
          error: "Bad Request",
          message: "correction_of_event_id is required",
        });
      }
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "reason is required" });
      }

      // Load the original. Must be in this tenant + this job.
      const originalRows = await db
        .select()
        .from(jobClockEventsTable)
        .where(
          and(
            eq(jobClockEventsTable.id, correctionOfEventId),
            eq(jobClockEventsTable.company_id, companyId),
            eq(jobClockEventsTable.job_id, jobId),
          ),
        )
        .limit(1);
      const original = originalRows[0];
      if (!original) {
        return res
          .status(404)
          .json({ error: "Not Found", message: "Original event not found in this tenant + job" });
      }

      // Build corrected payload. New row inherits original values
      // except for what's explicitly being corrected. The DB CHECK
      // constraint still applies — a correction cannot produce a
      // shape that lacks GPS or a flagged exception.
      const corrected = (body.corrected_values ?? {}) as Record<string, unknown>;
      const newEventAt =
        typeof corrected.event_at === "string"
          ? new Date(corrected.event_at)
          : original.event_at;
      const newLat =
        corrected.latitude !== undefined
          ? corrected.latitude == null
            ? null
            : String(corrected.latitude)
          : original.latitude;
      const newLng =
        corrected.longitude !== undefined
          ? corrected.longitude == null
            ? null
            : String(corrected.longitude)
          : original.longitude;
      const newWithinGeofence =
        corrected.within_geofence !== undefined
          ? (corrected.within_geofence as boolean | null)
          : original.within_geofence;

      const snapshot = {
        event_at: original.event_at,
        latitude: original.latitude,
        longitude: original.longitude,
        within_geofence: original.within_geofence,
        distance_from_site_meters: original.distance_from_site_meters,
        gps_status: original.gps_status,
        exception_reason: original.exception_reason,
        reason,
      };

      const inserted = await db
        .insert(jobClockEventsTable)
        .values({
          company_id: companyId,
          job_id: jobId,
          user_id: original.user_id,
          event_type: original.event_type,
          event_at: newEventAt,
          latitude: newLat,
          longitude: newLng,
          gps_accuracy_meters: original.gps_accuracy_meters,
          distance_from_site_meters: original.distance_from_site_meters,
          within_geofence: newWithinGeofence,
          gps_status: original.gps_status,
          exception_reason: original.exception_reason,
          exception_photo_url: original.exception_photo_url,
          is_correction: true,
          correction_of_event_id: original.id,
          correction_old_value: snapshot,
          created_by_user_id: userId,
        })
        .returning({ id: jobClockEventsTable.id });

      return res.json({
        data: {
          id: inserted[0]!.id,
          correction_of_event_id: original.id,
          reason,
        },
      });
    } catch (err) {
      console.error("[office-clock] correction error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to record correction" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /clock-exceptions — queue of failed_exception events awaiting review
// ─────────────────────────────────────────────────────────────────────────────

router.get("/clock-exceptions", requireAuth, officeOnly, async (req, res) => {
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
      })
      .from(jobClockEventsTable)
      .where(
        and(
          eq(jobClockEventsTable.company_id, companyId),
          eq(jobClockEventsTable.gps_status, "failed_exception"),
          isNull(jobClockEventsTable.exception_reviewed_at),
        ),
      )
      .orderBy(desc(jobClockEventsTable.event_at))
      .limit(200);
    return res.json({ data: rows });
  } catch (err) {
    console.error("[office-clock] exceptions queue error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load queue" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /clock-exceptions/:id/review — mark a failed_exception reviewed
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/clock-exceptions/:id/review",
  requireAuth,
  officeOnly,
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      const reviewerId = req.auth!.userId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Bad Request", message: "Invalid id" });
      }

      const result = await db
        .update(jobClockEventsTable)
        .set({
          exception_reviewed_by_user_id: reviewerId,
          exception_reviewed_at: new Date(),
        })
        .where(
          and(
            eq(jobClockEventsTable.id, id),
            eq(jobClockEventsTable.company_id, companyId),
            eq(jobClockEventsTable.gps_status, "failed_exception"),
          ),
        )
        .returning({ id: jobClockEventsTable.id });
      if (!result[0]) {
        return res
          .status(404)
          .json({ error: "Not Found", message: "Exception not found" });
      }
      return res.json({ data: { id: result[0].id, reviewed: true } });
    } catch (err) {
      console.error("[office-clock] review error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to review" });
    }
  },
);

export default router;
