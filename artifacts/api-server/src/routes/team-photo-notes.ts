// [team-photo-notes] Pictures + notes the team attaches to a job, or makes
// sticky to a customer/property so they re-surface on every job there.
// Office + techs both add (requireAuth).
//
// [team-photo-notes-r2 2026-07-28] Storage now mirrors job_photos /
// attendance-attachments: the picture bytes go to Cloudflare R2, the DB stores
// only the R2 object KEY in image_url, and reads sign a short-lived GET URL.
// Previously the bytes were written to local disk (/api/uploads/<file>), which
// on Railway is EPHEMERAL — every redeploy wiped the directory, so a picture
// the office or a cleaner uploaded showed briefly and then 404'd on the next
// deploy. That is why the office "kept adding the same notes again and again."
// When R2 is not configured, falls back to an inline data: URL (persists in the
// DB row) so uploads never break — never local disk.
import { Router } from "express";
import { db } from "@workspace/db";
import { teamPhotoNotesTable, jobsTable } from "@workspace/db/schema";
import { eq, and, or, desc, isNull } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import multer from "multer";
import crypto from "node:crypto";
import { r2Configured, r2Upload, r2Delete, r2SignedGetUrl, isR2Key, teamPhotoNoteKey } from "../lib/r2.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = Router();
const toInt = (v: any) => (v === undefined || v === null || v === "" ? null : parseInt(String(v)));

// R2 object keys in image_url are signed into a short-lived GET URL the browser
// can load directly. Legacy /api/uploads/* (now-wiped disk) and data: rows pass
// through untouched.
async function signNote(row: typeof teamPhotoNotesTable.$inferSelect) {
  return {
    ...row,
    image_url: isR2Key(row.image_url) ? await r2SignedGetUrl(row.image_url!) : row.image_url,
  };
}

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
      return res.json(await Promise.all(rows.map(signNote)));
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
    res.json(await Promise.all(rows.map(signNote)));
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

    // [team-photo-notes-r2] Store the picture in R2 (persistent); the DB row
    // keeps only the object key. Fall back to an inline data: URL when R2 is not
    // configured so uploads still work — never the ephemeral local disk.
    let imageUrl: string | null = null;
    if (req.file && req.file.buffer?.length) {
      const contentType = req.file.mimetype || "image/jpeg";
      if (r2Configured()) {
        const ext = (contentType.split("/")[1] || "jpg").split("+")[0];
        const key = teamPhotoNoteKey(req.auth!.companyId!, crypto.randomBytes(12).toString("hex"), ext);
        await r2Upload(key, req.file.buffer, contentType);
        imageUrl = key;
      } else {
        imageUrl = `data:${contentType};base64,${req.file.buffer.toString("base64")}`;
      }
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
    res.status(201).json(await signNote(row));
  } catch (e: any) {
    console.error("Create team photo note error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // Delete the row (company-scoped) and get it back so we can remove the
    // backing R2 object, if any. One query — same shape as before.
    const [row] = await db.delete(teamPhotoNotesTable).where(and(
      eq(teamPhotoNotesTable.id, id),
      eq(teamPhotoNotesTable.company_id, req.auth!.companyId),
    )).returning();
    if (row && isR2Key(row.image_url)) {
      try { await r2Delete(row.image_url!); }
      catch (e) { console.error("team photo note R2 delete failed (non-fatal):", e); }
    }
    res.json({ success: true });
  } catch (e: any) {
    console.error("Delete team photo note error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

export default router;
