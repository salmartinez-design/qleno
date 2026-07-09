import { Router, type Request, type Response } from "express";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage.js";
import { requireAuth } from "../lib/auth.js";
import { db } from "@workspace/db";
import { jobPhotosTable } from "@workspace/db/schema";
import { eq, like, sql } from "drizzle-orm";
import { r2Configured, r2Upload, jobPhotoKey } from "../lib/r2.js";
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

export default router;
