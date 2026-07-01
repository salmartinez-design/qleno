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

// How a message's send time is determined:
//  - on_booking    : fires immediately when the job is created (event)
//  - before_appointment : offset_days before scheduled_date, at send_hour CT (cron)
//  - on_my_way     : fires when the tech taps On My Way (event)
//  - on_completion : fires when the job is marked complete (event)
//  - after_review  : ~1 day after completion via the throttled review cron (event-ish)
//  - after_appointment : offset_days AFTER scheduled_date, at send_hour CT (cron)
// The offset cron engine only manages before_appointment / after_appointment;
// the rest are event-driven and fire from their own call sites. Custom messages
// the office adds are always before_/after_appointment so they have a clock.
export type MsgAnchor =
  | "on_booking"
  | "before_appointment"
  | "on_my_way"
  | "on_completion"
  | "after_review"
  | "after_appointment";

export const OFFSET_ANCHORS: MsgAnchor[] = ["before_appointment", "after_appointment"];

export interface CustomerMessageDef {
  trigger: string;
  label: string; // office-facing name
  group: "before" | "during" | "after";
  anchor: MsgAnchor;
  offsetDays?: number; // before_/after_appointment only
  sendHour?: number;   // 0-23 CT, before_/after_appointment only
  // Plain-English trigger + timing, shown in the UI. For offset messages the
  // office can edit offsetDays + sendHour; event messages show timing read-only.
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
  // Renders a pre-styled itemized HTML table of the booking's line items
  // (base service, add-ons, discounts, total). Email-only — the editor hides
  // this chip on SMS. See lib/services-breakdown.ts.
  "services_breakdown",
] as const;

// The canonical catalog. Order = the cadence order the customer experiences.
export const CUSTOMER_MESSAGE_CATALOG: CustomerMessageDef[] = [
  {
    trigger: "job_scheduled",
    label: "Booking Confirmation",
    group: "before",
    anchor: "on_booking",
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
    anchor: "before_appointment",
    offsetDays: 3,
    sendHour: 9,
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
    anchor: "before_appointment",
    offsetDays: 1,
    sendHour: 12,
    timing: "12:00 PM CT, 1 day before the appointment",
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
    anchor: "on_my_way",
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
    trigger: "job_started",
    label: "Cleaning Started",
    group: "during",
    anchor: "on_my_way",
    timing: "Real time, when the cleaner clocks in at the home",
    description: "Lets the customer know their cleaner has arrived and work has begun.",
    channels: [
      {
        channel: "sms",
        body:
          "{{company_name}}: your cleaner {{tech_name}} has arrived and started your {{service_type}}. We'll let you know when we're done!",
      },
      {
        channel: "email",
        subject: "Your {{company_name}} cleaning has started",
        body:
          "Hi {{first_name}},\n\nYour {{company_name}} cleaner {{tech_name}} has arrived and started your {{service_type}} at {{service_address}}.\n\nWe'll send you another message when the job is complete.\n\nThank you!\n\n{{company_name}}",
      },
    ],
  },
  {
    trigger: "job_completed",
    label: "Thank-You After Service",
    group: "after",
    anchor: "on_completion",
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
    label: "Satisfaction Survey",
    group: "after",
    anchor: "after_review",
    timing: "After a completed visit (max once per customer / 30 days)",
    description: "Asks the customer to rate their cleaning; the rating feeds the cleaner's Performance Score. {{review_link}} opens the private rating page.",
    channels: [
      {
        channel: "email",
        // [seamless] Tappable rating buttons — one tap from the inbox records the
        // answer (each links to the survey with ?score=N, which auto-submits).
        subject: "How did we do, {{first_name}}?",
        body:
          '<p style="margin:0 0 16px">Hi {{first_name}},</p>' +
          '<p style="margin:0 0 20px">We hope your home is feeling great! How was your cleaning? Tap your answer below — that’s it.</p>' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">' +
          '<tr><td style="padding:0 0 10px"><a href="{{review_link}}?score=4" style="display:block;background:#16A34A;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 18px;border-radius:8px;text-align:center">Thrilled — Great Work</a></td></tr>' +
          '<tr><td style="padding:0 0 10px"><a href="{{review_link}}?score=3" style="display:block;background:#65A30D;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 18px;border-radius:8px;text-align:center">Happy — Good Work</a></td></tr>' +
          '<tr><td style="padding:0 0 10px"><a href="{{review_link}}?score=2" style="display:block;background:#D97706;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 18px;border-radius:8px;text-align:center">A Few Concerns</a></td></tr>' +
          '<tr><td style="padding:0"><a href="{{review_link}}?score=1" style="display:block;background:#DC2626;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 18px;border-radius:8px;text-align:center">Major Concerns</a></td></tr>' +
          '</table>' +
          '<p style="margin:0;color:#6B7280;font-size:13px">Your feedback goes straight to your cleaning team. Thank you for choosing {{company_name}}!</p>',
      },
      {
        channel: "sms",
        body:
          "Hi {{first_name}}, thanks for choosing {{company_name}}! How did we do? Rate your cleaning: {{review_link}} Reply STOP to unsubscribe.",
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

// ── Schedule engine schema + seeding ─────────────────────────────────────────
// customer_message_schedules : per-tenant timing/on-off for every message (the
//   built-ins above plus any the office adds). Copy lives in
//   notification_templates keyed by (company_id, key, channel).
// job_message_sends : a per-(job, message, channel) ledger. This is the HARD
//   idempotency guard for the offset cron AND a row in the customer audit
//   trail. A message can only fire once per job per channel — no double-sends,
//   ever, regardless of restarts or catch-up runs.
export async function runCustomerMessagesMigration(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS customer_message_schedules (
      id           SERIAL PRIMARY KEY,
      company_id   INTEGER NOT NULL,
      key          TEXT NOT NULL,
      label        TEXT NOT NULL,
      anchor       TEXT NOT NULL,
      offset_days  INTEGER,
      send_hour    INTEGER,
      channels     TEXT[] NOT NULL DEFAULT '{}',
      is_active    BOOLEAN NOT NULL DEFAULT TRUE,
      is_builtin   BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, key)
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS job_message_sends (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER NOT NULL,
      job_id        INTEGER NOT NULL,
      client_id     INTEGER,
      schedule_key  TEXT NOT NULL,
      channel       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'sent',
      recipient     TEXT,
      sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (job_id, schedule_key, channel)
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_jms_client ON job_message_sends (client_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_jms_company ON job_message_sends (company_id)`);

  // Backfill the ledger from the legacy reminder_*_sent boolean flags so the new
  // engine treats already-reminded jobs as done and NEVER re-sends them. Both
  // channels are marked (the legacy flag didn't record which channel succeeded);
  // marking both is the safe choice — it prevents a duplicate, never forces one.
  for (const [flag, key] of [["reminder_72h_sent", "reminder_3day"], ["reminder_24h_sent", "reminder_1day"]] as const) {
    for (const channel of ["email", "sms"] as const) {
      await db.execute(sql`
        INSERT INTO job_message_sends (company_id, job_id, client_id, schedule_key, channel, status, sent_at)
        SELECT j.company_id, j.id, j.client_id, ${key}, ${channel}, 'sent', NOW()
          FROM jobs j
         WHERE j.${sql.raw(flag)} = TRUE
        ON CONFLICT (job_id, schedule_key, channel) DO NOTHING`);
    }
  }

  // [on-my-way-activate 2026-06-29] The on_my_way SMS template was seeded with
  // is_active=false in an earlier pass because the companyToggleColumn gate was
  // confused with the template gate. Flip false→true so the tech's On My Way tap
  // actually fires. Only touches rows that are still false — won't override an
  // explicit office pause.
  await db.execute(sql`
    UPDATE notification_templates
       SET is_active = true
     WHERE trigger = 'on_my_way'
       AND channel = 'sms'
       AND is_active = false`);

  // [reminder-1day-noon 2026-06-29] The Next-Day Reminder default moved from
  // 4 PM (send_hour 16) to noon (12), but ensureCustomerMessageSchedules skips
  // any schedule that already exists (the `have.has(trigger)` guard) BEFORE it
  // reaches the INSERT ... ON CONFLICT DO UPDATE, so the new default never
  // reached tenants seeded before the change — their rows kept 16. Reconcile the
  // specific stale value here. Only rows still at the old hardcoded 4 PM are
  // touched; any office customization to a different hour is left alone.
  await db.execute(sql`
    UPDATE customer_message_schedules
       SET send_hour = 12
     WHERE key = 'reminder_1day'
       AND send_hour = 16`);

  // Seed the built-in schedule rows for EVERY tenant now, at boot — not lazily on
  // first page view. Without this the offset cron would find zero schedules and
  // silently stop sending reminders until someone opened the settings page.
  const companies = await db.execute(sql`SELECT id FROM companies`);
  for (const row of companies.rows as any[]) {
    try {
      await ensureCustomerMessageSchedules(Number(row.id));
    } catch (err) {
      console.error(`[customer-messages] seed schedules failed for company ${row.id}:`, err);
    }
  }
}

// Seed the built-in schedule rows + templates for a tenant. Idempotent — only
// inserts what's missing, never clobbers office edits (timing or copy).
export async function ensureCustomerMessageSchedules(companyId: number): Promise<void> {
  await ensureCustomerMessageTemplates(companyId);
  const existing = await db.execute(sql`SELECT key FROM customer_message_schedules WHERE company_id = ${companyId}`);
  const have = new Set((existing.rows as any[]).map((r) => r.key));
  let order = 0;
  for (const def of CUSTOMER_MESSAGE_CATALOG) {
    order += 10;
    if (have.has(def.trigger)) continue;
    // channels are fixed known tokens ('email'/'sms') — safe to embed as a
    // Postgres array literal like '{email,sms}'.
    const channelsLiteral = `{${def.channels.map((c) => c.channel).join(",")}}`;
    await db.execute(sql`
      INSERT INTO customer_message_schedules
        (company_id, key, label, anchor, offset_days, send_hour, channels, is_active, is_builtin, sort_order)
      VALUES (${companyId}, ${def.trigger}, ${def.label}, ${def.anchor},
              ${def.offsetDays ?? null}, ${def.sendHour ?? null},
              ${channelsLiteral}::text[],
              true, true, ${order})
      ON CONFLICT (company_id, key) DO UPDATE SET send_hour = EXCLUDED.send_hour`);
  }
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
