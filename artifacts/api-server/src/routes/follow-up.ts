/**
 * Follow-Up Sequences API
 * GET  /api/follow-up/sequences       — list sequences with steps
 * PATCH /api/follow-up/sequences/:id  — update sequence (is_active, name)
 * PATCH /api/follow-up/steps/:id      — update step message_template/subject
 * GET  /api/follow-up/message-log     — paginated message log
 */

import { Router } from "express";
import { requireAuth, requireRole } from "../lib/auth.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  processDueEnrollments,
  enrollForQuoteSent,
  enrollForJobComplete,
  stopEnrollmentsForQuote,
  sendSingleEnrollmentTouch,
  runSequenceTest,
} from "../services/followUpService.js";

const router = Router();

// ── POST /api/follow-up/sequences/:id/test-run ───────────────────────────────
// [seq-test-run 2026-07-09] Real-time sequence tester — fire the sequence's
// messages to a test phone/email NOW so office staff can preview the whole
// campaign land (ignores the real delays + the comms-off gate; tagged [TEST];
// persists nothing). owner/admin/OFFICE. Body: { to_phone?, to_email?,
// step_number? } — pass step_number to fire one step (step-through), omit it to
// fire the whole sequence (fast auto-run).
router.post("/sequences/:id/test-run", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const sequenceId = parseInt(req.params.id);
    if (isNaN(sequenceId)) return res.status(400).json({ error: "Invalid sequence id" });
    const { to_phone, to_email, step_number } = req.body as { to_phone?: string; to_email?: string; step_number?: number };
    if (!to_phone && !to_email) return res.status(400).json({ error: "Enter a test phone and/or email to send to." });
    const out = await runSequenceTest(companyId, sequenceId, {
      toPhone: (to_phone || "").trim() || null,
      toEmail: (to_email || "").trim() || null,
      stepNumber: step_number != null ? Number(step_number) : null,
    });
    return res.json(out);
  } catch (err: any) {
    console.error("POST /follow-up/sequences/:id/test-run:", err);
    return res.status(err?.message === "sequence_not_found" ? 404 : 500).json({ error: err?.message || "Test run failed" });
  }
});

// ── GET /api/follow-up/sequences ──────────────────────────────────────────────
// [seq-test-run 2026-07-09] owner/admin/office — office needs to view sequences
// to run the real-time tester. Editing/activating stays owner/admin (PATCH below).
router.get("/sequences", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const seqs = await db.execute(sql`
      SELECT id, company_id, sequence_type, name, is_active, created_at
      FROM follow_up_sequences
      WHERE company_id = ${companyId}
      ORDER BY id
    `);

    const result = [];
    for (const seq of seqs.rows) {
      const s = seq as any;
      const steps = await db.execute(sql`
        SELECT id, step_number, delay_hours, channel, subject, message_template
        FROM follow_up_steps
        WHERE sequence_id = ${s.id}
        ORDER BY step_number
      `);
      result.push({ ...s, steps: steps.rows });
    }
    return res.json(result);
  } catch (err) {
    console.error("GET /follow-up/sequences:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── PATCH /api/follow-up/sequences/:id ───────────────────────────────────────
router.patch("/sequences/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    const { name, is_active } = req.body;
    const updates: string[] = [];
    if (name !== undefined) updates.push(`name = '${(name as string).replace(/'/g, "''")}'`);
    if (is_active !== undefined) updates.push(`is_active = ${is_active ? "true" : "false"}`);
    if (!updates.length) return res.json({ ok: true });
    await db.execute(sql.raw(`
      UPDATE follow_up_sequences
      SET ${updates.join(", ")}
      WHERE id = ${id} AND company_id = ${companyId}
    `));
    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /follow-up/sequences/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── PATCH /api/follow-up/steps/:id ───────────────────────────────────────────
router.patch("/steps/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    const { message_template, subject } = req.body;
    const updates: string[] = [];
    if (message_template !== undefined)
      updates.push(`message_template = '${(message_template as string).replace(/'/g, "''")}'`);
    if (subject !== undefined)
      updates.push(`subject = ${subject === null ? "NULL" : `'${(subject as string).replace(/'/g, "''")}'`}`);
    if (!updates.length) return res.json({ ok: true });
    // Verify ownership via sequence
    await db.execute(sql.raw(`
      UPDATE follow_up_steps fst
      SET ${updates.join(", ")}
      FROM follow_up_sequences fs
      WHERE fst.id = ${id} AND fst.sequence_id = fs.id AND fs.company_id = ${companyId}
    `));
    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /follow-up/steps/:id:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/follow-up/message-log ───────────────────────────────────────────
router.get("/message-log", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { channel, sequence_type, from_date, to_date, limit = "100", offset = "0" } = req.query;

    const conditions = [`ml.company_id = ${companyId}`];
    if (channel) conditions.push(`ml.channel = '${channel}'`);
    if (sequence_type) conditions.push(`fs.sequence_type = '${sequence_type}'`);
    if (from_date) conditions.push(`ml.sent_at >= '${from_date}'`);
    if (to_date)   conditions.push(`ml.sent_at <= '${to_date} 23:59:59'`);

    const rows = await db.execute(sql.raw(`
      SELECT
        ml.id, ml.sent_at, ml.channel, ml.status,
        ml.recipient_email, ml.recipient_phone,
        ml.sequence_name, ml.step_number, ml.subject,
        ml.client_id,
        COALESCE(c.first_name || ' ' || c.last_name, ml.recipient_email, ml.recipient_phone) AS recipient_name,
        fe.sequence_id,
        fs.sequence_type
      FROM message_log ml
      LEFT JOIN follow_up_enrollments fe ON fe.id = ml.enrollment_id
      LEFT JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
      LEFT JOIN clients c ON c.id = ml.client_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY ml.sent_at DESC
      LIMIT ${parseInt(limit as string)}
      OFFSET ${parseInt(offset as string)}
    `));

    const total = await db.execute(sql.raw(`
      SELECT COUNT(*)::int AS cnt
      FROM message_log ml
      LEFT JOIN follow_up_enrollments fe ON fe.id = ml.enrollment_id
      LEFT JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
      WHERE ${conditions.join(" AND ")}
    `));

    return res.json({ rows: rows.rows, total: (total.rows[0] as any).cnt });
  } catch (err) {
    console.error("GET /follow-up/message-log:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/follow-up/process — manually trigger the cron (owner/admin only) ─
router.post("/process", requireAuth, requireRole("owner", "admin"), async (_req, res) => {
  try {
    await processDueEnrollments();
    return res.json({ ok: true, message: "processDueEnrollments ran" });
  } catch (err) {
    console.error("POST /follow-up/process:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/follow-up/send-one — send ONE enrollment's current touch ────────
// Scoped one-off: sends only the named enrollment's current step (EMAIL via
// Resend, independent of COMMS_ENABLED; SMS is not sent here — needs Twilio
// creds). Never runs the general cron and never touches other enrollments.
router.post("/send-one", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const enrollmentId = parseInt(req.body?.enrollment_id);
    if (!enrollmentId) return res.status(400).json({ error: "enrollment_id required" });
    const stepOverride = req.body?.step_number != null ? parseInt(req.body.step_number) : undefined;
    const result = await sendSingleEnrollmentTouch(companyId, enrollmentId, stepOverride);
    return res.json(result);
  } catch (err: any) {
    console.error("POST /follow-up/send-one:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
});

// ── GET /api/follow-up/comms-gate?company_id= — per-tenant comms gate state ────
// Owner-only diagnostic. Reports, for a company, whether its sends would be
// allowed — separating the global master from the per-tenant gate so we can
// prove tenant isolation (e.g. Schaumburg on, Oak Lawn off → Oak Lawn blocked).
router.get("/comms-gate", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = parseInt(String(req.query.company_id || req.auth!.companyId));
    const { resolveSender } = await import("../lib/comms-sender.js");
    const s = await resolveSender(companyId, null);
    const globalOn = process.env.COMMS_ENABLED === "true";
    return res.json({
      company_id: companyId,
      global_COMMS_ENABLED: globalOn,
      company_comms_enabled: s.company_comms_enabled,
      twilio_enabled: s.enabled,
      resolve_reason: s.reason ?? "ready",
      // Would ANY automatic send to this company be possible right now?
      sends_possible_now: !s.reason,
      // Would this tenant be blocked purely by its own per-tenant gate (independent of the global master)?
      blocked_by_tenant_gate: !s.company_comms_enabled,
    });
  } catch (err: any) {
    console.error("GET /follow-up/comms-gate:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
});

// ── GET /api/follow-up/resend-status — diagnose the deployed Resend key ────────
// Reports which account/domains the deployed RESEND_API_KEY can send from, so we
// can tell whether a from-domain (e.g. phes.io) is actually verified for THIS key.
router.get("/resend-status", requireAuth, requireRole("owner", "admin"), async (_req, res) => {
  try {
    const { validateResend } = await import("../lib/comms-sender.js");
    return res.json(await validateResend());
  } catch (err: any) {
    console.error("GET /follow-up/resend-status:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
});

// ── GET /api/follow-up/email-status?id= — actual Resend delivery status ────────
router.get("/email-status", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ error: "id required" });
    const { getResendEmailStatus } = await import("../lib/comms-sender.js");
    return res.json(await getResendEmailStatus(id));
  } catch (err: any) {
    console.error("GET /follow-up/email-status:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
});

// ── POST /api/follow-up/twilio-check — validate company Twilio creds ───────────
// Lightweight authenticated GET on the Twilio account resource. Token stays
// server-side; returns { authenticated, status, detail }.
router.post("/twilio-check", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { validateTwilioCreds } = await import("../lib/comms-sender.js");
    const result = await validateTwilioCreds(req.auth!.companyId!);
    return res.json(result);
  } catch (err: any) {
    console.error("POST /follow-up/twilio-check:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err?.message });
  }
});

// ── POST /api/follow-up/enroll-quote — enroll a quote manually (owner/admin) ─
router.post("/enroll-quote", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { quote_id, client_id, first_name, email, phone } = req.body;
    if (!quote_id) return res.status(400).json({ error: "quote_id required" });
    await enrollForQuoteSent(companyId, quote_id, client_id ?? null, first_name ?? "", email ?? null, phone ?? null);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/follow-up/enroll-job — enroll a job completion manually ─────────
router.post("/enroll-job", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { job_id, client_id } = req.body;
    if (!job_id || !client_id) return res.status(400).json({ error: "job_id and client_id required" });
    await enrollForJobComplete(companyId, job_id, client_id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/follow-up/stop-quote — stop enrollments for a quote ─────────────
router.post("/stop-quote", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { quote_id, reason } = req.body;
    if (!quote_id) return res.status(400).json({ error: "quote_id required" });
    await stopEnrollmentsForQuote(quote_id, reason ?? "manual");
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
