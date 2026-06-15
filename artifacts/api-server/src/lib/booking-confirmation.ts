import type { Request } from "express";
import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [booking-confirmation GAP1] Customer booking confirmation: a no-login,
// token-based "your appointment" view (like /quote/:token, /estimate/:token)
// plus the email + SMS that carry the link. Multi-tenant: every send goes
// through sendNotification(), which enforces the per-tenant comms gate and the
// global COMMS_ENABLED flag, and resolves the tenant's own from-address /
// from-number. No company is hardcoded.

// ── Idempotent setup (startup) ───────────────────────────────────────────────
// Adds the token column + a unique index, and ensures a job_scheduled SMS
// template exists for EVERY company (the email template already ships; the SMS
// variant did not). Runs on cold start; safe to re-run.
export async function ensureBookingConfirmationSetup(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_view_token text`);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_customer_view_token_key
      ON jobs (customer_view_token) WHERE customer_view_token IS NOT NULL
    `);

    // Seed a job_scheduled SMS template for any company that has the email
    // template but no SMS one yet. WHERE NOT EXISTS keeps it idempotent and
    // never clobbers a tenant's customization. The {{appointment_link}} merge
    // var is injected at send time by sendJobScheduledConfirmation().
    const smsBody =
      "Hi {{first_name}}, your cleaning with {{company_name}} is confirmed for " +
      "{{appointment_date}} at {{appointment_time}} — {{service_type}} at " +
      "{{service_address}}. View your appointment: {{appointment_link}} " +
      "Questions? {{company_phone}}.";
    await db.execute(sql`
      INSERT INTO notification_templates
        (company_id, trigger, channel, subject, body, body_html, body_text, is_active)
      SELECT c.id, 'job_scheduled', 'sms'::notification_channel,
             NULL, '', NULL, ${smsBody}, true
      FROM companies c
      WHERE NOT EXISTS (
        SELECT 1 FROM notification_templates t
        WHERE t.company_id = c.id AND t.trigger = 'job_scheduled' AND t.channel = 'sms'
      )
    `);
    console.log("[booking-confirmation] setup ready (token column + job_scheduled SMS template)");
  } catch (err) {
    console.error("[booking-confirmation] setup error (non-fatal):", err);
  }
}

// ── Token + link helpers ─────────────────────────────────────────────────────
// Generates the per-job customer-view token if missing and returns it. Reused
// on re-send (idempotent).
export async function ensureJobViewToken(jobId: number): Promise<string | null> {
  try {
    const row = await db.execute(sql`SELECT customer_view_token FROM jobs WHERE id = ${jobId} LIMIT 1`);
    const existing = (row.rows[0] as any)?.customer_view_token;
    if (existing) return existing;
    const token = randomBytes(24).toString("hex");
    await db.execute(sql`UPDATE jobs SET customer_view_token = ${token} WHERE id = ${jobId}`);
    return token;
  } catch (err) {
    console.error("[booking-confirmation] ensureJobViewToken failed:", err);
    return null;
  }
}

// Builds the public appointment URL from the request's own host (mirrors the
// estimate page's publicEstimateLink — never hardcode the domain).
export function buildAppointmentLink(req: Request, token: string): string | null {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.get("host");
  return host ? `${proto}://${host}/appointment/${token}` : null;
}

function fmtApptDate(dateStr: string): string {
  try {
    const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  } catch { return dateStr; }
}

function labelService(raw: string | null): string {
  if (!raw) return "Cleaning service";
  return raw.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── The send ─────────────────────────────────────────────────────────────────
// Fetches everything from the job id, ensures the token, builds the link, and
// fires the job_scheduled email + SMS. Gate-respecting (sendNotification gates
// per tenant + global). Non-throwing — callers fire-and-forget.
export async function sendJobScheduledConfirmation(req: Request, jobId: number): Promise<void> {
  try {
    const rows = await db.execute(sql`
      SELECT j.id, j.company_id, j.scheduled_date, j.scheduled_time, j.service_type,
             j.address_street, j.address_city, j.address_state, j.address_zip,
             c.first_name, c.last_name, c.email AS client_email, c.phone AS client_phone
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.id = ${jobId} LIMIT 1
    `);
    const j: any = rows.rows[0];
    if (!j) return;
    const email = j.client_email || null;
    const phone = j.client_phone || null;
    if (!email && !phone) return; // nothing to send to

    const token = await ensureJobViewToken(jobId);
    const link = token ? buildAppointmentLink(req, token) : null;

    const stateZip = [j.address_state, j.address_zip].filter(Boolean).join(" ");
    const serviceAddress = [j.address_street, j.address_city, stateZip].filter(Boolean).join(", ");

    const mv: Record<string, string> = {
      first_name: (j.first_name || "").trim(),
      appointment_date: j.scheduled_date ? fmtApptDate(j.scheduled_date) : "your scheduled date",
      appointment_time: j.scheduled_time || "your scheduled window",
      service_type: labelService(j.service_type),
      service_address: serviceAddress,
      appointment_link: link || "",
    };

    const { sendNotification } = await import("../services/notificationService.js");
    if (email) await sendNotification("job_scheduled", "email", j.company_id, email, null, mv).catch(() => {});
    if (phone) await sendNotification("job_scheduled", "sms", j.company_id, null, phone, mv).catch(() => {});
  } catch (err) {
    console.error("[booking-confirmation] sendJobScheduledConfirmation failed:", err);
  }
}
