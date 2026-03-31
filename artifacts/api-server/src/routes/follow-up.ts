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

const router = Router();

// ── GET /api/follow-up/sequences ──────────────────────────────────────────────
router.get("/sequences", requireAuth, requireRole("owner", "admin"), async (req, res) => {
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

export default router;
