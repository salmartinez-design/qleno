// ─────────────────────────────────────────────────────────────────────────────
// Customer Messages — single source of truth for every automated, customer-
// facing message tied to a booking/job.
//
// WHY THIS EXISTS: historically the booking confirmation, completion, and review
// messages read from `notification_templates` (office-editable), but the 72h/24h
// reminders and the "on my way" text used HARDCODED copy in the cron / SMS
// helpers. Editing those in the office UI did nothing. This module makes the
// template table the ONE source: every send renders through `renderCustomer
// Template()`, and the office UI lists exactly the catalog below with View /
// Edit / Pause for each. Hardcoded strings remain ONLY as a last-ditch fallback
// when a tenant has no active template row (so a missing row can never silence a
// send mid-flight).
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type MsgChannel = "email" | "sms";

export interface CatalogChannelDefault {
  channel: MsgChannel;
  subject?: string; // email only
  body: string;
}

export interface CustomerMessageDef {
  trigger: string;
  label: string; // office-facing name
  group: "before" | "during" | "after";
  // Plain-English trigger + exact timing, shown read-only in the UI (the send
  // SCHEDULE is code-controlled; only copy + on/off are editable).
  timing: string;
  description: string;
  channels: CatalogChannelDefault[];
  // Some sends are gated by a per-company on/off column rather than (or in
  // addition to) the template is_active flag — surfaced so the UI can show the
  // real switch. null = governed purely by the template's is_active.
  companyToggleColumn?: string;
}

// Merge-tags available to every customer message. Keep this list in sync with
// the help text shown in the editor.
export const MERGE_TAGS = [
  "first_name",
  "client_name",
  "company_name",
  "company_phone",
  "company_email",
  "service_type",
  "date",
  "time",
  "arrival_window",
  "service_address",
  "tech_name",
  "appointment_link",
  "review_link",
] as const;

// The canonical catalog. Order = the cadence order the customer experiences.
export const CUSTOMER_MESSAGE_CATALOG: CustomerMessageDef[] = [
  {
    trigger: "job_scheduled",
    label: "Booking Confirmation",
    group: "before",
    timing: "Immediately when an appointment is booked",
    description: "Confirms the appointment the moment it's created.",
    channels: [
      {
        channel: "email",
        subject: "Your cleaning appointment is confirmed",
        body:
          "Hi {{first_name}},\n\nYour {{service_type}} is confirmed for {{date}} at {{time}}.\n\nService address: {{service_address}}\n\nView your appointment: {{appointment_link}}\n\nThank you for choosing {{company_name}}!",
      },
      {
        channel: "sms",
        body:
          "{{company_name}}: your {{service_type}} is confirmed for {{date}} at {{time}}. Questions? Call {{company_phone}}. Reply STOP to unsubscribe.",
      },
    ],
  },
  {
    trigger: "reminder_3day",
    label: "3-Day Reminder",
    group: "before",
    timing: "9:00 AM CT, 3 days before the appointment",
    description: "Early heads-up so the customer can plan access.",
    channels: [
      {
        channel: "email",
        subject: "Reminder: your cleaning is on {{date}}",
        body:
          "Hi {{first_name}},\n\nThis is a reminder that your {{service_type}} is scheduled for {{date}} with a {{arrival_window}} arrival window at {{service_address}}.\n\nQuestions? Call {{company_phone}}.\n\n{{company_name}}",
      },
      {
        channel: "sms",
        body:
          "Hi {{first_name}}, this is {{company_name}} confirming your cleaning on {{date}} with a {{arrival_window}} arrival window at {{service_address}}. Questions? Call {{company_phone}}. Reply STOP to unsubscribe.",
      },
    ],
  },
  {
    trigger: "reminder_1day",
    label: "Next-Day Reminder",
    group: "before",
    timing: "4:00 PM CT, the day before the appointment",
    description: "Final reminder the afternoon before, with an access note.",
    channels: [
      {
        channel: "email",
        subject: "Your cleaning is tomorrow",
        body:
          "Hi {{first_name}},\n\nYour {{company_name}} cleaning is tomorrow with a {{arrival_window}} arrival window at {{service_address}}. Please make sure our team can access your home.\n\nQuestions? Call {{company_phone}}.\n\n{{company_name}}",
      },
      {
        channel: "sms",
        body:
          "Hi {{first_name}}, your {{company_name}} cleaning is tomorrow with a {{arrival_window}} arrival window at {{service_address}}. Please ensure access to your home is available. Questions? Call {{company_phone}}. Reply STOP to unsubscribe.",
      },
    ],
  },
  {
    trigger: "on_my_way",
    label: '"On My Way" Text',
    group: "during",
    timing: "Real time, when the cleaner leaves for the home",
    description: "Live heads-up with an arrival ETA when the tech departs.",
    companyToggleColumn: "sms_on_my_way_enabled",
    channels: [
      {
        channel: "sms",
        body:
          "{{company_name}}: your cleaner {{tech_name}} is on the way, arriving around {{arrival_window}}.",
      },
    ],
  },
  {
    trigger: "job_completed",
    label: "Thank-You After Service",
    group: "after",
    timing: "Immediately when the job is marked complete",
    description: "Thanks the customer once the visit is finished.",
    channels: [
      {
        channel: "email",
        subject: "Thank you from {{company_name}}",
        body:
          "Hi {{first_name}},\n\nThank you for letting {{company_name}} clean your home today. We hope everything looks great!\n\nQuestions? Call {{company_phone}}.\n\n{{company_name}}",
      },
      {
        channel: "sms",
        body:
          "Thanks for choosing {{company_name}}, {{first_name}}! Your cleaning is complete. Questions? Call {{company_phone}}. Reply STOP to unsubscribe.",
      },
    ],
  },
  {
    trigger: "review_request",
    label: "Review Request",
    group: "after",
    timing: "About a day after the visit (max once per customer / 30 days)",
    description: "Asks for a rating or review after a completed visit.",
    channels: [
      {
        channel: "email",
        subject: "How did we do, {{first_name}}?",
        body:
          "Hi {{first_name}},\n\nWe'd love your feedback on your recent cleaning with {{company_name}}. It only takes a minute: {{review_link}}\n\nThank you!\n\n{{company_name}}",
      },
      {
        channel: "sms",
        body:
          "Hi {{first_name}}, thanks for choosing {{company_name}}! We'd love your feedback: {{review_link}} Reply STOP to unsubscribe.",
      },
    ],
  },
];

// Quick lookup for the set of trigger keys that are customer messages.
export const CUSTOMER_MESSAGE_TRIGGERS = new Set(
  CUSTOMER_MESSAGE_CATALOG.map((m) => m.trigger),
);

// {{tag}} substitution. Missing tags render as empty string (never the literal
// braces) so a stray tag can't leak into a customer message.
export function applyMergeTags(
  template: string,
  vars: Record<string, string | null | undefined>,
): string {
  return (template || "").replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const v = vars[String(key).trim()];
    return v == null ? "" : String(v);
  });
}

// Ensure every catalog (trigger, channel) row exists for a tenant. Idempotent:
// only inserts rows that are missing, never overwrites office edits. Returns the
// number of rows seeded. Safe to call on every load of the editor.
export async function ensureCustomerMessageTemplates(
  companyId: number,
): Promise<number> {
  const existing = await db.execute(sql`
    SELECT trigger, channel FROM notification_templates WHERE company_id = ${companyId}`);
  const have = new Set(
    (existing.rows as any[]).map((r) => `${r.trigger}:${r.channel}`),
  );
  let seeded = 0;
  for (const def of CUSTOMER_MESSAGE_CATALOG) {
    for (const ch of def.channels) {
      if (have.has(`${def.trigger}:${ch.channel}`)) continue;
      const subject = ch.subject ?? null;
      const body = ch.body;
      // Populate body AND the channel-specific column so EVERY send path reads
      // the same content regardless of which column it prefers.
      const bodyHtml = ch.channel === "email" ? body : null;
      const bodyText = ch.channel === "sms" ? body : null;
      await db.execute(sql`
        INSERT INTO notification_templates
          (company_id, trigger, channel, subject, body, body_html, body_text, is_active, created_at)
        VALUES (${companyId}, ${def.trigger}, ${ch.channel}, ${subject}, ${body}, ${bodyHtml}, ${bodyText}, true, NOW())`);
      seeded++;
    }
  }
  return seeded;
}

export interface RenderedTemplate {
  subject: string | null;
  body: string; // merged, ready to send (HTML for email, plain text for sms)
  is_active: boolean;
}

// Fetch + merge the tenant's template for a (trigger, channel). Returns null
// when there is NO row at all (caller falls back to its built-in default copy).
// When a row exists but is paused, returns { is_active:false } so the caller can
// honor the office's "off" choice. Reads body_html/body_text first (kept in sync
// with body by the editor), falling back to body.
export async function renderCustomerTemplate(
  companyId: number,
  trigger: string,
  channel: MsgChannel,
  vars: Record<string, string | null | undefined>,
): Promise<RenderedTemplate | null> {
  const rows = await db.execute(sql`
    SELECT subject, body, body_html, body_text, is_active
      FROM notification_templates
     WHERE company_id = ${companyId} AND trigger = ${trigger} AND channel = ${channel}
     LIMIT 1`);
  const tpl = rows.rows[0] as any;
  if (!tpl) return null;
  const rawBody =
    channel === "email"
      ? tpl.body_html || tpl.body || ""
      : tpl.body_text || tpl.body || "";
  return {
    subject: tpl.subject ? applyMergeTags(tpl.subject, vars) : null,
    body: applyMergeTags(rawBody, vars),
    is_active: !!tpl.is_active,
  };
}
