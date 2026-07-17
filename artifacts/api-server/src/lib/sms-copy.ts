import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [sms Pass3] Professional, branded customer-facing SMS copy. Multi-tenant via
// {{company_name}} / {{company_phone}} merge vars — no company hardcoded. Copy
// leads with the sender's name, no ALL-CAPS, no spam phrasing, GSM-7-safe
// (plain hyphens/quotes) to stay single-segment where possible. The long
// hex-token links are shortened to /s/<code> at send time (see short-link.ts).

// Booking confirmation (job_scheduled SMS template body_text).
export const BOOKING_SMS =
  "Hi {{first_name}}! {{company_name}} has your cleaning confirmed for {{appointment_date}} at {{appointment_time}}. View details: {{appointment_link}}";

// Post-job satisfaction survey (companies.survey_message_template + fallback).
export const SURVEY_SMS =
  "{{company_name}}: thanks for letting us clean for you. How did we do? {{survey_link}}";

// Quote follow-up cadence (quote_followup SMS steps).
export const QUOTE_SMS =
  "{{company_name}}: your quote is ready - ${{quote_total}}. View and book: {{estimate_link}}";
export const QUOTE_NUDGE_SMS =
  "{{company_name}}: checking in on your quote. Happy to answer questions or get you booked whenever you're ready.";
export const QUOTE_LAST_SMS =
  "{{company_name}}: we'd still love to help with your cleaning. Want us to hold a spot for you this week?";

// Exact CURRENT defaults, so the upgrade only touches un-customized rows (a
// tenant that edited their copy keeps it) and is idempotent (after the update
// the old text is gone, so it won't run again).
const OLD = {
  booking:
    "Hi {{first_name}}, your cleaning with {{company_name}} is confirmed for {{appointment_date}} at {{appointment_time}} — {{service_type}} at {{service_address}}. View your appointment: {{appointment_link}} Questions? {{company_phone}}.",
  // Previous iteration of booking SMS (upgraded below alongside the original)
  bookingV2:
    "{{company_name}}: your cleaning is confirmed for {{appointment_date}} at {{appointment_time}}. Details: {{appointment_link}}",
  survey:
    "Hi {{first_name}}, thanks for choosing us! How was your cleaning today? Tap to rate: {{survey_link}}",
  quote:
    "Hi {{first_name}}, your {{company_name}} quote is ready - ${{quote_total}}. View and book: {{estimate_link}} or reply with questions.",
  quoteNudge:
    "Hi {{first_name}}, checking in on your {{company_name}} quote. Happy to answer any questions or book your first clean whenever you are ready.",
  quoteLast:
    "Hi {{first_name}}, the {{company_name}} team would still love to help with your cleaning. Want me to hold a spot for you this week?",
};

// [per-package-confirmation 2026-07-17] Per-service-type booking-confirmation SMS
// starters. Keyed by jobs.service_type slug; the send path prefers the exact
// match, else the NULL default. Short (~2 segments) and package-specific, unlike
// the one-size-fits-all default. Only slugs that jobs actually store — "hourly"
// is a billing style, not a service_type, so it has no variant here.
export const PACKAGE_BOOKING_SMS: Record<string, string> = {
  deep_clean:
    "Hi {{first_name}}! Your Deep Clean is booked for {{appointment_date}} at {{appointment_time}}. Please clear countertops and secure pets so we can reach every corner. Your full prep checklist is in your email. Questions? {{company_phone}}. Reply STOP to opt out.",
  move_out:
    "Hi {{first_name}}! Your Move In/Out clean is booked for {{appointment_date}} at {{appointment_time}}. The home should be empty (no furniture or boxes) with utilities on. Full checklist is in your email. Questions? {{company_phone}}. Reply STOP to opt out.",
  standard_clean:
    "Hi {{first_name}}! Your Standard Clean is booked for {{appointment_date}} at {{appointment_time}}. Please tidy loose clutter and secure pets before we arrive. Details are in your email. Questions? {{company_phone}}. Reply STOP to opt out.",
};

// Idempotent: seed a per-package booking-confirmation SMS variant for every
// company that already has the default (NULL) job_scheduled SMS row, only when
// that package variant doesn't exist yet. Never overwrites an existing row, so
// office edits are preserved and re-running is a no-op.
export async function ensurePerPackageBookingSms(): Promise<void> {
  try {
    for (const [slug, body] of Object.entries(PACKAGE_BOOKING_SMS)) {
      await db.execute(sql`
        INSERT INTO notification_templates
          (company_id, trigger, channel, service_type, subject, body, body_html, body_text, is_active)
        SELECT c.id, 'job_scheduled', 'sms'::notification_channel, ${slug}, NULL, '', NULL, ${body}, true
        FROM companies c
        WHERE EXISTS (
                SELECT 1 FROM notification_templates d
                 WHERE d.company_id = c.id AND d.trigger = 'job_scheduled'
                   AND d.channel = 'sms' AND d.service_type IS NULL)
          AND NOT EXISTS (
                SELECT 1 FROM notification_templates v
                 WHERE v.company_id = c.id AND v.trigger = 'job_scheduled'
                   AND v.channel = 'sms' AND v.service_type = ${slug})`);
    }
    console.log("[sms-copy] per-package booking-confirmation SMS starters ensured (idempotent)");
  } catch (err) {
    console.error("[sms-copy] per-package seed error (non-fatal):", err);
  }
}

// Idempotent startup upgrade: rewrite the customer-facing SMS copy across all
// tenants, only where the row still holds the known default. Internal staff
// alerts are untouched (none of these triggers/columns are staff-facing).
export async function upgradeCustomerSmsCopy(): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE notification_templates SET body_text = ${BOOKING_SMS}
      WHERE trigger = 'job_scheduled' AND channel = 'sms' AND body_text = ${OLD.booking}`);
    await db.execute(sql`
      UPDATE notification_templates SET body_text = ${BOOKING_SMS}
      WHERE trigger = 'job_scheduled' AND channel = 'sms' AND body_text = ${OLD.bookingV2}`);
    await db.execute(sql`
      UPDATE companies SET survey_message_template = ${SURVEY_SMS}
      WHERE survey_message_template = ${OLD.survey}`);
    await db.execute(sql`
      UPDATE follow_up_steps st SET message_template = ${QUOTE_SMS}
      FROM follow_up_sequences s
      WHERE st.sequence_id = s.id AND s.sequence_type = 'quote_followup'
        AND st.channel = 'sms' AND st.message_template = ${OLD.quote}`);
    await db.execute(sql`
      UPDATE follow_up_steps st SET message_template = ${QUOTE_NUDGE_SMS}
      FROM follow_up_sequences s
      WHERE st.sequence_id = s.id AND s.sequence_type = 'quote_followup'
        AND st.channel = 'sms' AND st.message_template = ${OLD.quoteNudge}`);
    await db.execute(sql`
      UPDATE follow_up_steps st SET message_template = ${QUOTE_LAST_SMS}
      FROM follow_up_sequences s
      WHERE st.sequence_id = s.id AND s.sequence_type = 'quote_followup'
        AND st.channel = 'sms' AND st.message_template = ${OLD.quoteLast}`);
    console.log("[sms-copy] customer SMS copy upgrade applied (idempotent)");
  } catch (err) {
    console.error("[sms-copy] upgrade error (non-fatal):", err);
  }
}
