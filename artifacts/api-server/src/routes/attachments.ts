import { Router } from "express";
import { db } from "@workspace/db";
import { clientAttachmentsTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = "/tmp/uploads";
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const clientId = req.query.client_id ? parseInt(req.query.client_id as string) : undefined;
    if (!clientId) return res.status(400).json({ error: "client_id required" });
    const attachments = await db
      .select()
      .from(clientAttachmentsTable)
      .where(and(
        eq(clientAttachmentsTable.company_id, req.auth!.companyId),
        eq(clientAttachmentsTable.client_id, clientId)
      ))
      .orderBy(desc(clientAttachmentsTable.created_at));
    res.json(attachments);
  } catch (e: any) {
    console.error("List attachments error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const { client_id, name, category } = req.body;
    if (!client_id || !name) return res.status(400).json({ error: "client_id and name required" });
    let file_url = req.body.file_url || "";
    let file_type: string | undefined;
    let file_size: number | undefined;
    if (req.file) {
      file_type = req.file.mimetype;
      file_size = req.file.size;
      // Store under the dir the static handler serves (app.ts) and expose the
      // canonical /api/uploads/ URL. The previous code wrote to public/uploads
      // and stored a bare /uploads/ URL — neither served, so every download
      // 404'd. Mirrors quote-attachments.ts.
      const uploadsDir = process.env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });
      const destPath = path.join(uploadsDir, req.file.filename);
      fs.renameSync(req.file.path, destPath);
      file_url = `/api/uploads/${req.file.filename}`;
    }
    const [attachment] = await db.insert(clientAttachmentsTable).values({
      company_id: req.auth!.companyId,
      client_id: parseInt(client_id),
      name,
      file_url,
      file_type,
      file_size,
      category: category || "other",
      uploaded_by: req.auth!.userId,
    }).returning();
    res.status(201).json(attachment);
  } catch (e: any) {
    console.error("Upload attachment error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(clientAttachmentsTable).where(
      and(eq(clientAttachmentsTable.id, id), eq(clientAttachmentsTable.company_id, req.auth!.companyId))
    );
    res.json({ success: true });
  } catch (e: any) {
    console.error("Delete attachment error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

export default router;
