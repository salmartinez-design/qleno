import { Router, type Request, type Response } from "express";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage.js";
import { requireAuth, requireRole } from "../lib/auth.js";
import { db } from "@workspace/db";
import { jobPhotosTable, jobsTable, clientsTable } from "@workspace/db/schema";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  r2Configured, r2Upload, r2Delete, r2GetBytes, isR2Key, isLegacyDataUrl, jobPhotoKey,
} from "../lib/r2.js";
import { buildZip, type ZipEntry } from "../lib/zip.js";
import { logAudit } from "../lib/audit.js";
import crypto from "node:crypto";

const router = Router();
const storage = new ObjectStorageService();

// [photos-r2 2026-06-24] One-time migration: move legacy base64 job photos out
// of the DB (job_photos.url = "data:...") into R2, replacing the column value
// with the R2 object key. Owner/admin only, R2-gated, idempotent (only touches
// data: rows), batched via `limit` so it can be driven in chunks. Frees the
// ~1.4 GB of base64 bloating the database.
router.post("/migrate-to-r2", requireAuth, async (req: Request, res: Response) => {
  const role = (req as any).auth?.role;
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  if (!r2Configured()) {
    res.status(503).json({ error: "r2_not_configured", message: "Set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET first." });
    return;
  }
  const limit = Math.min(Math.max(Number(req.body?.limit) || 100, 1), 500);
  try {
    const rows = await db.select().from(jobPhotosTable).where(like(jobPhotosTable.url, "data:%")).limit(limit);
    let migrated = 0, failed = 0;
    let firstError: string | null = null;
    for (const p of rows) {
      try {
        const m = String(p.url).match(/^data:([^;]+);base64,([\s\S]*)$/);
        if (!m) { failed++; continue; }
        const contentType = m[1];
        const buffer = Buffer.from(m[2], "base64");
        const ext = (contentType.split("/")[1] || "jpg").split("+")[0];
        const key = jobPhotoKey(p.company_id, p.job_id, ext, crypto.randomBytes(12).toString("hex"));
        await r2Upload(key, buffer, contentType);
        await db.update(jobPhotosTable).set({ url: key }).where(eq(jobPhotosTable.id, p.id));
        migrated++;
      } catch (e) {
        console.error("[migrate-to-r2] photo", p.id, e);
        if (!firstError) firstError = e instanceof Error ? e.message : String(e);
        failed++;
      }
    }
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(jobPhotosTable)
      .where(like(jobPhotosTable.url, "data:%"));
    res.json({ migrated, failed, remaining: Number(row?.c ?? 0), error_sample: firstError });
  } catch (err) {
    console.error("[migrate-to-r2]:", err);
    res.status(500).json({ error: "migration_failed" });
  }
});

// [AF] PHOTOS_ENABLED feature flag. Photos are ENABLED by default (field techs
// rely on before/after photos); the flag is now an explicit kill switch —
// uploads are only blocked when PHOTOS_ENABLED is set to "false".
const photosEnabled = () => process.env.PHOTOS_ENABLED !== "false";

router.post("/request-url", requireAuth, async (req: Request, res: Response) => {
  if (!photosEnabled()) {
    res.status(503).json({ error: "feature_disabled", message: "Photo uploads are temporarily disabled (PHOTOS_ENABLED=false)." });
    return;
  }
  const { name, size, contentType } = req.body;
  if (!name || !contentType) {
    res.status(400).json({ error: "name and contentType are required" });
    return;
  }
  try {
    const uploadURL = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);
    res.json({ uploadURL, objectPath });
  } catch (err) {
    console.error("POST /photos/request-url:", err);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

router.get("/objects/*path", requireAuth, async (req: Request, res: Response) => {
  const raw = req.params.path;
  const rawPath = "/objects/" + (Array.isArray(raw) ? raw.join("/") : raw);
  try {
    const file = await storage.getObjectEntityFile(rawPath);
    const response = await storage.downloadObject(file);
    const headers = Object.fromEntries(response.headers.entries());
    res.set(headers);
    res.status(response.status);
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    console.error("GET /photos/objects/*:", err);
    res.status(500).json({ error: "Failed to serve object" });
  }
});

// ─── PHOTO MANAGEMENT ─────────────────────────────────────────────────────────
// [photo-management 2026-08-09] Francisco: "We need the ability to delete,
// download, and batch download images attached to a service. Currently, from the
// Client Profile, we can see that photos have been uploaded, but we cannot open
// them, download them, or manage them in any way."
//
// The photos were only ever reachable as <img src> thumbnails. Three things were
// missing outright — a download, a bulk download, and a delete — and all three
// have to run through the server rather than the browser:
//
//   * DOWNLOAD can't be a link. `job_photos.url` holds an R2 object KEY, which
//     reads sign into a short-lived URL on a different origin — and a browser
//     ignores the `download` attribute on a cross-origin href, so it navigates
//     to the image instead of saving it. We serve the bytes with an explicit
//     Content-Disposition.
//   * BATCH DOWNLOAD has to be a zip built server-side for the same reason;
//     firing N cross-origin navigations is not a bulk download.
//   * DELETE has to remove the R2 object as well as the row, or the bytes are
//     billed forever with nothing pointing at them.
//
// Everything is company-scoped through the job (job_photos.company_id exists but
// the join is what actually proves the photo belongs to this tenant's job).

/** One photo plus the job/client context used for naming and tenant scoping. */
async function loadPhotos(ids: number[], companyId: number) {
  if (ids.length === 0) return [];
  return db.select({
    id: jobPhotosTable.id,
    job_id: jobPhotosTable.job_id,
    photo_type: jobPhotosTable.photo_type,
    url: jobPhotosTable.url,
    timestamp: jobPhotosTable.timestamp,
    job_date: jobsTable.scheduled_date,
    client_first: clientsTable.first_name,
    client_last: clientsTable.last_name,
  })
    .from(jobPhotosTable)
    .innerJoin(jobsTable, and(
      eq(jobPhotosTable.job_id, jobsTable.id),
      eq(jobsTable.company_id, companyId),
    ))
    .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
    .where(inArray(jobPhotosTable.id, ids))
    .orderBy(jobPhotosTable.job_id, jobPhotosTable.timestamp, jobPhotosTable.id);
}

/** Read a stored photo's bytes whatever shape the url column is in. */
async function readPhotoBytes(url: string): Promise<{ body: Buffer; contentType: string } | null> {
  if (isR2Key(url)) return r2GetBytes(url);
  // Legacy pre-R2 rows still hold the image inline as a data: URL.
  if (isLegacyDataUrl(url)) {
    const m = url.match(/^data:([^;]+);base64,([\s\S]*)$/);
    if (!m) return null;
    return { body: Buffer.from(m[2], "base64"), contentType: m[1] };
  }
  // An absolute URL written by an older upload path — fetch it through.
  if (/^https?:\/\//.test(url)) {
    const r = await fetch(url);
    if (!r.ok) return null;
    return {
      body: Buffer.from(await r.arrayBuffer()),
      contentType: r.headers.get("content-type") || "application/octet-stream",
    };
  }
  return null;
}

const extFor = (contentType: string) =>
  ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
     "image/heic": "heic", "image/heif": "heif" } as Record<string, string>)[contentType] || "jpg";

// A filename the office can find later: who, when, which visit, before or after.
// The date is the photo's own timestamp, not the job's scheduled_date — a
// rescheduled job drags that date around, same reason the profile groups by
// photo_timestamp.
function photoFilename(p: Awaited<ReturnType<typeof loadPhotos>>[number], ext: string, seq: number) {
  const client = `${p.client_first ?? ""} ${p.client_last ?? ""}`.trim();
  // pg hands back a timestamp column as a JS Date, so String() would render
  // "Sat Aug 01 2026 …" and slicing it gives "Sat Aug 0". Sort-friendly ISO only.
  const raw = p.timestamp ?? p.job_date ?? null;
  const date = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw ?? "").slice(0, 10);
  return [client || `Job ${p.job_id}`, date, `job-${p.job_id}`, p.photo_type, seq]
    .filter(Boolean).join(" ") + `.${ext}`;
}

// GET /api/photos/:id/download — one image, as a real file save.
router.get("/:id/download", requireAuth, async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).auth!.companyId!;
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "bad_photo_id" }); return; }

    const [photo] = await loadPhotos([id], companyId);
    if (!photo) { res.status(404).json({ error: "photo_not_found" }); return; }

    const bytes = await readPhotoBytes(photo.url);
    if (!bytes) { res.status(502).json({ error: "photo_unreadable" }); return; }

    const name = photoFilename(photo, extFor(bytes.contentType), 1);
    res.setHeader("Content-Type", bytes.contentType);
    res.setHeader("Content-Length", String(bytes.body.length));
    res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/"/g, "")}"`);
    res.send(bytes.body);
  } catch (err) {
    console.error("GET /photos/:id/download:", err);
    res.status(500).json({ error: "download_failed" });
  }
});

// POST /api/photos/download-zip — { photo_ids: number[] } → one archive.
// Capped because the whole zip is assembled in memory (same STORE-method writer
// the bulk-invoice download uses). Photos are already-compressed JPEGs, so
// deflating them would buy nothing.
const MAX_ZIP_PHOTOS = 250;
const MAX_ZIP_BYTES = 300 * 1024 * 1024;

router.post("/download-zip", requireAuth, async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).auth!.companyId!;
    const ids = Array.from(new Set(
      (Array.isArray(req.body?.photo_ids) ? req.body.photo_ids : [])
        .map((n: unknown) => parseInt(String(n), 10))
        .filter((n: number) => Number.isFinite(n)),
    )) as number[];

    if (ids.length === 0) { res.status(400).json({ error: "no_photos_selected" }); return; }
    if (ids.length > MAX_ZIP_PHOTOS) {
      res.status(413).json({
        error: "too_many_photos",
        message: `Select at most ${MAX_ZIP_PHOTOS} photos per download (got ${ids.length}).`,
      });
      return;
    }

    const photos = await loadPhotos(ids, companyId);
    if (photos.length === 0) { res.status(404).json({ error: "photo_not_found" }); return; }

    const entries: ZipEntry[] = [];
    let total = 0;
    let skipped = 0;
    let seq = 0;
    for (const p of photos) {
      seq++;
      let bytes: Awaited<ReturnType<typeof readPhotoBytes>> = null;
      try { bytes = await readPhotoBytes(p.url); }
      catch (e) { console.error("[photo-zip] read failed for photo", p.id, e); }
      // One unreadable object shouldn't cost the office the other 40 photos —
      // skip it and report the count in a header the client can surface.
      if (!bytes) { skipped++; continue; }
      total += bytes.body.length;
      if (total > MAX_ZIP_BYTES) {
        res.status(413).json({
          error: "zip_too_large",
          message: "That selection is over 300 MB. Pick fewer photos.",
        });
        return;
      }
      entries.push({ name: photoFilename(p, extFor(bytes.contentType), seq), content: bytes.body });
    }

    if (entries.length === 0) { res.status(502).json({ error: "photos_unreadable" }); return; }

    const zip = buildZip(entries);
    const label = `${photos[0].client_first ?? ""} ${photos[0].client_last ?? ""}`.trim() || "job";
    const filename = `${label} photos (${entries.length}).zip`.replace(/[\\/:*?"<>|]/g, "");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", String(zip.length));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Photos-Included", String(entries.length));
    res.setHeader("X-Photos-Skipped", String(skipped));
    res.send(zip);
  } catch (err) {
    console.error("POST /photos/download-zip:", err);
    res.status(500).json({ error: "zip_failed" });
  }
});

// DELETE /api/photos/:id — office only. Techs upload photos from the field app;
// removing one is an office correction ("uploaded by mistake"), and a tech
// deleting another crew's before/after evidence is exactly what we don't want.
router.delete("/:id", requireAuth, requireRole("owner", "admin", "office", "super_admin"),
  async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).auth!.companyId!;
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) { res.status(400).json({ error: "bad_photo_id" }); return; }

      const [photo] = await loadPhotos([id], companyId);
      if (!photo) { res.status(404).json({ error: "photo_not_found" }); return; }

      // Drop the object first but never let R2 block the row delete — a missing
      // object would otherwise leave a permanently undeletable thumbnail.
      if (isR2Key(photo.url)) {
        try { await r2Delete(photo.url); }
        catch (e) { console.error("[photo-delete] R2 delete failed (non-fatal), photo", id, e); }
      }
      await db.delete(jobPhotosTable).where(eq(jobPhotosTable.id, id));

      // Before/after photos are the record of what was done on a visit, so a
      // deletion is worth a trail.
      await logAudit(req, "photo_deleted", "job_photo", id,
        { job_id: photo.job_id, photo_type: photo.photo_type, taken_at: photo.timestamp }, null);

      res.json({ data: { deleted: true, job_id: photo.job_id } });
    } catch (err) {
      console.error("DELETE /photos/:id:", err);
      res.status(500).json({ error: "delete_failed" });
    }
  });

export default router;
