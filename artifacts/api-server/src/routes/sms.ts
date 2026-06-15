import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { phone10, recordOutboundSms, getThread, markThreadRead, matchContact } from "../lib/sms-store.js";

const router = Router();

// ── GET /api/sms/conversations?q= — tenant-scoped inbox ────────────────────────
// One row per contact phone: latest message, unread count, resolved name +
// client/lead linkage. Most-recent first. Optional search by name or number.
router.get("/conversations", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const q = String(req.query.q ?? "").trim();
    const rows = await db.execute(sql`
      SELECT s.contact_phone, s.last_at, s.last_body, s.last_dir, s.unread,
        COALESCE(s.client_id, (SELECT c.id FROM clients c WHERE c.company_id = ${companyId}
            AND right(regexp_replace(coalesce(c.phone,''),'\\D','','g'),10) = s.contact_phone LIMIT 1)) AS client_id,
        COALESCE(s.lead_id, (SELECT l.id FROM leads l WHERE l.company_id = ${companyId}
            AND right(regexp_replace(coalesce(l.phone,''),'\\D','','g'),10) = s.contact_phone LIMIT 1)) AS lead_id,
        COALESCE(
          (SELECT NULLIF(trim(c.first_name||' '||coalesce(c.last_name,'')),'') FROM clients c WHERE c.id = s.client_id),
          (SELECT NULLIF(trim(l.first_name||' '||coalesce(l.last_name,'')),'') FROM leads l WHERE l.id = s.lead_id),
          (SELECT NULLIF(trim(c.first_name||' '||coalesce(c.last_name,'')),'') FROM clients c WHERE c.company_id = ${companyId}
              AND right(regexp_replace(coalesce(c.phone,''),'\\D','','g'),10) = s.contact_phone LIMIT 1),
          (SELECT NULLIF(trim(l.first_name||' '||coalesce(l.last_name,'')),'') FROM leads l WHERE l.company_id = ${companyId}
              AND right(regexp_replace(coalesce(l.phone,''),'\\D','','g'),10) = s.contact_phone LIMIT 1)
        ) AS name
      FROM (
        SELECT contact_phone, max(created_at) AS last_at,
          (array_agg(body ORDER BY created_at DESC))[1] AS last_body,
          (array_agg(direction ORDER BY created_at DESC))[1] AS last_dir,
          max(client_id) AS client_id, max(lead_id) AS lead_id,
          count(*) FILTER (WHERE direction = 'inbound' AND read_at IS NULL) AS unread
        FROM sms_messages WHERE company_id = ${companyId}
        GROUP BY contact_phone
      ) s
      ORDER BY s.last_at DESC
      LIMIT 500`);
    let list = rows.rows as any[];
    if (q) {
      const qDigits = q.replace(/\D/g, "");
      const qLower = q.toLowerCase();
      list = list.filter(r =>
        (r.name && String(r.name).toLowerCase().includes(qLower)) ||
        (qDigits && String(r.contact_phone).includes(qDigits)));
    }
    return res.json(list);
  } catch (err) {
    console.error("GET /sms/conversations:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/sms/thread?phone=|client_id=|lead_id= — full thread, marks read ───
router.get("/thread", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const phone = req.query.phone ? String(req.query.phone) : null;
    const clientId = req.query.client_id ? parseInt(String(req.query.client_id)) : null;
    const leadId = req.query.lead_id ? parseInt(String(req.query.lead_id)) : null;
    const messages = await getThread(companyId, { clientId, leadId, phone });
    // Mark inbound read for the thread's contact phone.
    const cp = phone10(phone || (messages[0] as any)?.contact_phone || "");
    if (cp) await markThreadRead(companyId, cp);
    return res.json({ contact_phone: cp, messages });
  } catch (err) {
    console.error("GET /sms/thread:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/sms/send — reply / send in thread ────────────────────────────────
// Resolves the recipient (explicit phone, or a client/lead's number), sends via
// the tenant's own number (resolveSender — full comms-gate ladder), persists the
// outbound into sms_messages, and marks the thread read. Respects the gate: when
// suppressed, nothing is sent and the row is logged with status='suppressed'.
router.post("/send", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { message } = req.body || {};
    let { contact_phone, client_id, lead_id } = req.body || {};
    if (!message || typeof message !== "string") return res.status(400).json({ error: "message required" });

    // Resolve recipient phone from client/lead if not given explicitly.
    let toPhone: string | null = contact_phone || null;
    if (!toPhone && client_id) {
      const r = await db.execute(sql`SELECT phone FROM clients WHERE id = ${client_id} AND company_id = ${companyId} LIMIT 1`);
      toPhone = (r.rows[0] as any)?.phone ?? null;
    }
    if (!toPhone && lead_id) {
      const r = await db.execute(sql`SELECT phone FROM leads WHERE id = ${lead_id} AND company_id = ${companyId} LIMIT 1`);
      toPhone = (r.rows[0] as any)?.phone ?? null;
    }
    if (!toPhone) return res.status(400).json({ error: "No recipient phone" });

    // Link to a contact if not provided (so the message threads correctly).
    if (client_id == null && lead_id == null) {
      const m = await matchContact(companyId, toPhone);
      client_id = m.client_id; lead_id = m.lead_id;
    }

    let twilioResult: any = null, fromNumber: string | null = null, status = "suppressed", reason: string | null = null;
    try {
      const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
      const sender = await resolveSender(companyId, null);
      fromNumber = sender.from_number;
      if (sender.reason) { reason = sender.reason; }
      else { twilioResult = await sendSmsVia(sender, toPhone, message); status = "sent"; }
    } catch (e: any) { status = "failed"; reason = e?.message || "send_error"; }

    const { id } = await recordOutboundSms({
      companyId, toRaw: toPhone, fromNumber, body: message,
      providerId: twilioResult?.sid ?? null, sentBy: req.auth!.userId,
      clientId: client_id ?? null, leadId: lead_id ?? null, status,
    });
    await markThreadRead(companyId, toPhone);
    return res.status(201).json({ id, status, reason, sent: status === "sent", twilio: twilioResult });
  } catch (err) {
    console.error("POST /sms/send:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/sms/unread-count — for a nav badge ────────────────────────────────
router.get("/unread-count", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const r = await db.execute(sql`
      SELECT count(*)::int AS n FROM sms_messages
       WHERE company_id = ${req.auth!.companyId} AND direction = 'inbound' AND read_at IS NULL`);
    return res.json({ unread: (r.rows[0] as any)?.n ?? 0 });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
