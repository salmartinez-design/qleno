// [commercial-workflow PR #2 / 2026-04-29] /api/service-types route.
//
// New unified source of truth for both residential and commercial
// service types. Hierarchical (parent_slug = 'residential' |
// 'commercial'); slug matches a value in the serviceTypeEnum so
// historical jobs continue to type-check.
//
// Tenant management:
// - Residential service types are fixed (the 5 seeded by Phes data
//   migration). POST/PATCH return 400 when parent_slug='residential'
//   to keep the residential set canonical.
// - Commercial service types are tenant-managed (mirror of the
//   existing commercial-service-types route — same enum-extension
//   pattern, same slug regex, same soft-delete semantics).
//
// PR #9 (later) will consolidate commercial_service_types → service_types
// and drop the old route.

import { Router } from "express";
import { db } from "@workspace/db";
import { serviceTypesTable } from "@workspace/db/schema";
import { eq, and, asc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

const SLUG_RE = /^[a-z][a-z0-9_]*$/;
const PARENTS = ["residential", "commercial"] as const;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

// GET /api/service-types
//
// Query params:
//   parent  — filter to 'residential' or 'commercial' (optional)
//   active  — 'true' (default) returns only is_active=true rows,
//             'false' returns inactive only, omit for all
//
// Sorted by (parent_slug, display_order, id) so the default render
// order is stable across calls. Frontend can group by parent_slug.
router.get("/", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const parent = req.query.parent as string | undefined;
    const activeRaw = req.query.active as string | undefined;

    if (parent !== undefined && !PARENTS.includes(parent as any)) {
      return res.status(400).json({
        error: "invalid parent",
        message: `parent must be one of: ${PARENTS.join(", ")}`,
      });
    }

    const conditions = [eq(serviceTypesTable.company_id, companyId)];
    if (parent) conditions.push(eq(serviceTypesTable.parent_slug, parent));
    if (activeRaw === "true" || activeRaw === undefined) {
      conditions.push(eq(serviceTypesTable.is_active, true));
    } else if (activeRaw === "false") {
      conditions.push(eq(serviceTypesTable.is_active, false));
    }
    // any other value of `active` → include both

    const rows = await db
      .select()
      .from(serviceTypesTable)
      .where(and(...conditions))
      .orderBy(
        asc(serviceTypesTable.parent_slug),
        asc(serviceTypesTable.display_order),
        asc(serviceTypesTable.id),
      );
    return res.json(rows);
  } catch (err) {
    console.error("GET /service-types error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/service-types — tenant-managed creation (commercial only).
// Body: {
//   parent_slug: 'commercial',                  // required; 'residential' is rejected
//   name: string,                                // required, becomes display label
//   slug?: string,                               // optional, auto-derived from name
//   description?: string,
//   default_allowed_hours?: number,              // null/omit = no default
//   display_order?: number,                      // default 100
// }
router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { parent_slug, name, slug: slugInput, description, default_allowed_hours, display_order } = req.body ?? {};

    if (parent_slug !== "commercial") {
      return res.status(400).json({
        error: "residential service types are fixed",
        message: "Only parent_slug='commercial' is tenant-managed. The residential set is canonical and cannot be extended via the API.",
      });
    }
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "name is required" });
    }
    const slug = (slugInput && typeof slugInput === "string" ? slugInput : slugify(name)).toLowerCase();
    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({
        error: "invalid slug",
        message: "slug must match ^[a-z][a-z0-9_]*$ (lowercase letters/digits/underscores, starts with a letter)",
        derived_slug: slug,
      });
    }

    // Extend the Postgres enum (no-op if already present). Same
    // pattern as commercial-service-types: cannot run inside a
    // transaction. SLUG_RE has gated the input against injection.
    try {
      await db.execute(sql.raw(`ALTER TYPE service_type ADD VALUE IF NOT EXISTS '${slug}'`));
    } catch (err: any) {
      console.error("ALTER TYPE service_type ADD VALUE failed:", err?.message ?? err);
      return res.status(500).json({ error: "Could not extend service_type enum" });
    }

    try {
      const [row] = await db
        .insert(serviceTypesTable)
        .values({
          company_id: companyId,
          parent_slug: "commercial",
          slug,
          name: name.trim(),
          description: description ? String(description).trim() : null,
          default_allowed_hours: default_allowed_hours != null && default_allowed_hours !== ""
            ? String(default_allowed_hours)
            : null,
          display_order: typeof display_order === "number" ? display_order : 100,
          is_active: true,
        })
        .returning();
      return res.status(201).json(row);
    } catch (err: any) {
      // 23505 = unique_violation on (company_id, slug)
      if (err?.code === "23505") {
        return res.status(409).json({ error: "A service type with this slug already exists for this company" });
      }
      throw err;
    }
  } catch (err) {
    console.error("POST /service-types error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// PATCH /api/service-types/:id — edit name / description / default
// hours / display order / active. Slug + parent_slug are immutable
// (changing them would orphan jobs that reference the old slug).
router.patch("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const companyId = req.auth!.companyId!;
    const { name, description, default_allowed_hours, is_active, display_order } = req.body ?? {};

    const setParts: Record<string, unknown> = {};
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length === 0) {
        return res.status(400).json({ error: "name must be a non-empty string" });
      }
      setParts.name = name.trim();
    }
    if (description !== undefined) {
      setParts.description = description === null || description === "" ? null : String(description).trim();
    }
    if (default_allowed_hours !== undefined) {
      setParts.default_allowed_hours = default_allowed_hours === null || default_allowed_hours === ""
        ? null
        : String(default_allowed_hours);
    }
    if (is_active !== undefined) setParts.is_active = !!is_active;
    if (display_order !== undefined) {
      const n = Number(display_order);
      if (!Number.isFinite(n)) return res.status(400).json({ error: "display_order must be a number" });
      setParts.display_order = n;
    }
    if (Object.keys(setParts).length === 0) {
      return res.status(400).json({ error: "no fields to update" });
    }

    const updated = await db
      .update(serviceTypesTable)
      .set(setParts as any)
      .where(and(
        eq(serviceTypesTable.id, id),
        eq(serviceTypesTable.company_id, companyId),
      ))
      .returning();
    if (!updated[0]) return res.status(404).json({ error: "Not found" });
    return res.json(updated[0]);
  } catch (err) {
    console.error("PATCH /service-types/:id error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE /api/service-types/:id — soft delete (is_active=false).
// Residential rows can be deactivated; the seed re-runs ON CONFLICT
// DO NOTHING so a previously-deactivated row stays deactivated
// across deploys. Hard delete is intentionally unsupported —
// historical jobs reference the slug via jobs.service_type.
router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const companyId = req.auth!.companyId!;
    const updated = await db
      .update(serviceTypesTable)
      .set({ is_active: false })
      .where(and(
        eq(serviceTypesTable.id, id),
        eq(serviceTypesTable.company_id, companyId),
      ))
      .returning();
    if (!updated[0]) return res.status(404).json({ error: "Not found" });
    return res.json({ ok: true, id, is_active: false });
  } catch (err) {
    console.error("DELETE /service-types/:id error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
