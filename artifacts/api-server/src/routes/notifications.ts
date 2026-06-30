import { Router } from "express";
import { db } from "@workspace/db";
import { notificationTemplatesTable, notificationLogTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import {
  CUSTOMER_MESSAGE_CATALOG,
  MERGE_TAGS,
  applyMergeTags,
  ensureCustomerMessageTemplates,
  ensureCustomerMessageSchedules,
} from "../lib/customer-messages.js";
import { wrapEmailHtml } from "../services/notificationService.js";
import { emailLogoUrl } from "../lib/app-url.js";
import { SAMPLE_SERVICES_BREAKDOWN_HTML } from "../lib/services-breakdown.js";
import { Resend } from "resend";

// Sample merge-var set for test sends + (mirrored on the client) the live
// preview. EVERY tag in MERGE_TAGS resolves to a realistic, non-empty value so a
// test send proves the real layout — no blank {{address}}/{{service}}. Both tag
// naming conventions (short date/time/window AND appointment_*) are filled
// because tenant templates use either. Company name/phone/email come from the
// real row when present.
function buildSampleVars(co: { name?: string; phone?: string; email?: string }): Record<string, string> {
  const date = "Friday, June 27, 2026";
  const time = "9:00 AM CT";
  const window = "9:00 AM – 12:00 PM";
  return {
    first_name: "Maria",
    client_name: "Maria Gomez",
    company_name: co?.name || "Phes",
    company_phone: co?.phone || "(708) 555-0123",
    company_email: co?.email || "info@phes.io",
    service_type: "Standard Cleaning",
    date, appointment_date: date,
    time, appointment_time: time,
    arrival_window: window, appointment_window: window,
    service_address: "123 Oak St, Oak Lawn, IL 60453",
    tech_name: "Ana",
    appointment_link: "https://app.qleno.com/appt/sample",
    review_link: "https://app.qleno.com/review/sample",
    services_breakdown: SAMPLE_SERVICES_BREAKDOWN_HTML,
  };
}

// Friendly "when does it send" string for an offset (cron-driven) message.
function formatOffsetTiming(anchor: string, days: number | null, hour: number | null): string {
  const h = hour == null ? 9 : hour;
  const hr = `${((h + 11) % 12) + 1}:00 ${h < 12 ? "AM" : "PM"} CT`;
  const d = days == null ? 0 : days;
  const dl = `${d} day${d === 1 ? "" : "s"}`;
  if (anchor === "before_appointment") return d === 0 ? `${hr}, the day of the appointment` : `${hr}, ${dl} before the appointment`;
  return `${hr}, ${dl} after the appointment`;
}
function slugifyKey(label: string): string {
  const base = "custom_" + (label || "message").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36);
  return base.replace(/_+$/g, "") || "custom_message";
}

const router = Router();

const DEFAULT_TEMPLATES = [
  {
    trigger: "job_scheduled",
    channel: "email" as const,
    subject: "Your cleaning appointment is confirmed",
    body: "Hi {{client_name}},\n\nYour {{service_type}} appointment is scheduled for {{date}} at {{time}}.\n\nThank you for choosing {{company_name}}!\n\nBest,\nThe {{company_name}} Team",
    is_active: true,
  },
  {
    trigger: "job_reminder_24h",
    channel: "email" as const,
    subject: "Reminder: Cleaning tomorrow at {{time}}",
    body: "Hi {{client_name}},\n\nJust a reminder that your {{service_type}} is tomorrow, {{date}} at {{time}}.\n\nQuestions? Call us anytime.\n\n{{company_name}}",
    is_active: true,
  },
  {
    trigger: "invoice_sent",
    channel: "email" as const,
    subject: "Invoice #{{invoice_number}} from {{company_name}}",
    body: "Hi {{client_name}},\n\nPlease find your invoice for ${{amount}} attached.\n\nThank you for your business!\n\n{{company_name}}",
    is_active: true,
  },
  {
    trigger: "job_complete",
    channel: "in_app" as const,
    subject: null,
    body: "Job for {{client_name}} has been marked complete by {{employee_name}}.",
    is_active: true,
  },
  {
    trigger: "employee_clock_in",
    channel: "in_app" as const,
    subject: null,
    body: "{{employee_name}} clocked in for {{client_name}}'s job.",
    is_active: false,
  },
  {
    trigger: "payment_received",
    channel: "email" as const,
    subject: "Payment confirmed — Thank you!",
    body: "Hi {{client_name}},\n\nWe received your payment of ${{amount}}. Thank you!\n\n{{company_name}}",
    is_active: true,
  },
];

router.get("/templates", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    let templates = await db.select().from(notificationTemplatesTable)
      .where(eq(notificationTemplatesTable.company_id, companyId))
      .orderBy(notificationTemplatesTable.id);

    if (templates.length === 0) {
      const inserted = await db.insert(notificationTemplatesTable)
        .values(DEFAULT_TEMPLATES.map(t => ({ ...t, company_id: companyId })))
        .returning();
      templates = inserted;
    }

    return res.json({ data: templates });
  } catch (err) {
    console.error("Notifications templates error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── Customer Messages control panel ─────────────────────────────────────────
// Schedule-driven: returns every customer message (built-in + custom) with its
// timing, copy, and on/off state. Built-in metadata (group, description) comes
// from the catalog; custom messages derive theirs from the schedule row.
router.get("/customer-messages", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    await ensureCustomerMessageSchedules(companyId); // seeds schedules + templates idempotently
    const [schedRes, tplRows] = await Promise.all([
      db.execute(sql`SELECT key, label, anchor, offset_days, send_hour, channels, is_active, is_builtin, sort_order
                       FROM customer_message_schedules WHERE company_id = ${companyId} ORDER BY sort_order, id`),
      db.select().from(notificationTemplatesTable).where(eq(notificationTemplatesTable.company_id, companyId)),
    ]);
    const tplByKey = new Map((tplRows as any[]).map((r) => [`${r.trigger}:${r.channel}`, r]));
    const catalogByKey = new Map(CUSTOMER_MESSAGE_CATALOG.map((d) => [d.trigger, d]));

    const messages = (schedRes.rows as any[]).map((s) => {
      const def = catalogByKey.get(s.key);
      const editableTiming = s.anchor === "before_appointment" || s.anchor === "after_appointment";
      const channels: string[] = Array.isArray(s.channels) ? s.channels : [];
      return {
        key: s.key,
        label: s.label,
        group: def?.group ?? (s.anchor === "after_appointment" ? "after" : "before"),
        description: def?.description ?? "",
        anchor: s.anchor,
        offset_days: s.offset_days,
        send_hour: s.send_hour,
        is_builtin: s.is_builtin,
        editable_timing: editableTiming,
        timing: editableTiming ? formatOffsetTiming(s.anchor, s.offset_days, s.send_hour) : (def?.timing ?? ""),
        channels: channels.map((channel) => {
          const row: any = tplByKey.get(`${s.key}:${channel}`);
          const defCh = def?.channels.find((c) => c.channel === channel);
          const body = channel === "email" ? (row?.body_html || row?.body) : (row?.body_text || row?.body);
          return {
            channel,
            id: row?.id ?? null,
            subject: row?.subject ?? defCh?.subject ?? null,
            body: body ?? defCh?.body ?? "",
            is_active: row?.is_active ?? true,
          };
        }),
      };
    });
    return res.json({ data: messages, merge_tags: MERGE_TAGS });
  } catch (err) {
    console.error("Customer messages fetch error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Edit the CADENCE (timing) of an offset message — days before/after + send hour.
router.patch("/customer-messages/:key", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const key = req.params.key;
    const { offset_days, send_hour } = req.body ?? {};
    const [sched] = await db.execute(sql`SELECT anchor FROM customer_message_schedules WHERE company_id = ${companyId} AND key = ${key} LIMIT 1`).then((r: any) => r.rows);
    if (!sched) return res.status(404).json({ error: "Message not found" });
    if (sched.anchor !== "before_appointment" && sched.anchor !== "after_appointment") {
      return res.status(400).json({ error: "This message's timing is event-driven and can't be rescheduled." });
    }
    const days = Math.max(0, Math.min(60, parseInt(String(offset_days))));
    const hour = Math.max(0, Math.min(23, parseInt(String(send_hour))));
    if (!Number.isFinite(days) || !Number.isFinite(hour)) return res.status(400).json({ error: "Invalid timing" });
    await db.execute(sql`UPDATE customer_message_schedules SET offset_days = ${days}, send_hour = ${hour} WHERE company_id = ${companyId} AND key = ${key}`);
    return res.json({ ok: true, offset_days: days, send_hour: hour });
  } catch (err) {
    console.error("Update cadence error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ADD a custom automated message to the cadence (before/after the appointment).
router.post("/customer-messages", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const b = req.body ?? {};
    const label = String(b.label || "").trim();
    const anchor = b.anchor === "after_appointment" ? "after_appointment" : "before_appointment";
    const days = Math.max(0, Math.min(60, parseInt(String(b.offset_days ?? 1)) || 0));
    const hour = Math.max(0, Math.min(23, parseInt(String(b.send_hour ?? 9)) || 0));
    const wantEmail = !!b.email_body;
    const wantSms = !!b.sms_body;
    if (!label) return res.status(400).json({ error: "Give the message a name." });
    if (!wantEmail && !wantSms) return res.status(400).json({ error: "Add an email or text message body." });

    // Unique key.
    let key = slugifyKey(label);
    const taken = new Set((await db.execute(sql`SELECT key FROM customer_message_schedules WHERE company_id = ${companyId}`)).rows.map((r: any) => r.key));
    if (taken.has(key)) { let n = 2; while (taken.has(`${key}_${n}`)) n++; key = `${key}_${n}`; }

    const channels = [wantEmail ? "email" : null, wantSms ? "sms" : null].filter(Boolean) as string[];
    const channelsLiteral = `{${channels.join(",")}}`;
    const maxOrder = (await db.execute(sql`SELECT COALESCE(MAX(sort_order), 0) AS m FROM customer_message_schedules WHERE company_id = ${companyId}`)).rows[0] as any;
    await db.execute(sql`
      INSERT INTO customer_message_schedules (company_id, key, label, anchor, offset_days, send_hour, channels, is_active, is_builtin, sort_order)
      VALUES (${companyId}, ${key}, ${label}, ${anchor}, ${days}, ${hour}, ${channelsLiteral}::text[], true, false, ${Number(maxOrder.m) + 10})`);
    if (wantEmail) {
      const subj = String(b.email_subject || label);
      const body = String(b.email_body);
      await db.execute(sql`INSERT INTO notification_templates (company_id, trigger, channel, subject, body, body_html, is_active, created_at)
                           VALUES (${companyId}, ${key}, 'email', ${subj}, ${body}, ${body}, true, NOW())`);
    }
    if (wantSms) {
      const body = String(b.sms_body);
      await db.execute(sql`INSERT INTO notification_templates (company_id, trigger, channel, subject, body, body_text, is_active, created_at)
                           VALUES (${companyId}, ${key}, 'sms', NULL, ${body}, ${body}, true, NOW())`);
    }
    return res.json({ ok: true, key });
  } catch (err) {
    console.error("Add customer message error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE a custom message (built-ins can't be deleted — only paused).
router.delete("/customer-messages/:key", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const key = req.params.key;
    const [sched] = await db.execute(sql`SELECT is_builtin FROM customer_message_schedules WHERE company_id = ${companyId} AND key = ${key} LIMIT 1`).then((r: any) => r.rows);
    if (!sched) return res.status(404).json({ error: "Message not found" });
    if (sched.is_builtin) return res.status(400).json({ error: "Built-in messages can be paused but not deleted." });
    await db.execute(sql`DELETE FROM notification_templates WHERE company_id = ${companyId} AND trigger = ${key}`);
    await db.execute(sql`DELETE FROM customer_message_schedules WHERE company_id = ${companyId} AND key = ${key}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete customer message error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/templates/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id));
    const { is_active, subject, body } = req.body;

    // Fetch the row first so we know its channel and can keep the editable
    // `body` in sync with the channel-specific column the send path reads
    // (body_html for email, body_text for sms). Without this sync, an edit to
    // `body` is shadowed by a stale body_text/body_html and never goes out.
    const [existing] = await db.select().from(notificationTemplatesTable)
      .where(and(eq(notificationTemplatesTable.id, id), eq(notificationTemplatesTable.company_id, companyId)));
    if (!existing) return res.status(404).json({ error: "Template not found" });

    const patch: Record<string, any> = {};
    if (is_active !== undefined) patch.is_active = is_active;
    if (subject !== undefined) patch.subject = subject;
    if (body !== undefined) {
      patch.body = body;
      if (existing.channel === "email") patch.body_html = body;
      if (existing.channel === "sms") patch.body_text = body;
    }

    const [updated] = await db.update(notificationTemplatesTable)
      .set(patch)
      .where(and(eq(notificationTemplatesTable.id, id), eq(notificationTemplatesTable.company_id, companyId)))
      .returning();

    return res.json(updated);
  } catch (err) {
    console.error("Update template error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Send a REAL test message to the logged-in office user's own inbox. The body is
// the DRAFT (unsaved editor content) when supplied, else the saved row — so the
// office verifies exactly what's on screen WITHOUT first saving it live to
// customers. Self-only (req.auth.email) and DELIBERATELY bypasses the
// COMMS_ENABLED gate: this is an office-to-self action, not a customer send, so
// it stays usable while customer comms remain gated (mirrors the contact-form
// exception). SMS templates are emailed as a labeled text-bubble preview so the
// office can verify SMS copy without a Twilio round-trip.
router.post("/templates/:id/test", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id));
    const draft = req.body ?? {};

    const [template] = await db.select().from(notificationTemplatesTable)
      .where(and(eq(notificationTemplatesTable.id, id), eq(notificationTemplatesTable.company_id, companyId)));
    if (!template) return res.status(404).json({ error: "Template not found" });

    const to = req.auth!.email;
    if (!to) return res.status(400).json({ error: "Your account has no email address to send the test to." });
    if (!process.env.RESEND_API_KEY) {
      return res.status(503).json({ error: "Test emails aren't configured yet — set RESEND_API_KEY in Railway." });
    }

    const channel = String(template.channel) as "email" | "sms" | "in_app";
    if (channel === "in_app") return res.status(400).json({ error: "In-app messages can't be test-sent." });

    // DRAFT wins over the saved row when present.
    const isDraft = typeof draft.body === "string" && draft.body.trim().length > 0;
    const rawSubject = typeof draft.subject === "string" ? draft.subject : (template.subject || "");
    const rawBody = isDraft
      ? String(draft.body)
      : channel === "email" ? (template.body_html || template.body || "")
      : (template.body_text || template.body || "");

    const coRow = await db.execute(sql`SELECT name, phone, email, email_from_address, logo_url FROM companies WHERE id = ${companyId} LIMIT 1`);
    const co = (coRow.rows[0] as any) || {};
    const vars = buildSampleVars(co);
    const subject = applyMergeTags(rawSubject, vars).trim() || "Test message";
    const mergedBody = applyMergeTags(rawBody, vars);
    const brand = { logoUrl: emailLogoUrl(co.logo_url), companyName: co.name };
    const from = co.email_from_address || "info@phes.io";

    let html: string;
    let outSubject: string;
    if (channel === "email") {
      // Wrap in the branded chrome (same as real sends), then merge once more so
      // the footer's {{company_phone}}/{{company_email}} resolve.
      html = applyMergeTags(wrapEmailHtml(mergedBody, brand), vars);
      outSubject = `[TEST] ${subject}`;
    } else {
      // SMS preview: render the plain text in a phone bubble inside the email.
      const text = mergedBody.replace(/<[^>]+>/g, "").trim();
      const segs = Math.max(1, Math.ceil(text.length / 160));
      const bubble =
        `<p style="margin:0 0 12px;font-size:13px;color:#6B6860;">This is how your text message will read:</p>` +
        `<table cellpadding="0" cellspacing="0"><tr><td style="background:#E1F5EE;border:1px solid #9FE1CB;border-radius:16px 16px 16px 4px;padding:12px 15px;font-size:15px;line-height:1.45;color:#1A1917;white-space:pre-wrap;max-width:340px;">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td></tr></table>` +
        `<p style="margin:10px 0 0;font-size:12px;color:#9E9B94;">${text.length} characters · ${segs} SMS segment${segs === 1 ? "" : "s"}</p>`;
      html = applyMergeTags(wrapEmailHtml(bubble, brand), vars);
      outSubject = `[TEST] Text preview — ${template.trigger}`;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    const sendRes: any = await resend.emails.send({ from, replyTo: from, to, subject: outSubject, html });
    if (sendRes?.error) throw new Error(`Resend error: ${sendRes.error?.message ?? JSON.stringify(sendRes.error)}`);

    await db.insert(notificationLogTable).values({
      company_id: companyId,
      recipient: to,
      channel: template.channel,
      trigger: template.trigger,
      status: "test_sent",
      metadata: { test: "1", source: isDraft ? "draft" : "saved", subject: outSubject } as any,
    });

    return res.json({ success: true, recipient: to, source: isDraft ? "draft" : "saved", channel });
  } catch (err: any) {
    console.error("Test notification error:", err);
    return res.status(500).json({ error: err?.message || "Failed to send test" });
  }
});

router.get("/log", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const logs = await db.select().from(notificationLogTable)
      .where(eq(notificationLogTable.company_id, companyId))
      .orderBy(desc(notificationLogTable.sent_at))
      .limit(50);
    return res.json({ data: logs });
  } catch (err) {
    console.error("Notification log error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── In-app notification center ──────────────────────────────────────────────

// Per-user inbox (ALL roles). A user sees notifications targeted at them
// (user_id = me) plus legacy company/office broadcasts (user_id IS NULL) when
// they're office/owner/admin. Techs see only their own targeted alerts.
function inboxScope(userId: number, isOffice: boolean) {
  return isOffice ? sql`(user_id = ${userId} OR user_id IS NULL)` : sql`user_id = ${userId}`;
}

router.get("/inbox", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const isOffice = ["owner", "admin", "office"].includes(String(req.auth!.role));
    const limit = Math.min(parseInt((req.query.limit as string) || "50"), 100);
    const unreadOnly = req.query.unread === "true";
    const scope = inboxScope(userId, isOffice);

    const rows = await db.execute(sql`
      SELECT id, company_id, user_id, type, title, body, link, meta, read, created_at
        FROM notifications
       WHERE company_id = ${companyId} AND ${scope}
       ${unreadOnly ? sql`AND read = false` : sql``}
       ORDER BY created_at DESC
       LIMIT ${limit}`);
    const cnt = await db.execute(sql`
      SELECT count(*)::int AS count FROM notifications
       WHERE company_id = ${companyId} AND ${scope} AND read = false`);
    return res.json({ data: rows.rows, unread_count: (cnt.rows[0] as any)?.count ?? 0 });
  } catch (err) {
    console.error("Inbox fetch error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/inbox/read-all", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const isOffice = ["owner", "admin", "office"].includes(String(req.auth!.role));
    await db.execute(sql`
      UPDATE notifications SET read = true
       WHERE company_id = ${companyId} AND read = false AND ${inboxScope(userId, isOffice)}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Read-all error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/inbox/:id/read", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const isOffice = ["owner", "admin", "office"].includes(String(req.auth!.role));
    const id = req.params.id;
    await db.execute(sql`
      UPDATE notifications SET read = true
       WHERE id = ${id} AND company_id = ${companyId} AND ${inboxScope(userId, isOffice)}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Mark-read error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/notifications/settings — this user's effective prefs ──────────────
router.get("/settings", requireAuth, async (req, res) => {
  try {
    const { getEffectivePrefs } = await import("../lib/notify-prefs.js");
    const prefs = await getEffectivePrefs(req.auth!.userId!);
    return res.json(prefs);
  } catch (err) {
    console.error("GET /notifications/settings:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── PUT /api/notifications/settings — upsert this user's prefs ─────────────────
router.put("/settings", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId!;
    const companyId = req.auth!.companyId!;
    const b = req.body ?? {};
    const bool = (v: any) => (v === true ? true : v === false ? false : null);
    await db.execute(sql`
      INSERT INTO notification_prefs
        (user_id, company_id, messages_inapp, messages_email, messages_push,
         new_jobs_inapp, new_jobs_email, new_jobs_push,
         job_changes_inapp, job_changes_email, job_changes_push, updated_at)
      VALUES (${userId}, ${companyId}, ${bool(b.messages_inapp)}, ${bool(b.messages_email)}, ${bool(b.messages_push)},
              ${bool(b.new_jobs_inapp)}, ${bool(b.new_jobs_email)}, ${bool(b.new_jobs_push)},
              ${bool(b.job_changes_inapp)}, ${bool(b.job_changes_email)}, ${bool(b.job_changes_push)}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        messages_inapp = EXCLUDED.messages_inapp, messages_email = EXCLUDED.messages_email, messages_push = EXCLUDED.messages_push,
        new_jobs_inapp = EXCLUDED.new_jobs_inapp, new_jobs_email = EXCLUDED.new_jobs_email, new_jobs_push = EXCLUDED.new_jobs_push,
        job_changes_inapp = EXCLUDED.job_changes_inapp, job_changes_email = EXCLUDED.job_changes_email, job_changes_push = EXCLUDED.job_changes_push,
        updated_at = NOW()`);
    const { getEffectivePrefs } = await import("../lib/notify-prefs.js");
    return res.json(await getEffectivePrefs(userId));
  } catch (err) {
    console.error("PUT /notifications/settings:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── AI rewrite — "make it warmer / shorter / friendlier / translate" ──────────
// Office-only helper that rewrites a customer-message body with Claude. It only
// transforms text supplied in the request — it never sends anything and reads no
// tenant data, so it's safe. CRITICAL: merge tags ({{first_name}} etc.) must
// survive verbatim, so the system prompt forbids touching them.
const AI_MODES: Record<string, string> = {
  warmer: "Rewrite it to sound warmer, friendlier, and more personable, while keeping the same meaning and length roughly the same.",
  shorter: "Make it noticeably shorter and punchier without losing any essential information. Aim for about half the length.",
  friendlier: "Make it clearer and more conversational — plain, friendly language a homeowner would appreciate.",
  proofread: "Fix any spelling, grammar, and punctuation problems. Keep the wording and tone otherwise unchanged.",
  spanish: "Translate it into natural, friendly Mexican Spanish that a homeowner would understand. Output only the Spanish version.",
};

router.post("/ai-rewrite", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const mode = typeof req.body?.mode === "string" ? req.body.mode : "";
    const channel = req.body?.channel === "sms" ? "sms" : "email";
    if (!text.trim()) { res.status(400).json({ error: "text required" }); return; }
    if (text.length > 6000) { res.status(400).json({ error: "text too long" }); return; }
    const instruction = AI_MODES[mode];
    if (!instruction) { res.status(400).json({ error: `mode must be one of: ${Object.keys(AI_MODES).join(", ")}` }); return; }
    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(503).json({ error: "AI assist is not configured — set ANTHROPIC_API_KEY in Railway" });
      return;
    }

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const channelNote = channel === "sms"
      ? "This is an SMS text message — keep it concise and do not add HTML."
      : "This is an email body — you may keep simple HTML tags (p, strong, em, ul, li, a, br, h2, h3) but add no styles, classes, or new wrappers.";
    const system =
      `You edit automated customer messages for a residential cleaning company. ` +
      `${instruction} ${channelNote} ` +
      `ABSOLUTE RULE: the text contains merge tags wrapped in double curly braces like {{first_name}}, {{appointment_date}}, {{appointment_window}}. ` +
      `Preserve every merge tag EXACTLY — same spelling, same braces — and never invent, remove, or translate a tag. ` +
      `Output ONLY the rewritten message — no quotes, no preamble, no commentary.`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: text }],
    });
    const result = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim();
    if (!result) { res.status(502).json({ error: "AI returned an empty result" }); return; }
    res.json({ result });
  } catch (e: any) {
    if (e?.constructor?.name === "AuthenticationError") {
      res.status(503).json({ error: "AI auth failed — check ANTHROPIC_API_KEY" });
      return;
    }
    if (e?.constructor?.name === "RateLimitError") {
      res.status(429).json({ error: "AI is busy — try again in a moment" });
      return;
    }
    console.error("[notifications/ai-rewrite] error:", e);
    res.status(500).json({ error: "AI rewrite failed", message: e?.message });
  }
});

export default router;
