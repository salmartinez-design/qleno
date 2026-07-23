import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { phone10, recordOutboundSms, getThread, markThreadRead, matchContact } from "../lib/sms-store.js";
import { notifyUser } from "../lib/notify.js";
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
    let messages = await getThread(companyId, { clientId, leadId, phone }) as any[];
    const cp = phone10(phone || (messages[0] as any)?.contact_phone || "");

    // [drip-in-thread 2026-07-12] (1) Flag inbound replies that arrived in
    // response to a lead drip, and (2) fold the actual drip SMS touches INTO the
    // thread so the office sees WHAT the customer is replying to — not just that
    // it's a drip reply — without opening the lead (Sal, on Mildred Spears'
    // "Yes"). Drip sends live in message_log, never in sms_messages, so this is a
    // read-only merge. SMS only: email touches stay on the lead (they're HTML and
    // the office said they'll open the lead for those).
    try {
      let dripLeadId = leadId ?? messages.find(m => m.lead_id)?.lead_id ?? null;
      if (!dripLeadId && cp) {
        const lr = await db.execute(sql`
          SELECT id FROM leads WHERE company_id = ${companyId}
            AND right(regexp_replace(coalesce(phone,''),'\\D','','g'),10) = ${cp}
          ORDER BY id DESC LIMIT 1`);
        dripLeadId = (lr.rows[0] as any)?.id ?? null;
      }
      if (dripLeadId) {
        const touches = await db.execute(sql`
          SELECT ml.id, ml.body, ml.channel::text AS channel,
                 -- [drip-in-thread 2026-07-12] sent_at is timestamptz; return it as
                 -- a clean UTC ISO string ("…T…Z") so the thread's time formatter
                 -- renders "8:36 PM" like every other bubble instead of the raw
                 -- "2026-07-13 01:36:13.246233+00" Postgres text.
                 to_char(ml.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sent_at,
                 COALESCE(fs.name, fs.sequence_type::text) AS campaign, ml.step_number
            FROM message_log ml
            JOIN follow_up_enrollments fe ON fe.id = ml.enrollment_id
            LEFT JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
           WHERE fe.company_id = ${companyId} AND fe.lead_id = ${dripLeadId} AND ml.sent_at IS NOT NULL
           ORDER BY ml.sent_at ASC`);
        const trows = touches.rows as any[];
        if (trows.length) {
          const WINDOW = 5 * 24 * 3600 * 1000;
          // (1) tag inbound replies with the drip that prompted them
          for (const m of messages) {
            if (m.direction !== "inbound" || !m.created_at) continue;
            const t = new Date(m.created_at).getTime();
            let best: any = null;
            for (const tr of trows) {
              const ts = new Date(tr.sent_at).getTime();
              if (ts <= t && t - ts <= WINDOW) best = tr; // most recent preceding touch
            }
            if (best) { m.drip_related = true; m.drip_campaign = best.campaign; m.drip_step = best.step_number; }
          }
          // (2) fold drip SMS touches into the thread as outbound messages.
          // Skip any already present in sms_messages (same body, minute-level) so
          // a future recording path can't double them.
          const seen = new Set(
            messages.filter(m => m.direction === "outbound")
              .map(m => `${String(m.body || "").trim()}|${m.created_at ? new Date(m.created_at).toISOString().slice(0, 16) : ""}`));
          const dripMsgs = trows
            .filter(tr => String(tr.channel).toLowerCase() === "sms")
            .filter(tr => !seen.has(`${String(tr.body || "").trim()}|${tr.sent_at ? new Date(tr.sent_at).toISOString().slice(0, 16) : ""}`))
            .map(tr => ({
              id: `drip-${tr.id}`, source: "drip", direction: "outbound",
              body: tr.body, from_number: null, to_number: cp || null,
              status: "sent", read_at: null, created_at: tr.sent_at,
              media_urls: null, sent_by_name: null,
              drip_step: tr.step_number, drip_campaign: tr.campaign,
            }));
          if (dripMsgs.length) {
            messages = [...messages, ...dripMsgs].sort(
              (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
          }
        }
      }
    } catch (e) { console.warn("[sms/thread] drip-merge skipped:", (e as any)?.message ?? e); }

    // [sms-thread-notes 2026-07-22] Fold internal notes into the thread, read-only,
    // exactly like the drip merge above. Notes live in the contact's own log
    // (communication_log for a client, lead_activity_log for a lead) — see
    // POST /notes — so this reads from both and sorts them in by time.
    try {
      if (cp) {
        const { clientId: noteClientId, leadId: noteLeadId } = await resolveThreadContact(companyId!, cp);
        const notes: any[] = [];
        if (noteClientId) {
          const r = await db.execute(sql`
            SELECT cl.id, cl.body, cl.summary, cl.sent_by,
                   to_char(cl.logged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
                   NULLIF(trim(u.first_name||' '||coalesce(u.last_name,'')),'') AS author,
                   cl.logged_by
              FROM communication_log cl
              LEFT JOIN users u ON u.id = cl.logged_by
             WHERE cl.company_id = ${companyId} AND cl.customer_id = ${noteClientId} AND cl.channel = 'note'
             ORDER BY cl.logged_at ASC`);
          for (const n of r.rows as any[]) {
            notes.push({ id: `note-${n.id}`, source: "note", direction: "internal",
              body: n.body || n.summary, created_at: n.at,
              author: n.author || n.sent_by || null, author_id: n.logged_by ?? null });
          }
        } else if (noteLeadId) {
          const r = await db.execute(sql`
            SELECT a.id, a.note,
                   to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
                   NULLIF(trim(u.first_name||' '||coalesce(u.last_name,'')),'') AS author,
                   a.performed_by
              FROM lead_activity_log a
              LEFT JOIN users u ON u.id = a.performed_by
             WHERE a.company_id = ${companyId} AND a.lead_id = ${noteLeadId}
               AND a.action_type = 'note_added' AND a.note IS NOT NULL
             ORDER BY a.created_at ASC`);
          for (const n of r.rows as any[]) {
            notes.push({ id: `leadnote-${n.id}`, source: "note", direction: "internal",
              body: n.note, created_at: n.at,
              author: n.author || null, author_id: n.performed_by ?? null });
          }
        }
        if (notes.length) {
          messages = [...messages, ...notes].sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        }
      }
    } catch (e) { console.warn("[sms/thread] note-merge skipped:", (e as any)?.message ?? e); }

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

// ── POST /api/sms/mark-unread — flag a thread back to unread ──────────────────
// [sms-mark-unread 2026-07-22] The counterpart to mark-read. Since [auto-mark-read
// 2026-07-19] opening a thread clears it, there was no way to say "I read this but
// it still needs work" — the thread just vanished from the unread count. Marks the
// most recent INBOUND message unread (not all of them): the unread badge is a
// "needs attention" flag, and re-flagging a whole history would inflate the count
// to something meaningless like 47.
router.post("/mark-unread", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const phone = phone10(String(req.body?.phone ?? ""));
    if (!phone) return res.status(400).json({ error: "phone required" });
    const r = await db.execute(sql`
      UPDATE sms_messages SET read_at = NULL
       WHERE id = (
         SELECT id FROM sms_messages
          WHERE company_id = ${companyId} AND contact_phone = ${phone} AND direction = 'inbound'
          ORDER BY created_at DESC LIMIT 1)
      RETURNING id`);
    // No inbound message on this thread (outbound-only conversation) — there is
    // nothing to mark unread. Say so rather than reporting a silent success.
    if (!r.rows.length) return res.status(409).json({ error: "No inbound message on this thread to mark unread" });
    return res.json({ ok: true, unread: 1 });
  } catch (err) {
    console.error("POST /sms/mark-unread:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Notes on a conversation ───────────────────────────────────────────────────
// [sms-thread-notes 2026-07-22] Staff-only notes attached to a customer thread
// (Sal, on GHL: "a way to add notes to her SMS thread ... for internal notes").
// NOTHING here sends anything to the customer — no Twilio, no sendNotification.
//
// Storage: a note is one communication_log row, channel='note',
// direction='internal'. That is deliberate — the client profile's Communication
// log already unions communication_log by customer_id (clients.ts
// /:id/messages), so a client note cascades there with no query change. For a
// LEAD-only thread (23% of Phes threads) there is no communication_log linkage,
// so the note goes to lead_activity_log instead, which is what the lead panel's
// feed already reads. One note, one row, in whichever log that contact's profile
// actually renders.
async function resolveThreadContact(companyId: number, phone: string) {
  const r = await db.execute(sql`
    SELECT
      (SELECT c.id FROM clients c WHERE c.company_id = ${companyId}
         AND right(regexp_replace(coalesce(c.phone,''),'\\D','','g'),10) = ${phone} ORDER BY c.id LIMIT 1) AS client_id,
      (SELECT l.id FROM leads l WHERE l.company_id = ${companyId}
         AND right(regexp_replace(coalesce(l.phone,''),'\\D','','g'),10) = ${phone} ORDER BY l.id DESC LIMIT 1) AS lead_id`);
  const row = r.rows[0] as any;
  return { clientId: row?.client_id ?? null, leadId: row?.lead_id ?? null };
}

// [note-mentions 2026-07-23] Who can be @-mentioned on a note. Office staff
// only — a note is an internal office thread, and techs have no way to open a
// customer conversation, so tagging one would fire a bell into a dead end.
router.get("/notes/mentionable", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const rows = await db.execute(sql`
      SELECT id, NULLIF(trim(first_name||' '||coalesce(last_name,'')),'') AS name, role
        FROM users
       WHERE company_id = ${companyId} AND is_active = true
         AND role IN ('owner','admin','office','super_admin')
       ORDER BY first_name, last_name`);
    return res.json({ users: (rows.rows as any[]).filter(u => u.name) });
  } catch (err) {
    console.error("GET /sms/notes/mentionable:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/notes", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId;
    const phone = phone10(String(req.body?.phone ?? ""));
    const body = String(req.body?.body ?? "").trim();
    if (!phone) return res.status(400).json({ error: "phone required" });
    if (!body) return res.status(400).json({ error: "body required" });

    // [note-mentions 2026-07-23] Who to pull into this note (Sal: "add the
    // ability to add @ ... in case i need to bring in another teamate").
    // The CLIENT sends explicit user ids alongside the @Name text rather than
    // the server re-parsing names out of the body — staff names contain spaces
    // and repeat ("Diana" twice), so name-matching would silently notify the
    // wrong person or nobody. The text keeps the @Name purely for reading.
    const mentionIds = Array.isArray(req.body?.mention_user_ids)
      ? [...new Set((req.body.mention_user_ids as any[])
          .map(n => parseInt(String(n))).filter(n => Number.isInteger(n)))]
      : [];

    const ur = await db.execute(sql`
      SELECT NULLIF(trim(first_name||' '||coalesce(last_name,'')),'') AS name FROM users WHERE id = ${userId} LIMIT 1`);
    const author = (ur.rows[0] as any)?.name || null;

    // The thread may resolve to both (13 Phes threads do). Prefer the CLIENT —
    // that's the "account" the note should live on once someone has booked.
    const { clientId, leadId } = await resolveThreadContact(companyId, phone);

    // [note-mentions 2026-07-23] Ring the bell for everyone tagged. Scoped to
    // ACTIVE users in THIS company so a stale id from the client can't notify
    // someone in another tenant, and self-mentions are dropped (no point
    // alerting yourself about a note you just wrote).
    //
    // [note-mention-500 2026-07-23] The whole body is wrapped so a mention
    // failure can NEVER fail the save. It previously threw out to the route's
    // catch AFTER the note row was already inserted, so the note was written but
    // the office was told "Note not saved" — inviting a retry and a duplicate.
    // The note is the thing that matters; a missed bell is recoverable, a lost
    // (or doubled) note is not.
    const notifyMentions = async (contactName: string | null) => {
      try {
      if (!mentionIds.length) return;
      // Inlined as a literal IN list, NOT a bound array. `= ANY(${arr}::int[])`
      // through the sql template failed to bind and 500'd every mention. Safe
      // to inline: mentionIds is already parseInt + Number.isInteger filtered
      // above, so nothing but digits can reach here.
      const idList = sql.raw(mentionIds.join(","));
      const rows = await db.execute(sql`
        SELECT id, NULLIF(trim(first_name||' '||coalesce(last_name,'')),'') AS name
          FROM users
         WHERE company_id = ${companyId} AND is_active = true
           AND id IN (${idList}) AND id <> ${userId}`);
      const who = contactName || `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`;
      for (const u of rows.rows as any[]) {
        await notifyUser({
          companyId,
          userId: Number(u.id),
          // Unmapped in TYPE_TO_CATEGORY on purpose → always delivers in-app
          // (the bell Sal asked for) and never emails. Add a category later if
          // people want mentions by email too.
          type: "note_mention",
          title: `${author || "A teammate"} mentioned you`,
          body: body.length > 140 ? body.slice(0, 137) + "…" : body,
          link: `/messages?phone=${phone}`,
          meta: { kind: "sms_note", phone, client_id: clientId, lead_id: leadId, contact: who },
        });
      }
      } catch (e) {
        console.error("[sms/notes] mention notify failed (note still saved):", (e as any)?.message ?? e);
      }
    };

    if (clientId) {
      const r = await db.execute(sql`
        INSERT INTO communication_log
          (company_id, customer_id, direction, channel, summary, body,
           source, sent_by, recipient, logged_by, delivery_status)
        VALUES
          (${companyId}, ${clientId}, 'internal', 'note', ${body}, ${body},
           'staff', ${author}, ${phone}, ${userId}, 'logged')
        RETURNING id, logged_at`);
      const row = r.rows[0] as any;
      const cn = await db.execute(sql`
        SELECT NULLIF(trim(first_name||' '||coalesce(last_name,'')),'') AS n FROM clients WHERE id = ${clientId} LIMIT 1`);
      await notifyMentions((cn.rows[0] as any)?.n ?? null);
      return res.status(201).json({
        id: `note-${row.id}`, note_id: row.id, store: "communication_log",
        client_id: clientId, lead_id: leadId, body, author, created_at: row.logged_at,
        mentioned: mentionIds.length,
      });
    }

    if (leadId) {
      const r = await db.execute(sql`
        INSERT INTO lead_activity_log (lead_id, company_id, action_type, note, performed_by, created_at)
        VALUES (${leadId}, ${companyId}, 'note_added', ${body}, ${userId}, NOW())
        RETURNING id, created_at`);
      const row = r.rows[0] as any;
      const ln = await db.execute(sql`
        SELECT NULLIF(trim(first_name||' '||coalesce(last_name,'')),'') AS n FROM leads WHERE id = ${leadId} LIMIT 1`);
      await notifyMentions((ln.rows[0] as any)?.n ?? null);
      return res.status(201).json({
        id: `leadnote-${row.id}`, note_id: row.id, store: "lead_activity_log",
        client_id: null, lead_id: leadId, body, author, created_at: row.created_at,
        mentioned: mentionIds.length,
      });
    }

    // Unknown number with no client and no lead — there is no profile to cascade
    // to, so refuse rather than writing an orphan row nothing will ever surface.
    return res.status(409).json({ error: "This number isn't linked to a client or lead yet, so there's no profile to save the note to." });
  } catch (err) {
    console.error("POST /sms/notes:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE /api/sms/notes/:id — id is the prefixed thread id ("note-12"/"leadnote-9")
// so the client can delete whatever it rendered without tracking which store the
// note came from. Author-or-owner/admin only; notes are an audit trail, so a
// teammate can't quietly remove someone else's.
router.delete("/notes/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId;
    const privileged = req.auth!.role === "owner" || req.auth!.role === "admin";
    const raw = String(req.params.id);
    const m = /^(note|leadnote)-(\d+)$/.exec(raw);
    if (!m) return res.status(400).json({ error: "bad note id" });
    const id = parseInt(m[2]);

    if (m[1] === "note") {
      const r = await db.execute(sql`
        DELETE FROM communication_log
         WHERE id = ${id} AND company_id = ${companyId} AND channel = 'note'
           AND (${privileged} OR logged_by = ${userId})
        RETURNING id`);
      if (!r.rows.length) return res.status(404).json({ error: "Note not found, or not yours to delete" });
    } else {
      const r = await db.execute(sql`
        DELETE FROM lead_activity_log
         WHERE id = ${id} AND company_id = ${companyId} AND action_type = 'note_added'
           AND (${privileged} OR performed_by = ${userId})
        RETURNING id`);
      if (!r.rows.length) return res.status(404).json({ error: "Note not found, or not yours to delete" });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /sms/notes/:id:", err);
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
