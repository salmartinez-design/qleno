/**
 * LMS per-tenant settings (Items 8 + 9, P1 sprint 2026-05-14).
 *
 * Mounted at /api/lms-settings. Owner-only writes; owner / admin can
 * read (admin needs to know what they can/cannot do, even if they
 * can't change the toggle).
 *
 *   GET  /              fetch current settings (auto-creates default row)
 *   PATCH /            update toggles (owner-only)
 */
import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  lmsSettingsTable,
  type LmsSettings,
} from "@workspace/db/schema";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";

const router = Router();

async function getOrCreateSettings(companyId: number): Promise<LmsSettings> {
  const existing = await db
    .select()
    .from(lmsSettingsTable)
    .where(eq(lmsSettingsTable.company_id, companyId))
    .limit(1);
  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(lmsSettingsTable)
    .values({
      company_id: companyId,
      admin_bypass_allowed: false,
      admin_add_employee_allowed: false,
      admin_edit_employee_allowed: false,
    })
    .onConflictDoNothing({ target: lmsSettingsTable.company_id })
    .returning();
  if (inserted[0]) return inserted[0];

  // Race: another caller created the row between our SELECT + INSERT.
  const after = await db
    .select()
    .from(lmsSettingsTable)
    .where(eq(lmsSettingsTable.company_id, companyId))
    .limit(1);
  if (!after[0]) {
    throw new Error("Failed to create or fetch lms_settings row");
  }
  return after[0];
}

router.get(
  "/",
  requireAuth,
  requireRole("owner", "admin"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res.status(400).json({
          error: "Bad Request",
          message: "User has no company assignment",
        });
      }
      const settings = await getOrCreateSettings(companyId);
      return res.json({ data: settings });
    } catch (err) {
      console.error("[lms-settings] GET / error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to load LMS settings",
      });
    }
  },
);

router.patch(
  "/",
  requireAuth,
  // [office-admin-parity 2026-06-26] LMS admin settings editable by owner + office.
  requireRole("owner", "office"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res.status(400).json({
          error: "Bad Request",
          message: "User has no company assignment",
        });
      }
      const existing = await getOrCreateSettings(companyId);

      const patch: Partial<{
        admin_bypass_allowed: boolean;
        admin_add_employee_allowed: boolean;
        admin_edit_employee_allowed: boolean;
      }> = {};
      if (typeof req.body?.admin_bypass_allowed === "boolean") {
        patch.admin_bypass_allowed = req.body.admin_bypass_allowed;
      }
      if (typeof req.body?.admin_add_employee_allowed === "boolean") {
        patch.admin_add_employee_allowed = req.body.admin_add_employee_allowed;
      }
      if (typeof req.body?.admin_edit_employee_allowed === "boolean") {
        patch.admin_edit_employee_allowed = req.body.admin_edit_employee_allowed;
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({
          error: "Bad Request",
          message: "No valid setting provided",
        });
      }

      // Item 12 (onboarding-readiness sprint 2026-05-15): drop fields
      // that match the current value so we don't bump updated_at on a
      // pure no-op save. Audit log row is also suppressed when nothing
      // actually changed.
      const diff: typeof patch = {};
      for (const k of Object.keys(patch) as Array<keyof typeof patch>) {
        if (patch[k] !== existing[k]) {
          (diff as any)[k] = patch[k];
        }
      }
      if (Object.keys(diff).length === 0) {
        return res.json({ data: existing });
      }

      const now = new Date();
      const updated = await db
        .update(lmsSettingsTable)
        .set({ ...diff, updated_at: now })
        .where(eq(lmsSettingsTable.company_id, companyId))
        .returning();

      await logAudit(
        req,
        "lms_settings.update",
        "lms_settings",
        existing.id,
        {
          admin_bypass_allowed: existing.admin_bypass_allowed,
          admin_add_employee_allowed: existing.admin_add_employee_allowed,
          admin_edit_employee_allowed: existing.admin_edit_employee_allowed,
        },
        diff,
      );

      return res.json({ data: updated[0] });
    } catch (err) {
      console.error("[lms-settings] PATCH / error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to update LMS settings",
      });
    }
  },
);

export default router;
