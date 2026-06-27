// [team-photo-notes] Pictures + notes the team attaches to a job, or makes
// sticky to a customer/property so they re-surface on every job there.
// Office + techs both add (requireAuth). Mirrors attachments.ts for upload.
import { Router } from "express";
import { db } from "@workspace/db";
import { teamPhotoNotesTable, jobsTable } from "@workspace/db/schema";
import { eq, and, or, desc, isNull } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
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
const toInt = (v: any) => (v === undefined || v === null || v === "" ? null : parseInt(String(v)));

// List notes. Three query modes (company-scoped throughout):
//   ?job_id=    → that job's own notes PLUS sticky notes matching the job's
//                 customer scope (client / account / property).
//   ?client_id= → sticky notes pinned to that client.
//   ?account_id= (&account_property_id=) → sticky notes pinned to that account
//                 (or that specific property).
router.get("/", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const jobId = toInt(req.query.job_id);
    const clientId = toInt(req.query.client_id);
    const accountId = toInt(req.query.account_id);
    const propertyId = toInt(req.query.account_property_id);

    if (jobId) {
      const [job] = await db.select({
        client_id: jobsTable.client_id,
        account_id: jobsTable.account_id,
        account_property_id: jobsTable.account_property_id,
      }).from(jobsTable).where(and(eq(jobsTable.id, jobId), eq(jobsTable.company_id, companyId)));
      if (!job) return res.status(404).json({ error: "Job not found" });

      // Sticky matches: same client, same property, or whole-account (no
      // property pin) on this job's account.
      const stickyMatches = [];
      if (job.client_id != null) stickyMatches.push(eq(teamPhotoNotesTable.client_id, job.client_id));
      if (job.account_property_id != null) stickyMatches.push(eq(teamPhotoNotesTable.account_property_id, job.account_property_id));
      if (job.account_id != null) {
        stickyMatches.push(and(
          eq(teamPhotoNotesTable.account_id, job.account_id),
          isNull(teamPhotoNotesTable.account_property_id),
        ));
      }
      const stickyClause = stickyMatches.length
        ? and(eq(teamPhotoNotesTable.is_sticky, true), or(...stickyMatches))
        : undefined;

      const rows = await db.select().from(teamPhotoNotesTable).where(and(
        eq(teamPhotoNotesTable.company_id, companyId),
        stickyClause
          ? or(eq(teamPhotoNotesTable.job_id, jobId), stickyClause)
          : eq(teamPhotoNotesTable.job_id, jobId),
      )).orderBy(desc(teamPhotoNotesTable.is_sticky), desc(teamPhotoNotesTable.created_at));
      return res.json(rows);
    }

    let scope;
    if (clientId) scope = eq(teamPhotoNotesTable.client_id, clientId);
    else if (propertyId) scope = eq(teamPhotoNotesTable.account_property_id, propertyId);
    else if (accountId) scope = eq(teamPhotoNotesTable.account_id, accountId);
    else return res.status(400).json({ error: "job_id, client_id, or account_id required" });

    const rows = await db.select().from(teamPhotoNotesTable).where(and(
      eq(teamPhotoNotesTable.company_id, companyId),
      eq(teamPhotoNotesTable.is_sticky, true),
      scope,
    )).orderBy(desc(teamPhotoNotesTable.created_at));
    res.json(rows);
  } catch (e: any) {
    console.error("List team photo notes error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

// Create a note. Accepts a multipart "file" (the picture) and/or a text note.
// is_sticky=true pins it to the supplied customer scope; otherwise it's tied to
// job_id. When sticky from a job context, the client pre-resolves the customer
// scope (client_id / account_id / account_property_id) and passes it through.
router.post("/", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const { note } = req.body;
    const isSticky = req.body.is_sticky === true || req.body.is_sticky === "true";
    const jobId = toInt(req.body.job_id);
    const clientId = toInt(req.body.client_id);
    const accountId = toInt(req.body.account_id);
    const propertyId = toInt(req.body.account_property_id);

    if (isSticky && clientId == null && accountId == null && propertyId == null) {
      return res.status(400).json({ error: "A sticky note needs a customer scope (client or account/property)" });
    }
    if (!isSticky && jobId == null) {
      return res.status(400).json({ error: "A job-specific note needs job_id" });
    }
    if (!req.file && !(note && String(note).trim())) {
      return res.status(400).json({ error: "Add a picture or a note" });
    }

    let imageUrl: string | null = null;
    if (req.file) {
      const uploadsDir = process.env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.renameSync(req.file.path, path.join(uploadsDir, req.file.filename));
      imageUrl = `/api/uploads/${req.file.filename}`;
    }

    const [row] = await db.insert(teamPhotoNotesTable).values({
      company_id: req.auth!.companyId,
      job_id: jobId,
      client_id: clientId,
      account_id: accountId,
      account_property_id: propertyId,
      is_sticky: isSticky,
      image_url: imageUrl,
      note: note ? String(note) : null,
      uploaded_by: req.auth!.userId,
    }).returning();
    res.status(201).json(row);
  } catch (e: any) {
    console.error("Create team photo note error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(teamPhotoNotesTable).where(and(
      eq(teamPhotoNotesTable.id, id),
      eq(teamPhotoNotesTable.company_id, req.auth!.companyId),
    ));
    res.json({ success: true });
  } catch (e: any) {
    console.error("Delete team photo note error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

export default router;
