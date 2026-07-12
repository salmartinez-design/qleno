import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { phone10, recordOutboundSms, getThread, markThreadRead, matchContact } from "../lib/sms-store.js";
import multer from "multer";
import crypto from "node:crypto";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
        ) AS name,
        -- [scheduled-visibility 2026-07-11] Flag threads with a pending scheduled
        -- reply so a teammate scanning the inbox sees it's already handled (and by
        -- whom) and doesn't message the customer again.
        (SELECT count(*)::int FROM scheduled_sms ss
           WHERE ss.company_id = ${companyId} AND ss.contact_phone = s.contact_phone AND ss.status = 'pending') AS scheduled_count,
        (SELECT ss.scheduled_for FROM scheduled_sms ss
           WHERE ss.company_id = ${companyId} AND ss.contact_phone = s.contact_phone AND ss.status = 'pending'
           ORDER BY ss.scheduled_for ASC LIMIT 1) AS next_scheduled_for,
        (SELECT NULLIF(trim(u.first_name||' '||coalesce(u.last_name,'')),'')
           FROM scheduled_sms ss LEFT JOIN users u ON u.id = ss.created_by
           WHERE ss.company_id = ${companyId} AND ss.contact_phone = s.contact_phone AND ss.status = 'pending'
           ORDER BY ss.scheduled_for ASC LIMIT 1) AS scheduled_by,
        -- [drip-reply-tag 2026-07-12] The latest message on this thread is an
        -- inbound reply that followed a drip touch (within 5 days) — so the inbox
        -- flags "replied to drip" and the office knows why (e.g. a bare STOP)
        -- without opening the lead.
        (s.last_dir = 'inbound' AND EXISTS (
          SELECT 1 FROM message_log ml
            JOIN follow_up_enrollments fe ON fe.id = ml.enrollment_id
            JOIN leads l ON l.id = fe.lead_id
           WHERE fe.company_id = ${companyId}
             AND right(regexp_replace(coalesce(l.phone,''),'\\D','','g'),10) = s.contact_phone
             AND ml.sent_at IS NOT NULL AND ml.sent_at <= s.last_at
             AND ml.sent_at >= s.last_at - interval '5 days'
        )) AS last_inbound_drip
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

// ── GET /api/sms/thread?phone=|client_id=|lead_id= — full thread ───────────────
// Does NOT mark messages read — staff must do that manually via POST /mark-read.
router.get("/thread", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const phone = req.query.phone ? String(req.query.phone) : null;
    const clientId = req.query.client_id ? parseInt(String(req.query.client_id)) : null;
    const leadId = req.query.lead_id ? parseInt(String(req.query.lead_id)) : null;
    const messages = await getThread(companyId, { clientId, leadId, phone });
    const cp = phone10(phone || (messages[0] as any)?.contact_phone || "");

    // [drip-reply-tag 2026-07-12] Flag inbound replies that arrived in response to
    // a lead drip, so the office sees WHY someone texted (e.g. STOP) without
    // opening the lead. A reply is drip-related when a drip touch (message_log)
    // went to the same lead within 5 days before it. Read-only; no schema change.
    try {
      let dripLeadId = leadId ?? (messages as any[]).find(m => m.lead_id)?.lead_id ?? null;
      if (!dripLeadId && cp) {
        const lr = await db.execute(sql`
          SELECT id FROM leads WHERE company_id = ${companyId}
            AND right(regexp_replace(coalesce(phone,''),'\\D','','g'),10) = ${cp}
          ORDER BY id DESC LIMIT 1`);
        dripLeadId = (lr.rows[0] as any)?.id ?? null;
      }
      if (dripLeadId) {
        const touches = await db.execute(sql`
          SELECT ml.sent_at, COALESCE(fs.name, fs.sequence_type::text) AS campaign, ml.step_number
            FROM message_log ml
            JOIN follow_up_enrollments fe ON fe.id = ml.enrollment_id
            LEFT JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
           WHERE fe.company_id = ${companyId} AND fe.lead_id = ${dripLeadId} AND ml.sent_at IS NOT NULL
           ORDER BY ml.sent_at ASC`);
        const trows = touches.rows as any[];
        if (trows.length) {
          const WINDOW = 5 * 24 * 3600 * 1000;
          for (const m of messages as any[]) {
            if (m.direction !== "inbound" || !m.created_at) continue;
            const t = new Date(m.created_at).getTime();
            let best: any = null;
            for (const tr of trows) {
              const ts = new Date(tr.sent_at).getTime();
              if (ts <= t && t - ts <= WINDOW) best = tr; // most recent preceding touch
            }
            if (best) { m.drip_related = true; m.drip_campaign = best.campaign; m.drip_step = best.step_number; }
          }
        }
      }
    } catch (e) { console.warn("[sms/thread] drip-tag skipped:", (e as any)?.message ?? e); }

    return res.json({ contact_phone: cp, messages });
  } catch (err) {
    console.error("GET /sms/thread:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/sms/mark-read — manually mark a thread's inbound messages read ──
router.post("/mark-read", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const phone = String(req.body?.phone ?? "");
    if (!phone) return res.status(400).json({ error: "phone required" });
    await markThreadRead(companyId, phone);
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /sms/mark-read:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/sms/send — reply / send in thread (supports MMS via media_urls) ──
router.post("/send", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { message, media_urls } = req.body || {};
    let { contact_phone, client_id, lead_id } = req.body || {};
    const bodyText = typeof message === "string" ? message : "";
    const mediaKeys: string[] = Array.isArray(media_urls) ? media_urls.filter(Boolean) : [];
    if (!bodyText && mediaKeys.length === 0) return res.status(400).json({ error: "message or media required" });

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

    if (client_id == null && lead_id == null) {
      const m = await matchContact(companyId, toPhone);
      client_id = m.client_id; lead_id = m.lead_id;
    }

    // For MMS, generate a short-lived signed URL for each media key so Twilio
    // can fetch the object. Twilio fetches within seconds of sending.
    let twilioMediaUrls: string[] = [];
    if (mediaKeys.length > 0) {
      try {
        const { r2Configured, r2SignedGetUrl } = await import("../lib/r2.js");
        if (r2Configured()) {
          twilioMediaUrls = await Promise.all(mediaKeys.map(k => r2SignedGetUrl(k, 3600)));
        }
      } catch (e) { console.warn("[sms/send] media sign error:", e); }
    }

    let twilioResult: any = null, fromNumber: string | null = null, status = "suppressed", reason: string | null = null;
    try {
      const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
      const sender = await resolveSender(companyId, null);
      fromNumber = sender.from_number;
      if (sender.reason) { reason = sender.reason; }
      else {
        twilioResult = await sendSmsVia(sender, toPhone, bodyText, twilioMediaUrls.length ? twilioMediaUrls : undefined);
        status = "sent";
      }
    } catch (e: any) { status = "failed"; reason = e?.message || "send_error"; }

    const { id } = await recordOutboundSms({
      companyId, toRaw: toPhone, fromNumber, body: bodyText,
      providerId: twilioResult?.sid ?? null, sentBy: req.auth!.userId,
      clientId: client_id ?? null, leadId: lead_id ?? null, status,
      mediaUrls: mediaKeys.length ? mediaKeys : null,
    });
    await markThreadRead(companyId, toPhone);
    return res.status(201).json({ id, status, reason, sent: status === "sent", twilio: twilioResult });
  } catch (err) {
    console.error("POST /sms/send:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/sms/contact-search?q= — recipient picker for "New message" ────────
// Searches the tenant's clients AND leads by name or phone. Returns a unified
// list ({ type, id, name, phone }) so staff can start a conversation with either.
router.get("/contact-search", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const raw = String(req.query.q ?? "").trim();
    if (raw.length < 2) return res.json([]);
    const like = `%${raw.toLowerCase()}%`;
    const digits = raw.replace(/\D/g, "");
    const phoneLike = digits.length >= 3 ? `%${digits}%` : null;
    const clients = await db.execute(sql`
      SELECT id, NULLIF(trim(first_name||' '||coalesce(last_name,'')),'') AS name, phone
        FROM clients
       WHERE company_id = ${companyId} AND phone IS NOT NULL
         AND (lower(coalesce(first_name,'')||' '||coalesce(last_name,'')) LIKE ${like}
              ${phoneLike ? sql`OR regexp_replace(coalesce(phone,''),'\\D','','g') LIKE ${phoneLike}` : sql``})
       ORDER BY name LIMIT 8`);
    const leads = await db.execute(sql`
      SELECT id, NULLIF(trim(first_name||' '||coalesce(last_name,'')),'') AS name, phone
        FROM leads
       WHERE company_id = ${companyId} AND phone IS NOT NULL
         AND (lower(coalesce(first_name,'')||' '||coalesce(last_name,'')) LIKE ${like}
              ${phoneLike ? sql`OR regexp_replace(coalesce(phone,''),'\\D','','g') LIKE ${phoneLike}` : sql``})
       ORDER BY name LIMIT 8`);
    const out = [
      ...(clients.rows as any[]).map(r => ({ type: "client", id: r.id, name: r.name, phone: r.phone })),
      ...(leads.rows as any[]).map(r => ({ type: "lead", id: r.id, name: r.name, phone: r.phone })),
    ];
    return res.json(out);
  } catch (err) {
    console.error("GET /sms/contact-search:", err);
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

// ── POST /api/sms/upload-media — upload a file to R2 for MMS attachment ────────
// Accepts multipart/form-data with a single "file" field. Returns { key, url }
// where key is the R2 object key to pass in media_urls when sending, and url is
// a 1-hour signed URL for previewing the upload.
router.post("/upload-media", requireAuth, requireRole("owner", "admin", "office"), upload.single("file"), async (req, res) => {
  try {
    const { r2Configured, r2Upload, r2SignedGetUrl } = await import("../lib/r2.js");
    if (!r2Configured()) return res.status(503).json({ error: "r2_not_configured", message: "R2 storage is not configured." });
    if (!req.file) return res.status(400).json({ error: "file required" });

    const contentType = req.file.mimetype || "application/octet-stream";
    const ext = (contentType.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
    const rand = crypto.randomBytes(12).toString("hex");
    const companyId = req.auth!.companyId;
    const key = `sms-media/${companyId}/${rand}.${ext}`;

    await r2Upload(key, req.file.buffer, contentType);
    const url = await r2SignedGetUrl(key, 3600);
    return res.status(201).json({ key, url, content_type: contentType });
  } catch (err) {
    console.error("POST /sms/upload-media:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/sms/media/:msgId/:idx — serve media for a message ──────────────────
// Returns a 302 redirect to a signed R2 URL. The idx is the 0-based index into
// media_urls. Auth required (Bearer token) — the img/video tag in the UI should
// use a blob URL obtained via fetch().
router.get("/media/:msgId/:idx", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const msgId = parseInt(req.params.msgId);
    const idx = parseInt(req.params.idx) || 0;
    if (isNaN(msgId)) return res.status(400).json({ error: "invalid msgId" });

    const r = await db.execute(sql`
      SELECT media_urls FROM sms_messages WHERE id = ${msgId} AND company_id = ${companyId} LIMIT 1`);
    const row = r.rows[0] as any;
    if (!row) return res.status(404).json({ error: "not found" });
    const urls: string[] = Array.isArray(row.media_urls) ? row.media_urls : [];
    if (idx >= urls.length) return res.status(404).json({ error: "media index out of range" });

    const key = urls[idx];
    const { r2Configured, r2SignedGetUrl } = await import("../lib/r2.js");
    if (!r2Configured()) return res.status(503).json({ error: "r2_not_configured" });

    // Proxy the content through the server instead of redirecting — browsers block
    // cross-origin redirects from authenticated fetches (R2 has no CORS for app.qleno.com).
    const signedUrl = await r2SignedGetUrl(key, 300);
    const upstream = await fetch(signedUrl);
    if (!upstream.ok) return res.status(502).json({ error: "media_fetch_failed" });

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const ext = key.split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = {
      "3gpp": "video/3gpp", "3gp": "video/3gpp", "mp4": "video/mp4",
      "mov": "video/quicktime", "webm": "video/webm",
    };
    res.setHeader("Content-Type", mimeMap[ext] ?? contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    console.error("GET /sms/media:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── POST /api/sms/schedule — create a future-dated message ──────────────────────
router.post("/schedule", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { message, media_urls, scheduled_for } = req.body || {};
    let { contact_phone, client_id, lead_id } = req.body || {};

    const bodyText = typeof message === "string" ? message : "";
    const mediaKeys: string[] = Array.isArray(media_urls) ? media_urls.filter(Boolean) : [];
    if (!bodyText && mediaKeys.length === 0) return res.status(400).json({ error: "message or media required" });
    if (!scheduled_for) return res.status(400).json({ error: "scheduled_for required" });

    const scheduledAt = new Date(scheduled_for);
    if (isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) {
      return res.status(400).json({ error: "scheduled_for must be a future datetime" });
    }

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

    if (client_id == null && lead_id == null) {
      const m = await matchContact(companyId, toPhone);
      client_id = m.client_id; lead_id = m.lead_id;
    }

    const cp = phone10(toPhone);
    const mediaPg = mediaKeys.length > 0
      ? sql`ARRAY[${sql.join(mediaKeys.map(u => sql`${u}`), sql`, `)}]::text[]`
      : sql`NULL`;

    const r = await db.execute(sql`
      INSERT INTO scheduled_sms
        (company_id, contact_phone, client_id, lead_id, message, media_urls, scheduled_for, status, created_by)
      VALUES
        (${companyId}, ${cp}, ${client_id ?? null}, ${lead_id ?? null}, ${bodyText},
         ${mediaPg}, ${scheduledAt.toISOString()}, 'pending', ${req.auth!.userId})
      RETURNING id`);
    const id = Number((r.rows[0] as any)?.id);
    return res.status(201).json({ id, scheduled_for: scheduledAt.toISOString() });
  } catch (err) {
    console.error("POST /sms/schedule:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/sms/scheduled — list pending scheduled messages for a thread ────────
router.get("/scheduled", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const phone = req.query.phone ? phone10(String(req.query.phone)) : null;
    const clientId = req.query.client_id ? parseInt(String(req.query.client_id)) : null;
    const leadId = req.query.lead_id ? parseInt(String(req.query.lead_id)) : null;

    let where = sql`company_id = ${companyId} AND status = 'pending'`;
    if (phone) where = sql`${where} AND contact_phone = ${phone}`;
    else if (clientId) where = sql`${where} AND client_id = ${clientId}`;
    else if (leadId) where = sql`${where} AND lead_id = ${leadId}`;

    const r = await db.execute(sql`
      SELECT id, contact_phone, client_id, lead_id, message, media_urls, scheduled_for, status, created_at, created_by,
        -- [scheduled-visibility 2026-07-11] Who scheduled it, so the thread shows
        -- "Scheduled by <name>" and teammates know it's already handled.
        (SELECT NULLIF(trim(u.first_name||' '||coalesce(u.last_name,'')),'')
           FROM users u WHERE u.id = scheduled_sms.created_by) AS scheduled_by
        FROM scheduled_sms
       WHERE ${where}
       ORDER BY scheduled_for ASC`);
    return res.json(r.rows);
  } catch (err) {
    console.error("GET /sms/scheduled:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── DELETE /api/sms/scheduled/:id — cancel a scheduled message ──────────────────
router.delete("/scheduled/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "invalid id" });

    const r = await db.execute(sql`
      UPDATE scheduled_sms SET status = 'cancelled'
       WHERE id = ${id} AND company_id = ${companyId} AND status = 'pending'
      RETURNING id`);
    if (!r.rows[0]) return res.status(404).json({ error: "not found or already sent" });
    return res.json({ cancelled: true });
  } catch (err) {
    console.error("DELETE /sms/scheduled:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
