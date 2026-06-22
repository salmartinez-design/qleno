// [help-guides 2026-06-21] Read API for the in-app Help & Guides center.
//   GET /api/guides            — list guides visible to the caller's role
//   GET /api/guides/:slug       — one guide (full content, both languages)
//   GET /api/guides/:slug/pdf   — downloadable PDF in ?locale=en|es
//
// Guides are PLATFORM-level content (global, company_id IS NULL in v1), so the
// list is NOT tenant-scoped — every tenant sees the same how-to library. What it
// IS scoped by is AUDIENCE: techs see 'tech' + 'all'; office roles see 'office'
// + 'all'; owners/admins see everything (they own the content). The filter runs
// server-side off the JWT role so a tech can't enumerate office guides by URL.
//
// The table is created + seeded by runGuidesMigration() at boot, so these
// endpoints degrade gracefully (empty list / 404) on a brand-new deploy before
// the migration has run.
import { Router } from "express";
import { fileURLToPath } from "url";
import path from "path";
import { readFile } from "fs/promises";
import { db } from "@workspace/db";
import { guidesTable, type Guide, type GuideStep } from "@workspace/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { generateGuidePdf, type GuidePdfStep } from "../lib/guide-pdf.js";

const router = Router();

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Which audiences a role may see. Techs are walled to tech/all; everyone else
// sees office/all; the privileged roles that author content see the lot.
function visibleAudiences(role: string): string[] {
  if (role === "technician" || role === "team_lead") return ["tech", "all"];
  if (role === "owner" || role === "admin" || role === "super_admin") {
    return ["tech", "office", "all"];
  }
  // office, accountant, anything else
  return ["office", "all"];
}

function localize(en: string | null, es: string | null, locale: "en" | "es"): string {
  if (locale === "es") return (es && es.trim()) || en || "";
  return en || "";
}

// List shape — carries BOTH languages so the client can toggle without a refetch.
function toListItem(g: Guide) {
  return {
    slug: g.slug,
    audience: g.audience,
    category: g.category,
    icon: g.icon,
    sort_order: g.sort_order,
    title_en: g.title_en,
    title_es: g.title_es,
    summary_en: g.summary_en,
    summary_es: g.summary_es,
    step_count: Array.isArray(g.steps) ? g.steps.length : 0,
  };
}

// GET /api/guides — role-filtered, published, ordered.
router.get("/", requireAuth, async (req, res) => {
  try {
    const audiences = visibleAudiences(req.auth!.role);
    const rows = await db
      .select()
      .from(guidesTable)
      .where(and(eq(guidesTable.published, true), inArray(guidesTable.audience, audiences)))
      .orderBy(asc(guidesTable.sort_order), asc(guidesTable.id));
    return res.json({ guides: rows.map(toListItem) });
  } catch (err) {
    // Table not migrated yet (fresh deploy) → empty list, never a 500.
    console.error("[guides] GET / error:", err);
    return res.json({ guides: [] });
  }
});

// Load a single guide if it's visible to the caller. Returns null on miss.
async function loadVisibleGuide(slug: string, role: string): Promise<Guide | null> {
  const audiences = visibleAudiences(role);
  const [row] = await db
    .select()
    .from(guidesTable)
    .where(and(eq(guidesTable.slug, slug), eq(guidesTable.published, true)))
    .limit(1);
  if (!row) return null;
  if (!audiences.includes(row.audience)) return null;
  return row;
}

// GET /api/guides/:slug — full guide, both languages.
router.get("/:slug", requireAuth, async (req, res) => {
  try {
    const guide = await loadVisibleGuide(String(req.params.slug), req.auth!.role);
    if (!guide) {
      return res.status(404).json({ error: "Not Found", message: "Guide not found" });
    }
    return res.json({ guide });
  } catch (err) {
    console.error("[guides] GET /:slug error:", err);
    return res.status(404).json({ error: "Not Found", message: "Guide not found" });
  }
});

// Resolve a step image (opaque path like "/guides/<slug>/step-1.png") to bytes
// on disk. v1 screenshots are committed under the frontend's public/ dir, which
// the build copies to dist/public. We try the built location first, then the
// source location (dev). Path is validated to prevent traversal. Returns null
// when the asset isn't present — the PDF then renders a placeholder box.
const IMAGE_PATH_RE = /^\/guides\/[a-z0-9._-]+\/[a-z0-9._-]+\.(png|jpe?g)$/i;

async function loadStepImage(
  imagePath: string,
): Promise<{ bytes: Buffer; format: "png" | "jpg" } | null> {
  if (!IMAGE_PATH_RE.test(imagePath)) return null;
  const rel = imagePath.replace(/^\//, "");
  const candidates = [
    path.resolve(__moduleDir, "../../../qleno/dist/public", rel),
    path.resolve(__moduleDir, "../../../qleno/public", rel),
  ];
  const format: "png" | "jpg" = /\.png$/i.test(imagePath) ? "png" : "jpg";
  for (const file of candidates) {
    try {
      const bytes = await readFile(file);
      return { bytes, format };
    } catch {
      // try next candidate
    }
  }
  return null;
}

// GET /api/guides/:slug/pdf?locale=en|es — downloadable PDF.
router.get("/:slug/pdf", requireAuth, async (req, res) => {
  try {
    const guide = await loadVisibleGuide(String(req.params.slug), req.auth!.role);
    if (!guide) {
      return res.status(404).json({ error: "Not Found", message: "Guide not found" });
    }
    const locale: "en" | "es" = req.query.locale === "es" ? "es" : "en";

    const steps: GuideStep[] = Array.isArray(guide.steps) ? guide.steps : [];
    const pdfSteps: GuidePdfStep[] = await Promise.all(
      steps
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(async (s, i) => {
          const img = await loadStepImage(s.image || "");
          return {
            order: s.order ?? i + 1,
            caption: localize(s.caption_en, s.caption_es, locale),
            image: img?.bytes ?? null,
            imageFormat: img?.format ?? null,
          };
        }),
    );

    const pdfBytes = await generateGuidePdf({
      title: localize(guide.title_en, guide.title_es, locale),
      summary: localize(guide.summary_en, guide.summary_es, locale),
      locale,
      steps: pdfSteps,
    });

    const safeSlug = guide.slug.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const filename = `qleno-guide-${safeSlug}-${locale}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.end(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("[guides] GET /:slug/pdf error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to render guide PDF" });
  }
});

export default router;
