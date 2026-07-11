// [attendance-attachments 2026-07-11] Files attached to an unexcused-absence /
// tardy record (employee_attendance_log row) — injury photos the employee
// texted in, doctor's notes, work releases. Office-only: techs never see the
// attendance record, so they never reach these endpoints.
//
// Storage mirrors job photos: bytes go to Cloudflare R2, the DB stores only the
// R2 object KEY in file_url, and reads sign a short-lived GET URL. When R2 is
// not configured, falls back to an inline data: URL so uploads never break.
import { Router } from "express";
import multer from "multer";
import crypto from "crypto";
import { db } from "@workspace/db";
import { attendanceAttachmentsTable, employeeAttendanceLogTable } from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { r2Configured, r2Upload, r2Delete, r2SignedGetUrl, isR2Key, attendanceAttachmentKey } from "../lib/r2.js";

const router = Router();
router.use(requireAuth);

// Office tier only — same gate as the record/history endpoints (owner/admin/
// office/super_admin). Techs must never read or write attendance evidence.
const officeGate = requireRole("owner", "admin", "office", "super_admin");

const ALLOWED = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif",
  "application/pdf",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

// Confirm the attendance-log row exists and belongs to the caller's company.
async function logInCompany(logId: number, companyId: number): Promise<boolean> {
  if (!Number.isFinite(logId)) return false;
  const [row] = await db
    .select({ id: employeeAttendanceLogTable.id })
    .from(employeeAttendanceLogTable)
    .where(and(eq(employeeAttendanceLogTable.id, logId), eq(employeeAttendanceLogTable.company_id, companyId)))
    .limit(1);
  return !!row;
}

async function signRow(row: typeof attendanceAttachmentsTable.$inferSelect) {
  return {
    id: row.id,
    attendance_log_id: row.attendance_log_id,
    name: row.name,
    file_type: row.file_type,
    file_size: row.file_size,
    created_at: row.created_at,
    url: isR2Key(row.file_url) ? await r2SignedGetUrl(row.file_url) : row.file_url,
  };
}

// POST /api/attendance/:logId/attachments — upload one file (multipart, field
// "file"). Returns the stored row with a signed URL.
router.post("/:logId/attachments", officeGate, upload.single("file"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const logId = parseInt(req.params.logId, 10);
    if (!(await logInCompany(logId, companyId))) {
      return res.status(404).json({ error: "Attendance record not found" });
    }
    if (!req.file || !req.file.buffer?.length) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const contentType = req.file.mimetype || "application/octet-stream";
    if (!ALLOWED.has(contentType)) {
      return res.status(400).json({ error: "Only images and PDFs are allowed" });
    }

    let storedUrl: string;
    if (r2Configured()) {
      const ext = contentType === "application/pdf" ? "pdf" : (contentType.split("/")[1] || "bin").split("+")[0];
      const key = attendanceAttachmentKey(companyId, logId, ext, crypto.randomBytes(12).toString("hex"));
      await r2Upload(key, req.file.buffer, contentType);
      storedUrl = key;
    } else {
      storedUrl = `data:${contentType};base64,${req.file.buffer.toString("base64")}`;
    }

    const [row] = await db
      .insert(attendanceAttachmentsTable)
      .values({
        company_id: companyId,
        attendance_log_id: logId,
        name: (req.file.originalname || "attachment").slice(0, 200),
        file_url: storedUrl,
        file_type: contentType,
        file_size: req.file.size ?? req.file.buffer.length,
        uploaded_by: req.auth!.userId,
      })
      .returning();

    return res.status(201).json({ data: await signRow(row) });
  } catch (err) {
    console.error("POST /attendance/:logId/attachments error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// GET /api/attendance/attachments?log_ids=1,2,3 — batched list for the History
// modal. Returns { data: { "<logId>": [ {..signed..} ] } } for logs in company.
router.get("/attachments", officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const ids = String(req.query.log_ids ?? "")
      .split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n));
    const out: Record<string, any[]> = {};
    if (!ids.length) return res.json({ data: out });

    const rows = await db
      .select()
      .from(attendanceAttachmentsTable)
      .where(and(
        eq(attendanceAttachmentsTable.company_id, companyId),
        inArray(attendanceAttachmentsTable.attendance_log_id, ids),
      ));
    for (const r of rows) {
      const key = String(r.attendance_log_id);
      (out[key] ??= []).push(await signRow(r));
    }
    return res.json({ data: out });
  } catch (err) {
    console.error("GET /attendance/attachments error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE /api/attendance/:logId/attachments/:attId — remove one file (R2 object
// + row).
router.delete("/:logId/attachments/:attId", officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const logId = parseInt(req.params.logId, 10);
    const attId = parseInt(req.params.attId, 10);
    const [row] = await db
      .select()
      .from(attendanceAttachmentsTable)
      .where(and(
        eq(attendanceAttachmentsTable.id, attId),
        eq(attendanceAttachmentsTable.attendance_log_id, logId),
        eq(attendanceAttachmentsTable.company_id, companyId),
      ))
      .limit(1);
    if (!row) return res.status(404).json({ error: "Attachment not found" });

    if (isR2Key(row.file_url)) {
      try { await r2Delete(row.file_url); }
      catch (e) { console.error("attendance attachment R2 delete failed (non-fatal):", e); }
    }
    await db.delete(attendanceAttachmentsTable).where(eq(attendanceAttachmentsTable.id, attId));
    return res.json({ data: { deleted: true } });
  } catch (err) {
    console.error("DELETE /attendance/:logId/attachments/:attId error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
