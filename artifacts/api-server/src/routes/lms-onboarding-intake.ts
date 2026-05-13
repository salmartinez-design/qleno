/**
 * LMS Onboarding Intake — routes (Phase 10, PR #11 of 16).
 *
 * Endpoints (mounted at /api/lms/onboarding-intake):
 *   GET  /me                          caller's intake (or null if not started)
 *   POST /save                        caller upserts their own intake
 *   GET  /admin/learner/:userId       admin: any user's intake in tenant
 *                                       (owner / admin / office)
 *   GET  /admin/export                admin: tenant-wide CSV download
 *                                       (owner / admin / office). Each
 *                                       export is audit-logged.
 *
 * Multi-tenant: every query is `company_id`-scoped. Cross-tenant access
 * returns 404. The unique index on (company_id, user_id) enforces one
 * row per user per tenant.
 *
 * What this intake DOES NOT collect: SSN, W-4, IL-W-4, I-9 documents,
 * direct deposit. Those live with ADP. Storing them here would create
 * duplicative PII risk.
 */
import { Router } from "express";
import { and, eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsOnboardingIntakeTable,
  usersTable,
  type LmsOnboardingIntake,
} from "@workspace/db/schema";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import {
  boolOr,
  csvCell,
  dateOrNull,
  isIntakeSubmittable,
  trimOrNull,
} from "../lib/lms-onboarding-intake-helpers.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /me — caller's intake (or null)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/me", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;
    const rows = await db
      .select()
      .from(lmsOnboardingIntakeTable)
      .where(
        and(
          eq(lmsOnboardingIntakeTable.company_id, companyId),
          eq(lmsOnboardingIntakeTable.user_id, userId),
        ),
      )
      .limit(1);
    return res.json({ data: rows[0] ?? null });
  } catch (err) {
    console.error("[lms-onboarding-intake] GET /me error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to load intake" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /save — caller upserts their own intake
// ─────────────────────────────────────────────────────────────────────────────

router.post("/save", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    if (companyId == null) {
      return res
        .status(400)
        .json({ error: "Bad Request", message: "User has no company assignment" });
    }
    const userId = req.auth!.userId;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const drivesPersonalVehicle = boolOr(body.drives_personal_vehicle, false);
    const fields = {
      preferred_name: trimOrNull(body.preferred_name),
      pronouns: trimOrNull(body.pronouns),
      personal_email: trimOrNull(body.personal_email),
      personal_cell_phone: trimOrNull(body.personal_cell_phone),
      emergency_contact_name: trimOrNull(body.emergency_contact_name),
      emergency_contact_relationship: trimOrNull(
        body.emergency_contact_relationship,
      ),
      emergency_contact_phone: trimOrNull(body.emergency_contact_phone),
      languages_spoken: trimOrNull(body.languages_spoken),
      shirt_size: trimOrNull(body.shirt_size),
      apron_size: trimOrNull(body.apron_size),
      drives_personal_vehicle: drivesPersonalVehicle,
      vehicle_insurance_company: drivesPersonalVehicle
        ? trimOrNull(body.vehicle_insurance_company)
        : null,
      vehicle_insurance_policy_number: drivesPersonalVehicle
        ? trimOrNull(body.vehicle_insurance_policy_number)
        : null,
      vehicle_insurance_expires_at: drivesPersonalVehicle
        ? dateOrNull(body.vehicle_insurance_expires_at)
        : null,
      vehicle_license_plate: drivesPersonalVehicle
        ? trimOrNull(body.vehicle_license_plate)
        : null,
      drivers_license_state: drivesPersonalVehicle
        ? trimOrNull(body.drivers_license_state)
        : null,
      drivers_license_expires_at: drivesPersonalVehicle
        ? dateOrNull(body.drivers_license_expires_at)
        : null,
      notes: trimOrNull(body.notes),
    };

    const existing = await db
      .select()
      .from(lmsOnboardingIntakeTable)
      .where(
        and(
          eq(lmsOnboardingIntakeTable.company_id, companyId),
          eq(lmsOnboardingIntakeTable.user_id, userId),
        ),
      )
      .limit(1);

    const now = new Date();
    const submittableNow = isIntakeSubmittable(fields);
    const previousSubmittedAt = existing[0]?.submitted_at ?? null;
    const submittedAt =
      previousSubmittedAt ?? (submittableNow ? now : null);

    let row: LmsOnboardingIntake;
    if (existing[0]) {
      const updated = await db
        .update(lmsOnboardingIntakeTable)
        .set({
          ...fields,
          submitted_at: submittedAt,
          updated_at: now,
        })
        .where(
          and(
            eq(lmsOnboardingIntakeTable.company_id, companyId),
            eq(lmsOnboardingIntakeTable.user_id, userId),
          ),
        )
        .returning();
      row = updated[0]!;
    } else {
      const inserted = await db
        .insert(lmsOnboardingIntakeTable)
        .values({
          company_id: companyId,
          user_id: userId,
          ...fields,
          submitted_at: submittedAt,
          created_at: now,
          updated_at: now,
        })
        .returning();
      row = inserted[0]!;
    }

    await logAudit(
      req,
      previousSubmittedAt == null && submittedAt != null
        ? "lms.onboarding_intake.submitted"
        : "lms.onboarding_intake.saved",
      "lms_onboarding_intake",
      row.id,
      null,
      {
        company_id: companyId,
        user_id: userId,
        drives_personal_vehicle: drivesPersonalVehicle,
        submittable: submittableNow,
      },
    );

    return res.json({ data: row });
  } catch (err) {
    console.error("[lms-onboarding-intake] POST /save error:", err);
    return res
      .status(500)
      .json({ error: "Internal Server Error", message: "Failed to save intake" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/learner/:userId — admin: a learner's intake
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/admin/learner/:userId",
  requireAuth,
  requireRole("owner", "admin", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const targetUserId = Number(req.params.userId);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid userId" });
      }
      const rows = await db
        .select()
        .from(lmsOnboardingIntakeTable)
        .where(
          and(
            eq(lmsOnboardingIntakeTable.company_id, companyId),
            eq(lmsOnboardingIntakeTable.user_id, targetUserId),
          ),
        )
        .limit(1);
      return res.json({ data: rows[0] ?? null });
    } catch (err) {
      console.error("[lms-onboarding-intake] GET /admin/learner error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to load intake" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/export — tenant-wide CSV
// ─────────────────────────────────────────────────────────────────────────────
//
// Includes a learner-identity column (email + full name) joined from
// usersTable so the office can match rows to people without separately
// pulling the user list. Each export writes an audit-log row.

router.get(
  "/admin/export",
  requireAuth,
  requireRole("owner", "admin", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const rows = await db
        .select({
          intake: lmsOnboardingIntakeTable,
          email: usersTable.email,
          first_name: usersTable.first_name,
          last_name: usersTable.last_name,
        })
        .from(lmsOnboardingIntakeTable)
        .leftJoin(
          usersTable,
          eq(usersTable.id, lmsOnboardingIntakeTable.user_id),
        )
        .where(eq(lmsOnboardingIntakeTable.company_id, companyId))
        .orderBy(desc(lmsOnboardingIntakeTable.updated_at));

      const headers = [
        "email",
        "first_name",
        "last_name",
        "preferred_name",
        "pronouns",
        "personal_email",
        "personal_cell_phone",
        "emergency_contact_name",
        "emergency_contact_relationship",
        "emergency_contact_phone",
        "languages_spoken",
        "shirt_size",
        "apron_size",
        "drives_personal_vehicle",
        "vehicle_insurance_company",
        "vehicle_insurance_policy_number",
        "vehicle_insurance_expires_at",
        "vehicle_license_plate",
        "drivers_license_state",
        "drivers_license_expires_at",
        "notes",
        "submitted_at",
        "updated_at",
      ];
      const lines: string[] = [headers.join(",")];
      for (const r of rows) {
        const i = r.intake;
        lines.push(
          [
            r.email,
            r.first_name,
            r.last_name,
            i.preferred_name,
            i.pronouns,
            i.personal_email,
            i.personal_cell_phone,
            i.emergency_contact_name,
            i.emergency_contact_relationship,
            i.emergency_contact_phone,
            i.languages_spoken,
            i.shirt_size,
            i.apron_size,
            i.drives_personal_vehicle ? "true" : "false",
            i.vehicle_insurance_company,
            i.vehicle_insurance_policy_number,
            i.vehicle_insurance_expires_at,
            i.vehicle_license_plate,
            i.drivers_license_state,
            i.drivers_license_expires_at,
            i.notes,
            i.submitted_at?.toISOString() ?? "",
            i.updated_at?.toISOString() ?? "",
          ]
            .map(csvCell)
            .join(","),
        );
      }
      const csv = lines.join("\n") + "\n";

      await logAudit(
        req,
        "lms.onboarding_intake.exported",
        "lms_onboarding_intake",
        null,
        null,
        {
          company_id: companyId,
          row_count: rows.length,
        },
      );

      const filename = `phes-onboarding-intake-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      return res.send(csv);
    } catch (err) {
      console.error("[lms-onboarding-intake] GET /admin/export error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to export intake" });
    }
  },
);

export default router;
