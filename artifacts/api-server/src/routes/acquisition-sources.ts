// [scheduling-engine 2026-04-29] Tenant-managed acquisition sources.
//
// Replaces the hardcoded SOURCE_LABELS map in customer-profile.tsx
// — operators can add/rename/disable sources from the UI without a
// code deploy. The table is per-company; clients.referral_source
// continues storing the slug as plain text.
//
// Mirror of the commercial-service-types pattern but simpler — no
// enum side-effects since referral_source is plain TEXT, not a
// Postgres enum.

import { Router } from "express";
import { db } from "@workspace/db";
import { acquisitionSourcesTable } from "@workspace/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

const SLUG_RE = /^[a-z][a-z0-9_]*$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

// GET /api/acquisition-sources
// Default: only active rows, ordered by display_order.
// Pass ?include_inactive=true for the Settings management page.
router.get("/", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const includeInactive = req.query.include_inactive === "true";
    const rows = await db
      .select()
      .from(acquisitionSourcesTable)
      .where(
        includeInactive
          ? eq(acquisitionSourcesTable.company_id, companyId)
          : and(
              eq(acquisitionSourcesTable.company_id, companyId),
              eq(acquisitionSourcesTable.is_active, true),
            ),
      )
      .orderBy(asc(acquisitionSourcesTable.display_order), asc(acquisitionSourcesTable.id));
    return res.json(rows);
  } catch (err) {
    console.error("GET /acquisition-sources error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/acquisition-sources — create.
// Body: { name: string, slug?: string, display_order?: number }
// On dup-slug returns 409 so the inline "+ Add new source" UI can
// surface a clean message (rather than blowing up with a 500).
router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { name, slug: slugInput, display_order } = req.body ?? {};
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "name is required" });
    }
    const slug = (slugInput && typeof slugInput === "string" ? slugInput : slugify(name)).toLowerCase();
    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({ error: "slug must match ^[a-z][a-z0-9_]*$" });
    }
    try {
      const [row] = await db
        .insert(acquisitionSourcesTable)
        .values({
          company_id: companyId,
          slug,
          name: name.trim(),
          is_active: true,
          display_order: typeof display_order === "number" ? display_order : 100,
        })
        .returning();
      return res.status(201).json(row);
    } catch (err: any) {
      // 23505 = unique_violation on (company_id, slug)
      if (err?.code === "23505") {
        return res.status(409).json({ error: "An acquisition source with that name already exists" });
      }
      throw err;
    }
  } catch (err) {
    console.error("POST /acquisition-sources error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// PATCH /api/acquisition-sources/:id — update name / is_active /
// display_order. Slug is immutable to keep clients.referral_source
// references stable; if an operator wants to "rename" semantically,
// they should disable the old one and create a new one.
router.patch("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const { name, is_active, display_order } = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length === 0) {
        return res.status(400).json({ error: "name must be a non-empty string" });
      }
      patch.name = name.trim();
    }
    if (is_active !== undefined) patch.is_active = !!is_active;
    if (display_order !== undefined) {
      const n = Number(display_order);
      if (!Number.isFinite(n)) return res.status(400).json({ error: "display_order must be a number" });
      patch.display_order = n;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "no fields to update" });
    }
    const [row] = await db
      .update(acquisitionSourcesTable)
      .set(patch as any)
      .where(and(
        eq(acquisitionSourcesTable.id, id),
        eq(acquisitionSourcesTable.company_id, companyId),
      ))
      .returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (err) {
    console.error("PATCH /acquisition-sources/:id error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
