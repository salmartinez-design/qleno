import type { Request } from "express";
import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { renderConfirmationEmail, extractPolicyCopy, fmtTime12h } from "./confirmation-email.js";
import { shortenUrl } from "./short-link.js";
import { appBaseUrl } from "./app-url.js";
import { BOOKING_SMS } from "./sms-copy.js";
import { buildAppointmentVars } from "./appointment-vars.js";

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
    const smsBody = BOOKING_SMS;
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

function fmtApptDate(dateStr: any): string {
  try {
    // scheduled_date comes back from pg as a Date object (timestamp column), not
    // an ISO string — normalize both shapes to YYYY-MM-DD before formatting.
    const iso = dateStr instanceof Date ? dateStr.toISOString().slice(0, 10) : String(dateStr).slice(0, 10);
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return String(dateStr);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  } catch { return String(dateStr); }
}

function labelService(raw: string | null): string {
  if (!raw) return "Cleaning service";
  return raw.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Origin (proto + host) from the request, for absolute asset/links in email.
function originFromReq(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || "app.qleno.com";
  return `${proto}://${host}`;
}

// ── The send ─────────────────────────────────────────────────────────────────
// Fetches everything from the job id, ensures the token, builds the link, and
// fires the job_scheduled email + SMS. Gate-respecting (sendNotification gates
// per tenant + global). Non-throwing — callers fire-and-forget.
export async function sendJobScheduledConfirmation(req: Request, jobId: number): Promise<void> {
  try {
    const rows = await db.execute(sql`
      SELECT j.id, j.company_id, j.client_id, j.scheduled_date, j.scheduled_time, j.service_type,
             j.address_street, j.address_city, j.address_state, j.address_zip,
             c.first_name, c.last_name, c.email AS client_email, c.phone AS client_phone,
             u.first_name AS tech_first, u.avatar_url AS tech_avatar,
             co.name AS company_name, co.logo_url AS company_logo,
             co.phone AS company_phone, co.email AS company_email
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN users u ON u.id = j.assigned_user_id
      JOIN companies co ON co.id = j.company_id
      WHERE j.id = ${jobId} LIMIT 1
    `);
    const j: any = rows.rows[0];
    if (!j) return;
    const email = j.client_email || null;
    const phone = j.client_phone || null;
    if (!email && !phone) return; // nothing to send to

    const token = await ensureJobViewToken(jobId);
    // Clean short link (/s/<code>) instead of the long hex token URL in the SMS
    // (and the email CTA). Falls back to the full URL if shortening fails.
    const fullLink = token ? buildAppointmentLink(req, token) : null;
    const link = await shortenUrl(fullLink, j.company_id);

    const stateZip = [j.address_state, j.address_zip].filter(Boolean).join(" ");
    const serviceAddress = [j.address_street, j.address_city, stateZip].filter(Boolean).join(", ");

    const mv: Record<string, string> = {
      first_name: (j.first_name || "").trim(),
      appointment_date: j.scheduled_date ? fmtApptDate(j.scheduled_date) : "your scheduled date",
      appointment_time: j.scheduled_time || "your scheduled window",
      service_type: labelService(j.service_type),
      service_address: serviceAddress,
      appointment_link: link || "",
      // [appointment-vars] Add the short-name aliases ({{date}} / {{time}}) and
      // {{appointment_window}}, and normalize the time to "9:00 AM". Present
      // values override the raw fields above; missing ones keep the fallback.
      ...buildAppointmentVars({ scheduledDate: j.scheduled_date, scheduledTime: j.scheduled_time }),
    };

    // [services-breakdown] Populate {{services_breakdown}} from the job's locked
    // line items so an office template that inserts the chip renders the real
    // itemized table (never a blank tag). Empty string when the job has none.
    // NOTE: the dedicated confirmation-email renderer (renderConfirmationEmail)
    // rebuilds the email shell and only lifts policy copy from the merged body,
    // so the table surfaces wherever the body is rendered through applyMerge
    // (SMS is intentionally not offered this chip in the editor).
    const { buildServicesBreakdownForJob } = await import("./services-breakdown.js");
    mv.services_breakdown = await buildServicesBreakdownForJob(j.company_id, j.id);

    // Dedicated confirmation-email renderer (Pass 2). Cleaner first name + photo
    // ONLY — no last name/contact. Per-tenant contact from the record, branch
    // fallback otherwise. The renderer reuses the merged template body's policy
    // copy verbatim (extractPolicyCopy) and reskins everything else.
    const origin = appBaseUrl();
    const FALLBACK_PHONE = "(847) 538-3729", FALLBACK_PHONE_TEL = "+18475383729", FALLBACK_EMAIL = "schaumburg@phes.io";
    const cPhone = j.company_phone || FALLBACK_PHONE;
    const cPhoneTel = j.company_phone ? String(j.company_phone).replace(/[^\d+]/g, "") : FALLBACK_PHONE_TEL;
    const cEmail = j.company_email || FALLBACK_EMAIL;
    const renderEmail = (mergedBody: string): string => renderConfirmationEmail({
      logoUrl: j.company_logo || `${origin}/phes-logo.jpeg`,
      companyName: j.company_name || "Phes Schaumburg",
      clientFirst: (j.first_name || "").trim(),
      apptDate: j.scheduled_date ? fmtApptDate(j.scheduled_date) : "Your scheduled date",
      apptTime: fmtTime12h(j.scheduled_time),
      serviceType: labelService(j.service_type),
      serviceAddress: serviceAddress || "On file",
      mapsHref: serviceAddress ? `https://maps.google.com/?q=${encodeURIComponent(serviceAddress)}` : null,
      techFirst: j.tech_first || null,
      techAvatar: j.tech_avatar || null,
      link,
      phone: cPhone, phoneTel: cPhoneTel, email: cEmail,
      qlenoMark: `${origin}/images/logo-mark.png`,
      policyCopyHtml: extractPolicyCopy(mergedBody),
      // Render the itemized table in the confirmation email's structured layout
      // (the renderer drops the rest of the body), so the {{services_breakdown}}
      // chip behaves the same here as in a test send.
      servicesBreakdownHtml: mv.services_breakdown,
    });

    const { sendNotification } = await import("../services/notificationService.js");
    if (email) await sendNotification("job_scheduled", "email", j.company_id, email, null, mv, false, renderEmail, j.client_id).catch(() => {});
    if (phone) await sendNotification("job_scheduled", "sms", j.company_id, null, phone, mv, false, undefined, j.client_id).catch(() => {});
  } catch (err) {
    console.error("[booking-confirmation] sendJobScheduledConfirmation failed:", err);
  }
}
