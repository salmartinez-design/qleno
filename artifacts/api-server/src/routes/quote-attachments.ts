import { Router } from "express";
import { db } from "@workspace/db";
import { quoteAttachmentsTable, quotesTable, jobsTable, jobTechniciansTable } from "@workspace/db/schema";
import { eq, and, desc, count } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import multer from "multer";
import path from "path";
import fs from "fs";

// [quote-attachments 2026-05-26] Drop-zone-driven uploads on the quote
// builder's Call Notes panel. Mirrors the existing client_attachments
// pattern (multer disk → /api/uploads/* public). Two routers exported:
//   - quoteAttachmentsRouter  mounted on /api/quotes        (full CRUD)
//   - jobAttachmentsRouter    mounted on /api/jobs          (read-only)
// The job-side route resolves quotes.booked_job_id = :id so techs
// don't need to know which quote their job came from.

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "image/gif",
  "application/pdf",
]);
const MAX_FILES_PER_QUOTE = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

// ── /api/quotes/:id/attachments ──────────────────────────────────────────
export const quoteAttachmentsRouter = Router();

quoteAttachmentsRouter.get("/:id/attachments", requireAuth, async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    if (!quoteId) { res.status(400).json({ error: "quoteId required" }); return; }
    const rows = await db
      .select()
      .from(quoteAttachmentsTable)
      .where(and(
        eq(quoteAttachmentsTable.company_id, req.auth!.companyId),
        eq(quoteAttachmentsTable.quote_id, quoteId),
      ))
      .orderBy(desc(quoteAttachmentsTable.created_at));
    res.json(rows);
  } catch (e: any) {
    console.error("List quote attachments error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

quoteAttachmentsRouter.post("/:id/attachments", requireAuth, requireRole("owner", "admin", "office"), upload.single("file"), async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    if (!quoteId) { res.status(400).json({ error: "quoteId required" }); return; }
    if (!req.file) { res.status(400).json({ error: "file required" }); return; }

    // Verify the quote belongs to this tenant before storing anything.
    const [quote] = await db.select({ id: quotesTable.id })
      .from(quotesTable)
      .where(and(eq(quotesTable.id, quoteId), eq(quotesTable.company_id, req.auth!.companyId)))
      .limit(1);
    if (!quote) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      res.status(404).json({ error: "Quote not found" });
      return;
    }

    // Enforce the 10-file cap per quote.
    const [{ value: existing }] = await db.select({ value: count() })
      .from(quoteAttachmentsTable)
      .where(and(
        eq(quoteAttachmentsTable.company_id, req.auth!.companyId),
        eq(quoteAttachmentsTable.quote_id, quoteId),
      ));
    if (existing >= MAX_FILES_PER_QUOTE) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      res.status(400).json({ error: `Maximum ${MAX_FILES_PER_QUOTE} files per quote` });
      return;
    }

    // app.ts mounts express.static on /api/uploads → ../uploads (set as
    // UPLOADS_DIR). Write there directly so files are served immediately.
    const uploadsDir = process.env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const destPath = path.join(uploadsDir, req.file.filename);
    fs.renameSync(req.file.path, destPath);

    const bodyName = typeof req.body?.name === "string" ? req.body.name : req.file.originalname;
    const [attachment] = await db.insert(quoteAttachmentsTable).values({
      company_id: req.auth!.companyId,
      quote_id: quoteId,
      name: bodyName,
      file_url: `/api/uploads/${req.file.filename}`,
      file_type: req.file.mimetype,
      file_size: req.file.size,
      uploaded_by: req.auth!.userId,
    }).returning();
    res.status(201).json(attachment);
  } catch (e: any) {
    console.error("Upload quote attachment error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

quoteAttachmentsRouter.delete("/:id/attachments/:fileId", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    const fileId = parseInt(req.params.fileId);
    if (!quoteId || !fileId) { res.status(400).json({ error: "quoteId and fileId required" }); return; }

    const [row] = await db.select()
      .from(quoteAttachmentsTable)
      .where(and(
        eq(quoteAttachmentsTable.id, fileId),
        eq(quoteAttachmentsTable.quote_id, quoteId),
        eq(quoteAttachmentsTable.company_id, req.auth!.companyId),
      ))
      .limit(1);
    if (!row) { res.status(404).json({ error: "Attachment not found" }); return; }

    await db.delete(quoteAttachmentsTable).where(eq(quoteAttachmentsTable.id, fileId));

    // Best-effort disk cleanup. Missing file = harmless.
    if (row.file_url?.startsWith("/api/uploads/")) {
      const uploadsDir = process.env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads");
      const diskPath = path.join(uploadsDir, path.basename(row.file_url));
      try { fs.unlinkSync(diskPath); } catch { /* gone is fine */ }
    }
    res.json({ success: true });
  } catch (e: any) {
    console.error("Delete quote attachment error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

// ── /api/jobs/:id/attachments ────────────────────────────────────────────
// Read-only. Resolves quotes.booked_job_id = :id, returns its files.
// Owners / admins / office see any job; technicians must be assigned to
// the specific job (primary OR in job_technicians).
export const jobAttachmentsRouter = Router();

jobAttachmentsRouter.get("/:id/attachments", requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.id);
    if (!jobId) { res.status(400).json({ error: "jobId required" }); return; }

    const [job] = await db.select({ id: jobsTable.id, assigned_user_id: jobsTable.assigned_user_id })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, req.auth!.companyId)))
      .limit(1);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }

    const role = req.auth!.role;
    const userId = req.auth!.userId;
    if (role === "technician") {
      const isPrimary = job.assigned_user_id === userId;
      let isOnCrew = false;
      if (!isPrimary) {
        const [match] = await db.select({ id: jobTechniciansTable.id })
          .from(jobTechniciansTable)
          .where(and(
            eq(jobTechniciansTable.job_id, jobId),
            eq(jobTechniciansTable.user_id, userId),
          ))
          .limit(1);
        isOnCrew = !!match;
      }
      if (!isPrimary && !isOnCrew) { res.status(403).json({ error: "Not assigned to this job" }); return; }
    }

    const [quote] = await db.select({ id: quotesTable.id })
      .from(quotesTable)
      .where(and(
        eq(quotesTable.company_id, req.auth!.companyId),
        eq(quotesTable.booked_job_id, jobId),
      ))
      .limit(1);
    if (!quote) { res.json([]); return; }

    const rows = await db.select()
      .from(quoteAttachmentsTable)
      .where(and(
        eq(quoteAttachmentsTable.company_id, req.auth!.companyId),
        eq(quoteAttachmentsTable.quote_id, quote.id),
      ))
      .orderBy(desc(quoteAttachmentsTable.created_at));
    res.json(rows);
  } catch (e: any) {
    console.error("List job attachments error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});
