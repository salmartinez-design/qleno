/**
 * Follow-Up Sequence Engine
 * Handles enrollment, processing, and stop logic for automated follow-up sequences.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { resolveSender, sendSmsVia } from "../lib/comms-sender.js";
import { getBranchByZip } from "../lib/branchRouter.js";
import { appBaseUrl } from "../lib/app-url.js";
import { shortenUrl } from "../lib/short-link.js";

// ── Merge field resolver ───────────────────────────────────────────────────────
function resolveMergeFields(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

// ── Business-hours clamp (America/Chicago, 8am–9pm) ────────────────────────────
// Phes sends nothing outside 8:00–21:00 local. A computed next_fire_at before
// 8am moves to 8am the same day; at/after 9pm moves to 8am the next day.
const SEND_TZ = "America/Chicago";
const SEND_START_HOUR = 8;
const SEND_END_HOUR = 21;

function tzParts(date: Date, tz: string): Record<string, number> {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const { type, value } of f.formatToParts(date)) {
    if (type !== "literal") p[type] = parseInt(value, 10);
  }
  return p;
}

// Convert a wall-clock time in `tz` to the corresponding UTC instant.
function wallToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const p = tzParts(new Date(guess), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = asUtc - guess; // local-as-utc minus utc = tz offset
  return new Date(guess - offset);
}

export function clampToBusinessHours(raw: Date): Date {
  const p = tzParts(raw, SEND_TZ);
  if (p.hour >= SEND_START_HOUR && p.hour < SEND_END_HOUR) return raw;
  // hour < 8 → 8am same day; hour >= 21 → 8am next day (Date.UTC normalizes overflow)
  const dayShift = p.hour >= SEND_END_HOUR ? 1 : 0;
  return wallToUtc(SEND_TZ, p.year, p.month, p.day + dayShift, SEND_START_HOUR, 0);
}

// SMS is sent per-branch via resolveSender + sendSmsVia (see comms-sender.ts);
// the old env-based single-number sender was removed when branch routing landed.

// ── Resend email sender ────────────────────────────────────────────────────────
// Raw send — performs the actual Resend call with NO COMMS_ENABLED gate. Only
// callers that are themselves explicitly scoped/authorized may use this
// directly (see sendSingleEnrollmentTouch). Returns the Resend message id.
// Resolve a company's per-tenant send-from address (Resend-verified domain),
// falling back to the default Phes sender. Raw SQL to avoid the regenerated
// drizzle column-type coupling.
async function companyFromAddress(companyId: number): Promise<string> {
  try {
    const r = await db.execute(sql`SELECT name, email_from_address FROM companies WHERE id = ${companyId} LIMIT 1`);
    const c: any = r.rows[0] ?? {};
    const brand = c.name || "Phes Cleaning";
    return c.email_from_address ? `${brand} <${c.email_from_address}>` : `${brand} <noreply@phes.io>`;
  } catch { return "Phes Cleaning <noreply@phes.io>"; }
}

// Per-tenant company info for cadence merge fields. The base mergeVars used to
// hardcode company_name:"Phes" — so every tenant's cadence rendered "Phes". This
// resolves the real name/phone/email per company_id so {{company_name}} etc. are
// correct for ALL tenants (the multi-tenant branding fix).
async function companyInfo(companyId: number): Promise<{ name: string; phone: string; email: string }> {
  try {
    const r = await db.execute(sql`SELECT name, phone, email FROM companies WHERE id = ${companyId} LIMIT 1`);
    const c: any = r.rows[0] ?? {};
    return { name: c.name || "Phes", phone: c.phone || "", email: c.email || "" };
  } catch { return { name: "Phes", phone: "", email: "" }; }
}

interface EmailBrand { companyName?: string | null; phone?: string | null; email?: string | null }

async function sendEmailRaw(
  to: string, subject: string, body: string,
  fromAddress = "Phes Cleaning <noreply@phes.io>",
  brand?: EmailBrand,
  // [comms-opt-out] Optional List-Unsubscribe headers + footer link.
  unsub?: { headers: Record<string, string>; footerHtml: string },
  // [multi-recipient-estimates] Optional CC recipients.
  cc?: string[],
): Promise<string | null> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Resend not configured");
  const { Resend } = await import("resend");
  const resend = new Resend(key);
  const brandName  = brand?.companyName || "Phes Cleaning";
  const brandPhone = brand?.phone || "(773) 706-6000";
  const brandEmail = brand?.email || "info@phes.io";
  // A body that already starts with a block tag is rich HTML (e.g. the quote
  // email) — inject it verbatim. Plain-text bodies get newline→<br> + a <p>.
  const inner = /^\s*</.test(body)
    ? body
    : `<p style="font-size:15px;color:#1A1917;line-height:1.7;margin:0 0 20px;">${body.replace(/\n/g, "<br>")}</p>`;
  const bodyHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#F7F6F3;">
<div style="background:#fff;border:1px solid #E5E2DC;border-radius:8px;padding:32px;">
<div style="background:#5B9BD5;padding:14px 20px;border-radius:4px;margin-bottom:24px;">
  <span style="color:#fff;font-size:16px;font-weight:bold;">${brandName}</span>
</div>
${inner}
<p style="font-size:13px;color:#9E9B94;margin:20px 0 0;">${brandName} &mdash; ${brandPhone} &mdash; ${brandEmail}</p>
${unsub?.footerHtml ?? ""}
</div></div>`;
  const ccList = (cc ?? []).filter((e) => e && e.toLowerCase() !== to.toLowerCase());
  const res: any = await resend.emails.send({
    from: fromAddress,
    to: [to],
    ...(ccList.length ? { cc: ccList } : {}),
    subject,
    html: bodyHtml,
    ...(unsub?.headers && Object.keys(unsub.headers).length ? { headers: unsub.headers } : {}),
  });
  // The Resend SDK returns { data, error } and does NOT throw on API errors
  // (unverified domain, invalid key, etc.). Surface it so callers don't record
  // a failed send as "sent" — the bug behind "Resend said ok but nothing arrived".
  if (res?.error) {
    const e = res.error;
    throw new Error(`Resend error: ${e?.name ? e.name + " — " : ""}${e?.message ?? JSON.stringify(e)}`);
  }
  return res?.data?.id ?? res?.id ?? null;
}

async function sendEmail(to: string, subject: string, body: string, fromAddress?: string, brand?: EmailBrand, unsub?: { headers: Record<string, string>; footerHtml: string }, cc?: string[]): Promise<void> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] Follow-up email suppressed:", { to, subject });
    return;
  }
  await sendEmailRaw(to, subject, body, fromAddress, brand, unsub, cc);
}

// Human label for a quote's frequency, used as the option heading when a lead
// has more than one quote (e.g. "Deep Clean · One-time" vs "Standard · Every 2 weeks").
function quoteFreqLabel(f: string | null | undefined): string {
  const k = String(f || "").toLowerCase().replace(/[\s-]+/g, "_");
  const map: Record<string, string> = {
    onetime: "One-time", one_time: "One-time",
    weekly: "Weekly", biweekly: "Every 2 weeks", bi_weekly: "Every 2 weeks",
    every_2_weeks: "Every 2 weeks", every_4_weeks: "Every 4 weeks",
    monthly: "Monthly", quarterly: "Quarterly",
  };
  return map[k] || (f ? String(f).replace(/_/g, " ") : "");
}

// Render ONE quote as an itemized option block: an optional heading
// (service · frequency) + a line-item table (base + each add-on) + a Total row.
// Mirrors the booking-confirmation breakdown so every option reads the same.
function renderQuoteOption(q: any, showHeading: boolean): string {
  const total = q.total_price ?? q.base_price ?? "0";
  const addons = Array.isArray(q.addons) ? q.addons : [];
  const rows: string[] = [];
  if (q.base_price != null) rows.push(`<tr><td style="padding:6px 0;color:#1A1917;">${q.service_type || "Cleaning service"}</td><td style="padding:6px 0;text-align:right;color:#1A1917;">$${Number(q.base_price).toFixed(2)}</td></tr>`);
  for (const a of addons) {
    const amt = a?.amount ?? a?.price;
    rows.push(`<tr><td style="padding:6px 0;color:#1A1917;">${a?.name || "Add-on"}</td><td style="padding:6px 0;text-align:right;color:#1A1917;">${amt != null ? "$" + Number(amt).toFixed(2) : "—"}</td></tr>`);
  }
  const table = `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0;">${rows.join("")}<tr><td style="padding:8px 0 0;font-weight:700;border-top:1px solid #E5E2DC;">Total</td><td style="padding:8px 0 0;text-align:right;font-weight:700;border-top:1px solid #E5E2DC;">$${Number(total).toFixed(2)}</td></tr></table>`;
  if (!showHeading) return table;
  const freq = quoteFreqLabel(q.frequency);
  return `<p style="font-size:15px;font-weight:700;color:#1A1917;margin:16px 0 2px;">${q.service_type || "Cleaning service"}${freq ? ` &middot; ${freq}` : ""}</p>${table}`;
}

// Build the merge vars for a quote-tied enrollment touch (the quote email + SMS).
// Pulls the triggering quote for the customer-facing link + brand info, then
// gathers EVERY open quote for that lead so the customer sees all the options
// they were quoted (e.g. a one-time deep clean AND a recurring plan), each
// itemized, even the ones that didn't trigger this drip. Returns extra vars
// merged on top of the base {first_name, company_name}.
async function buildQuoteMergeVars(companyId: number, quoteId: number): Promise<Record<string, string>> {
  const r = await db.execute(sql`
    SELECT q.id, q.total_price, q.base_price, q.address, q.service_type, q.frequency, q.addons,
           q.sign_token, q.lead_email, q.lead_phone, q.client_id,
           c.name AS company_name, c.phone AS company_phone, c.email AS company_email
    FROM quotes q JOIN companies c ON c.id = q.company_id
    WHERE q.id = ${quoteId} AND q.company_id = ${companyId} LIMIT 1
  `);
  const q: any = r.rows[0];
  if (!q) return {};
  const total = q.total_price ?? q.base_price ?? "0";
  // Residential quotes use the /quote/ route (the hosted page self-labels as
  // "Quote"). Clean short link for the customer SMS/email; falls back to full URL.
  const fullLink = q.sign_token ? `${appBaseUrl()}/quote/${q.sign_token}` : `${appBaseUrl()}/quote`;
  const link = q.sign_token ? ((await shortenUrl(fullLink, companyId)) || fullLink) : fullLink;

  // All of this lead's still-open quotes. Match by client_id when known, else by
  // lead email/phone. Only quotes actually sent to the customer (or this trigger),
  // excluding anything already accepted / booked / expired / declined. One-time
  // options list before recurring so the "book now" clean reads first.
  const leadEmail = String(q.lead_email || "").trim().toLowerCase();
  const leadPhone10 = String(q.lead_phone || "").replace(/\D/g, "").slice(-10);
  const allRows = await db.execute(sql`
    SELECT id, total_price, base_price, service_type, frequency, addons
    FROM quotes
    WHERE company_id = ${companyId}
      AND status NOT IN ('accepted','booked','converted','expired','declined','lost')
      AND (sent_at IS NOT NULL OR id = ${quoteId})
      AND (
        (${q.client_id}::int IS NOT NULL AND client_id = ${q.client_id})
        OR (${q.client_id}::int IS NULL AND ${leadEmail} <> '' AND lower(lead_email) = ${leadEmail})
        OR (${q.client_id}::int IS NULL AND ${leadPhone10} <> '' AND right(regexp_replace(coalesce(lead_phone,''),'\\D','','g'),10) = ${leadPhone10})
      )
    ORDER BY (frequency IS NULL OR lower(frequency) IN ('onetime','one_time','one-time')) DESC, id ASC
  `);
  const quotes: any[] = (allRows.rows && allRows.rows.length ? allRows.rows : [q]);
  const multi = quotes.length > 1;
  const lineItems = multi
    ? quotes.map((qq) => renderQuoteOption(qq, true)).join("")
    : renderQuoteOption(quotes[0], false);

  return {
    company_name:    q.company_name || "Phes",
    company_phone:   q.company_phone || "(773) 706-6000",
    company_email:   q.company_email || "info@phes.io",
    estimate_link:   link,
    quote_number:    String(q.id),
    quote_total:     Number(total).toFixed(2),
    quote_count:     String(quotes.length),
    service_address: q.address || "",
    customer_email:  q.lead_email || "",
    customer_phone:  q.lead_phone || "",
    line_items:      lineItems,
  };
}

// Build merge vars for a commercial-estimate enrollment touch. Pulls the
// estimate's public token (→ the hosted /estimate/ page), total, property +
// contact and the tenant brand. Merge fields used by the estimate sequence copy:
// {{first_name}} {{company_name}} {{company_phone}} {{property}} {{monthly}} {{estimate_link}}.
async function buildEstimateMergeVars(companyId: number, estimateId: number, enrollmentId?: number, recipientOverride?: string | null): Promise<Record<string, string>> {
  const r = await db.execute(sql`
    SELECT e.id, e.total, e.property_name, e.service_address, e.public_token, e.contact_name, e.contact_email,
           c.name AS company_name, c.phone AS company_phone, c.email AS company_email
    FROM estimates e JOIN companies c ON c.id = e.company_id
    WHERE e.id = ${estimateId} AND e.company_id = ${companyId} LIMIT 1
  `);
  const e: any = r.rows[0];
  if (!e) return {};
  const fullLink = e.public_token ? `${appBaseUrl()}/estimate/${e.public_token}` : `${appBaseUrl()}/estimate`;
  // [engagement-phase4] When sending a real touch (enrollmentId present), route
  // the link through our own click-redirect so the click is recorded natively
  // and attributed to this estimate + enrollment. Falls back to a short link.
  let link: string;
  if (enrollmentId) {
    const { createTrackedLink } = await import("../lib/engagement.js");
    link = await createTrackedLink({ companyId, targetUrl: fullLink, estimateId, enrollmentId, recipient: recipientOverride ?? e.contact_email ?? null });
  } else {
    link = e.public_token ? ((await shortenUrl(fullLink, companyId)) || fullLink) : fullLink;
  }
  const total = e.total != null ? Number(e.total).toFixed(2) : "0.00";
  return {
    company_name:   e.company_name || "Phes",
    company_phone:  e.company_phone || "(773) 706-6000",
    company_email:  e.company_email || "info@phes.io",
    property:       e.property_name || e.service_address || "your property",
    monthly:        total,
    estimate_total: total,
    estimate_link:  link,
    estimate_number: String(e.id),
  };
}

// ── Enroll for quote follow-up ─────────────────────────────────────────────────
export async function enrollForQuoteSent(
  companyId: number,
  quoteId: number,
  clientId: number | null,
  firstName: string,
  email: string | null,
  phone: string | null,
): Promise<void> {
  try {
    const seqRows = await db.execute(sql`
      SELECT id FROM follow_up_sequences
      WHERE company_id = ${companyId} AND sequence_type = 'quote_followup' AND is_active = true
      LIMIT 1
    `);
    if (!seqRows.rows.length) return;
    const sequenceId = (seqRows.rows[0] as any).id;

    // Deduplicate: one active enrollment per quote
    const existing = await db.execute(sql`
      SELECT id FROM follow_up_enrollments
      WHERE sequence_id = ${sequenceId} AND quote_id = ${quoteId}
        AND completed_at IS NULL AND stopped_at IS NULL
      LIMIT 1
    `);
    if (existing.rows.length > 0) return;

    await db.execute(sql`
      INSERT INTO follow_up_enrollments
        (company_id, sequence_id, quote_id, client_id, current_step, next_fire_at)
      VALUES
        (${companyId}, ${sequenceId}, ${quoteId}, ${clientId}, 1, NOW())
    `);
    console.log(`[follow-up] Enrolled quote ${quoteId} in quote_followup sequence ${sequenceId}`);
  } catch (err) {
    console.error("[follow-up] enrollForQuoteSent error (non-fatal):", err);
  }
}

// ── Enroll for post-job retention ──────────────────────────────────────────────
export async function enrollForJobComplete(
  companyId: number,
  jobId: number,
  clientId: number,
): Promise<void> {
  try {
    // Skip if client has a recurring schedule with future jobs
    const recurringCheck = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM jobs
      WHERE client_id = ${clientId}
        AND company_id = ${companyId}
        AND status IN ('scheduled', 'in_progress')
        AND scheduled_date > NOW()
      LIMIT 1
    `);
    if ((recurringCheck.rows[0] as any).cnt > 0) {
      console.log(`[follow-up] Client ${clientId} has future jobs — skipping post_job_retention enrollment`);
      return;
    }

    const seqRows = await db.execute(sql`
      SELECT id FROM follow_up_sequences
      WHERE company_id = ${companyId} AND sequence_type = 'post_job_retention' AND is_active = true
      LIMIT 1
    `);
    if (!seqRows.rows.length) return;
    const sequenceId = (seqRows.rows[0] as any).id;

    // Deduplicate: one active enrollment per client
    const existing = await db.execute(sql`
      SELECT id FROM follow_up_enrollments
      WHERE sequence_id = ${sequenceId} AND client_id = ${clientId}
        AND completed_at IS NULL AND stopped_at IS NULL
      LIMIT 1
    `);
    if (existing.rows.length > 0) return;

    // Step 1 has delay_hours=2
    await db.execute(sql`
      INSERT INTO follow_up_enrollments
        (company_id, sequence_id, quote_id, client_id, current_step, next_fire_at)
      VALUES
        (${companyId}, ${sequenceId}, NULL, ${clientId}, 1, NOW() + INTERVAL '2 hours')
    `);
    console.log(`[follow-up] Enrolled client ${clientId} in post_job_retention sequence ${sequenceId}`);
  } catch (err) {
    console.error("[follow-up] enrollForJobComplete error (non-fatal):", err);
  }
}

// ── Enroll for abandoned-booking follow-up ─────────────────────────────────────
// Fired from POST /api/public/book/abandon-track after the abandoned_bookings
// upsert. Step 1 fires +20 min (set explicitly here; delay_hours is integer
// hours so it can't hold 20 min). Dedupes on the abandoned_booking row.
export async function enrollForAbandonedBooking(
  companyId: number,
  abandonedBookingId: number,
): Promise<void> {
  try {
    const seqRows = await db.execute(sql`
      SELECT id FROM follow_up_sequences
      WHERE company_id = ${companyId} AND sequence_type = 'abandoned_booking' AND is_active = true
      LIMIT 1
    `);
    if (!seqRows.rows.length) return;
    const sequenceId = (seqRows.rows[0] as any).id;

    // Deduplicate: one active enrollment per abandoned booking
    const existing = await db.execute(sql`
      SELECT id FROM follow_up_enrollments
      WHERE sequence_id = ${sequenceId} AND abandoned_booking_id = ${abandonedBookingId}
        AND completed_at IS NULL AND stopped_at IS NULL
      LIMIT 1
    `);
    if (existing.rows.length > 0) return;

    await db.execute(sql`
      INSERT INTO follow_up_enrollments
        (company_id, sequence_id, abandoned_booking_id, current_step, next_fire_at)
      VALUES
        (${companyId}, ${sequenceId}, ${abandonedBookingId}, 1, NOW() + INTERVAL '20 minutes')
    `);
    console.log(`[follow-up] Enrolled abandoned_booking ${abandonedBookingId} in abandoned_booking sequence ${sequenceId}`);
  } catch (err) {
    console.error("[follow-up] enrollForAbandonedBooking error (non-fatal):", err);
  }
}

// ── Stop enrollments for a client (rebooked / booked) ─────────────────────────
export async function stopEnrollmentsForClient(
  clientId: number,
  reason: string,
  sequenceType?: string,
): Promise<void> {
  try {
    const typeClause = sequenceType
      ? sql` AND fs.sequence_type = ${sequenceType}`
      : sql``;
    await db.execute(sql`
      UPDATE follow_up_enrollments fe
      SET stopped_at = NOW(), stopped_reason = ${reason}
      FROM follow_up_sequences fs
      WHERE fe.sequence_id = fs.id
        AND fe.client_id = ${clientId}
        AND fe.completed_at IS NULL
        AND fe.stopped_at IS NULL
        ${typeClause}
    `);
    console.log(`[follow-up] Stopped enrollments for client ${clientId} — reason: ${reason}`);
  } catch (err) {
    console.error("[follow-up] stopEnrollmentsForClient error (non-fatal):", err);
  }
}

// ── Stop enrollments for a quote ───────────────────────────────────────────────
export async function stopEnrollmentsForQuote(
  quoteId: number,
  reason: string,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE follow_up_enrollments
      SET stopped_at = NOW(), stopped_reason = ${reason}
      WHERE quote_id = ${quoteId}
        AND completed_at IS NULL
        AND stopped_at IS NULL
    `);
    console.log(`[follow-up] Stopped enrollments for quote ${quoteId} — reason: ${reason}`);
  } catch (err) {
    console.error("[follow-up] stopEnrollmentsForQuote error (non-fatal):", err);
  }
}

// ── Enroll for estimate follow-up (commercial drip) ────────────────────────────
// Fired from POST /api/estimates/:id/send. Enrolls only when the tenant has an
// ACTIVE 'estimate_followup' sequence — seeded is_active=FALSE by default, so the
// drip is INERT until the office explicitly turns it on. Even when active, the
// actual sends still pass through the COMMS_ENABLED + company/branch comms gates
// in processEnrollment, so nothing leaves while a tenant's comms are off.
export async function enrollForEstimateSent(
  companyId: number,
  estimateId: number,
): Promise<void> {
  try {
    const seqRows = await db.execute(sql`
      SELECT id FROM follow_up_sequences
      WHERE company_id = ${companyId} AND sequence_type = 'estimate_followup' AND is_active = true
      LIMIT 1
    `);
    if (!seqRows.rows.length) {
      console.log(`[follow-up] No active estimate_followup sequence for company ${companyId} — estimate ${estimateId} not enrolled (drip inert).`);
      return;
    }
    const sequenceId = (seqRows.rows[0] as any).id;

    // Deduplicate: one active enrollment per estimate.
    const existing = await db.execute(sql`
      SELECT id FROM follow_up_enrollments
      WHERE sequence_id = ${sequenceId} AND estimate_id = ${estimateId}
        AND completed_at IS NULL AND stopped_at IS NULL
      LIMIT 1
    `);
    if (existing.rows.length > 0) return;

    await db.execute(sql`
      INSERT INTO follow_up_enrollments
        (company_id, sequence_id, estimate_id, current_step, next_fire_at)
      VALUES
        (${companyId}, ${sequenceId}, ${estimateId}, 1, NOW())
    `);
    console.log(`[follow-up] Enrolled estimate ${estimateId} in estimate_followup sequence ${sequenceId}`);
  } catch (err) {
    console.error("[follow-up] enrollForEstimateSent error (non-fatal):", err);
  }
}

// ── Enroll a lead in the appropriate drip sequence ────────────────────────────
// Selects lead_drip_web or lead_drip_phone by leadSource. Both are seeded
// is_active=FALSE so nothing fires until the office enables the sequence.
// Even when active, sends still pass through the COMMS_ENABLED gate.
export async function enrollForLeadDrip(
  companyId: number,
  leadId: number,
  leadSource: string,
): Promise<void> {
  try {
    const seqType = leadSource === 'phone_in' ? 'lead_drip_phone' : 'lead_drip_web';
    const seqRows = await db.execute(sql`
      SELECT id FROM follow_up_sequences
      WHERE company_id = ${companyId} AND sequence_type = ${seqType} AND is_active = true
      LIMIT 1
    `);
    if (!seqRows.rows.length) {
      console.log(`[follow-up] No active ${seqType} sequence for company ${companyId} — lead ${leadId} not enrolled (drip inert).`);
      return;
    }
    const sequenceId = (seqRows.rows[0] as any).id;

    const existing = await db.execute(sql`
      SELECT id FROM follow_up_enrollments
      WHERE sequence_id = ${sequenceId} AND lead_id = ${leadId}
        AND completed_at IS NULL AND stopped_at IS NULL
      LIMIT 1
    `);
    if (existing.rows.length > 0) return;

    await db.execute(sql`
      INSERT INTO follow_up_enrollments
        (company_id, sequence_id, lead_id, current_step, next_fire_at)
      VALUES
        (${companyId}, ${sequenceId}, ${leadId}, 1, NOW())
    `);
    console.log(`[follow-up] Enrolled lead ${leadId} in ${seqType} sequence ${sequenceId}`);
  } catch (err) {
    console.error("[follow-up] enrollForLeadDrip error (non-fatal):", err);
  }
}

// ── Stop all drip enrollments for a lead (booked / opted out) ────────────────
export async function stopEnrollmentsForLead(
  leadId: number,
  reason: string,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE follow_up_enrollments
      SET stopped_at = NOW(), stopped_reason = ${reason}
      WHERE lead_id = ${leadId}
        AND completed_at IS NULL
        AND stopped_at IS NULL
    `);
    console.log(`[follow-up] Stopped lead enrollments for lead ${leadId} — reason: ${reason}`);
  } catch (err) {
    console.error("[follow-up] stopEnrollmentsForLead error (non-fatal):", err);
  }
}

// ── Stop enrollments for an estimate (accepted / declined) ──────────────────────
export async function stopEnrollmentsForEstimate(
  estimateId: number,
  reason: string,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE follow_up_enrollments
      SET stopped_at = NOW(), stopped_reason = ${reason}
      WHERE estimate_id = ${estimateId}
        AND completed_at IS NULL
        AND stopped_at IS NULL
    `);
    console.log(`[follow-up] Stopped estimate enrollments for estimate ${estimateId} — reason: ${reason}`);
  } catch (err) {
    console.error("[follow-up] stopEnrollmentsForEstimate error (non-fatal):", err);
  }
}

// ── Stop estimate enrollments by replier phone (stop-on-reply) ──────────────────
// The inbound-SMS webhook calls this so a property manager texting back halts the
// estimate drip, matched on the estimate's contact_phone (last-10 digits).
export async function stopEstimateEnrollmentsByPhone(
  companyId: number,
  phone: string,
  reason: string,
): Promise<void> {
  try {
    const digits = (phone || "").replace(/\D/g, "").slice(-10);
    if (digits.length !== 10) return;
    const stopped = await db.execute(sql`
      UPDATE follow_up_enrollments fe
      SET stopped_at = NOW(), stopped_reason = ${reason}
      FROM estimates e
      WHERE fe.estimate_id = e.id
        AND fe.company_id = ${companyId}
        AND right(regexp_replace(e.contact_phone, '\\D', '', 'g'), 10) = ${digits}
        AND fe.completed_at IS NULL
        AND fe.stopped_at IS NULL
      RETURNING fe.id AS enrollment_id, fe.estimate_id
    `);
    // [engagement-phase4] Record an inbound reply against each stopped estimate.
    const { recordEngagementEvent } = await import("../lib/engagement.js");
    for (const r of (stopped as any).rows ?? []) {
      await recordEngagementEvent({
        companyId, estimateId: r.estimate_id, enrollmentId: r.enrollment_id,
        eventType: "replied", channel: "sms", recipient: digits,
        meta: { reason },
      });
    }
    console.log(`[follow-up] Stopped ${((stopped as any).rows ?? []).length} estimate enrollment(s) by phone ${digits} (company=${companyId}) — reason: ${reason}`);
  } catch (err) {
    console.error("[follow-up] stopEstimateEnrollmentsByPhone error (non-fatal):", err);
  }
}

// ── Stop abandoned-booking enrollments (the customer finished booking) ──────────
// Keyed by email since /book/confirm knows the email, not the abandoned row id.
// Run BEFORE the confirm-time DELETE of the abandoned_bookings row (the FK is
// ON DELETE SET NULL, so a delete only nulls the link on an already-stopped row).
export async function stopEnrollmentsForAbandonedBooking(
  companyId: number,
  email: string,
  reason: string,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE follow_up_enrollments fe
      SET stopped_at = NOW(), stopped_reason = ${reason}
      FROM abandoned_bookings ab
      WHERE fe.abandoned_booking_id = ab.id
        AND ab.company_id = ${companyId}
        AND lower(ab.email) = lower(${email})
        AND fe.completed_at IS NULL
        AND fe.stopped_at IS NULL
    `);
    console.log(`[follow-up] Stopped abandoned_booking enrollments for ${email} — reason: ${reason}`);
  } catch (err) {
    console.error("[follow-up] stopEnrollmentsForAbandonedBooking error (non-fatal):", err);
  }
}

// ── Process due enrollments (cron body) ───────────────────────────────────────
export async function processDueEnrollments(): Promise<void> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] processDueEnrollments suppressed — COMMS_ENABLED=false");
    return;
  }
  try {
    const due = await db.execute(sql`
      SELECT
        fe.id, fe.company_id, fe.sequence_id, fe.quote_id, fe.client_id, fe.lead_id,
        fe.abandoned_booking_id, fe.estimate_id, fe.current_step,
        fs.name AS sequence_name, fs.sequence_type
      FROM follow_up_enrollments fe
      JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
      WHERE fe.completed_at IS NULL
        AND fe.stopped_at IS NULL
        AND fe.next_fire_at <= NOW()
    `);

    if (!due.rows.length) return;
    console.log(`[follow-up] Processing ${due.rows.length} due enrollment(s)`);

    for (const row of due.rows) {
      const enr = row as any;
      try {
        await processEnrollment(enr);
      } catch (err) {
        console.error(`[follow-up] Error processing enrollment ${enr.id}:`, err);
      }
    }
  } catch (err) {
    console.error("[follow-up] processDueEnrollments error:", err);
  }
}

// Returns the outcome of the touch it just processed (used by the immediate
// "Send now" path to report whether the email actually went out). The cron
// callers ignore the return.
type TouchResult = { channel: string; status: string; recipient: string | null };
async function processEnrollment(enr: any): Promise<TouchResult | null> {
  // Fetch the current step (template_id links to a managed message_templates row)
  const stepRows = await db.execute(sql`
    SELECT id, step_number, delay_hours, channel, subject, message_template, template_id
    FROM follow_up_steps
    WHERE sequence_id = ${enr.sequence_id} AND step_number = ${enr.current_step}
    LIMIT 1
  `);
  if (!stepRows.rows.length) {
    // No step found — mark complete
    await db.execute(sql`
      UPDATE follow_up_enrollments SET completed_at = NOW() WHERE id = ${enr.id}
    `);
    return null;
  }
  const step = stepRows.rows[0] as any;

  // Resolve recipient + zip (for branch routing) from linked client, quote, or lead.
  let firstName = "";
  let recipientEmail: string | null = null;
  let recipientPhone: string | null = null;
  let zip: string | null = null;
  // [multi-recipient-estimates] Extra CC emails (estimate enrollments only).
  let ccEmails: string[] = [];

  if (enr.client_id) {
    const clientRows = await db.execute(sql`
      SELECT first_name, email, phone, zip FROM clients WHERE id = ${enr.client_id} LIMIT 1
    `);
    if (clientRows.rows.length) {
      const c = clientRows.rows[0] as any;
      firstName = c.first_name || "";
      recipientEmail = c.email || null;
      recipientPhone = c.phone || null;
      zip = c.zip || null;
    }
  } else if (enr.quote_id) {
    const quoteRows = await db.execute(sql`
      SELECT lead_name, lead_email, lead_phone, address FROM quotes WHERE id = ${enr.quote_id} LIMIT 1
    `);
    if (quoteRows.rows.length) {
      const q = quoteRows.rows[0] as any;
      firstName = (q.lead_name || "").split(" ")[0] || "";
      recipientEmail = q.lead_email || null;
      recipientPhone = q.lead_phone || null;
      zip = (String(q.address || "").match(/\b(\d{5})\b/) || [])[1] || null;
    }
  } else if (enr.lead_id) {
    const leadRows = await db.execute(sql`
      SELECT first_name, email, phone, zip FROM leads WHERE id = ${enr.lead_id} LIMIT 1
    `);
    if (leadRows.rows.length) {
      const l = leadRows.rows[0] as any;
      firstName = l.first_name || "";
      recipientEmail = l.email || null;
      recipientPhone = l.phone || null;
      zip = l.zip || null;
    }
  } else if (enr.abandoned_booking_id) {
    const abRows = await db.execute(sql`
      SELECT first_name, email, phone, zip FROM abandoned_bookings WHERE id = ${enr.abandoned_booking_id} LIMIT 1
    `);
    if (abRows.rows.length) {
      const a = abRows.rows[0] as any;
      firstName = a.first_name || "";
      recipientEmail = a.email || null;
      recipientPhone = a.phone || null;
      zip = a.zip || null;
    }
  } else if (enr.estimate_id) {
    const estRows = await db.execute(sql`
      SELECT contact_name, contact_email, cc_emails, contact_phone, service_address FROM estimates WHERE id = ${enr.estimate_id} LIMIT 1
    `);
    if (estRows.rows.length) {
      const e = estRows.rows[0] as any;
      firstName = (e.contact_name || "").split(" ")[0] || "";
      recipientEmail = e.contact_email || null;
      ccEmails = String(e.cc_emails || "").split(",").map((s: string) => s.trim()).filter(Boolean);
      recipientPhone = e.contact_phone || null;
      zip = (String(e.service_address || "").match(/\b(\d{5})\b/) || [])[1] || null;
    }
  }

  // Per-branch routing — every comm goes through getBranchByZip (CLAUDE.md).
  const branch = getBranchByZip(zip || "");
  const branchId = branch.branch === "schaumburg" ? 2 : 1;

  // Prefer the managed template (template_id) over the step's inline copy.
  let rawBody = step.message_template || "";
  let rawSubject = step.subject || "";
  if (step.template_id) {
    const tplRows = await db.execute(sql`
      SELECT body, subject FROM message_templates
      WHERE id = ${step.template_id} AND company_id = ${enr.company_id} AND active = true LIMIT 1
    `);
    if (tplRows.rows.length) {
      const t = tplRows.rows[0] as any;
      rawBody = t.body || rawBody;
      rawSubject = t.subject || rawSubject;
    }
  }

  const ci = await companyInfo(enr.company_id);
  const mergeVars: Record<string, string> = {
    first_name:    firstName,
    company_name:  ci.name,
    company_phone: ci.phone,
    company_email: ci.email,
  };
  // Quote-tied enrollments (the quote email/SMS) get the full quote merge set:
  // public estimate link, total, itemized line items, address, contact, brand.
  if (enr.quote_id) Object.assign(mergeVars, await buildQuoteMergeVars(enr.company_id, enr.quote_id));
  // Estimate enrollments get the commercial-estimate merge set (contact, property,
  // monthly total, hosted view link).
  if (enr.estimate_id) Object.assign(mergeVars, await buildEstimateMergeVars(enr.company_id, enr.estimate_id, enr.id));
  // Abandoned-booking enrollments get {{resume_link}} (the company booking page)
  // + {{office_phone}} (the steps reference both).
  if (enr.abandoned_booking_id) {
    const slugRows = await db.execute(sql`SELECT slug FROM companies WHERE id = ${enr.company_id} LIMIT 1`);
    const slug = (slugRows.rows[0] as any)?.slug;
    const base = appBaseUrl();
    mergeVars.resume_link = slug ? `${base}/book/${slug}` : `${base}/book`;
    mergeVars.office_phone = mergeVars.company_phone;
  }
  let body      = resolveMergeFields(rawBody, mergeVars);
  const subject = rawSubject ? resolveMergeFields(rawSubject, mergeVars) : "";
  const emailBrand: EmailBrand = { companyName: mergeVars.company_name, phone: mergeVars.company_phone, email: mergeVars.company_email };
  // Append a 1x1 open pixel to an estimate email body for `recipient`, minted so
  // the open attributes to that exact person. Used per-recipient below.
  const withPixel = async (b: string, recipient: string): Promise<string> => {
    if (!(enr.estimate_id && step.channel === "email")) return b;
    try {
      const { createOpenPixel } = await import("../lib/engagement.js");
      const px = await createOpenPixel({ companyId: enr.company_id, estimateId: enr.estimate_id, enrollmentId: enr.id, recipient });
      return px ? `${b}\n<img src="${px}" width="1" height="1" alt="" style="display:none" />` : b;
    } catch { return b; }
  };

  let sendStatus = "sent";
  let sendError  = "";
  // Resolve the per-branch sender once; gates BOTH channels on
  // global master (COMMS_ENABLED) AND company master AND the branch comms flag.
  const sender = await resolveSender(enr.company_id, branchId);
  // Email rides Resend (not Twilio), so it only needs the master/company/branch
  // gates — not from_number/creds. SMS needs the full sender.reason check.
  const masterGate = process.env.COMMS_ENABLED === "true" && sender.company_comms_enabled && sender.enabled && sender.branch_comms_enabled;
  // [comms-opt-out] Per-recipient opt-out gate (in addition to the comms gates).
  const { isSmsOptedOut, isEmailOptedOut, buildEmailUnsubData } = await import("../lib/opt-out.js");
  try {
    if (step.channel === "sms" && recipientPhone) {
      if (await isSmsOptedOut(enr.company_id, recipientPhone)) {
        sendStatus = "blocked";
        sendError  = "sms_opt_out";
        console.log(`[follow-up] SMS suppressed (sms_opt_out) enrollment ${enr.id}`);
      } else if (sender.reason) {
        sendStatus = "blocked";
        sendError  = sender.reason;
        console.log(`[follow-up] SMS suppressed (${sender.reason}) enrollment ${enr.id}`);
      } else {
        await sendSmsVia(sender, recipientPhone, body);
      }
    } else if (step.channel === "email" && recipientEmail) {
      if (await isEmailOptedOut(enr.company_id, recipientEmail)) {
        sendStatus = "blocked";
        sendError  = "email_opt_out";
        console.log(`[follow-up] email suppressed (email_opt_out) enrollment ${enr.id}`);
      } else if (!masterGate) {
        sendStatus = "blocked";
        sendError  = sender.reason || "branch_comms_disabled";
        console.log(`[follow-up] email suppressed (${sendError}) enrollment ${enr.id}`);
      } else {
        const fromAddr = await companyFromAddress(enr.company_id);
        if (enr.estimate_id) {
          // [per-recipient-tracking] Estimate touches send an individual email to
          // each recipient (To + every CC) with their OWN tracked link + open
          // pixel, so opens/clicks attribute to the exact person. The To send
          // drives the touch status; CC failures are logged, not fatal.
          const recipients = [...new Set([recipientEmail, ...ccEmails].map(s => s.trim().toLowerCase()).filter(Boolean))];
          for (let i = 0; i < recipients.length; i++) {
            const rcpt = recipients[i];
            if (i > 0 && await isEmailOptedOut(enr.company_id, rcpt)) continue;
            const rVars = { ...mergeVars, ...(await buildEstimateMergeVars(enr.company_id, enr.estimate_id, enr.id, rcpt)) };
            const rBody = await withPixel(resolveMergeFields(rawBody, rVars), rcpt);
            const rUnsub = await buildEmailUnsubData(enr.company_id, rcpt);
            if (i === 0) {
              await sendEmail(rcpt, subject, rBody, fromAddr, emailBrand, rUnsub ?? undefined);
            } else {
              try { await sendEmail(rcpt, subject, rBody, fromAddr, emailBrand, rUnsub ?? undefined); }
              catch (e: any) { console.error(`[follow-up] CC send failed (${rcpt}) enrollment ${enr.id}:`, e?.message || e); }
            }
          }
        } else {
          const unsub = await buildEmailUnsubData(enr.company_id, recipientEmail);
          await sendEmail(recipientEmail, subject, body, fromAddr, emailBrand, unsub ?? undefined, ccEmails);
        }
      }
    } else {
      sendStatus = "failed";
      sendError  = "No recipient contact info";
    }
  } catch (err: any) {
    sendStatus = "failed";
    sendError  = err?.message || "Send error";
    console.error(`[follow-up] Send error for enrollment ${enr.id} step ${step.step_number}:`, sendError);
  }

  // Log the message
  await db.execute(sql`
    INSERT INTO message_log
      (company_id, enrollment_id, client_id, channel, recipient_phone, recipient_email,
       subject, body, status, sequence_name, step_number)
    VALUES
      (${enr.company_id}, ${enr.id}, ${enr.client_id || null},
       ${step.channel}, ${recipientPhone}, ${recipientEmail},
       ${subject || null}, ${body}, ${sendStatus},
       ${enr.sequence_name}, ${step.step_number})
  `);

  // [engagement-phase4] Fan the cadence send into the engagement timeline
  // (estimate enrollments only). sent → 'sent'; otherwise → 'failed' with reason.
  if (enr.estimate_id) {
    const { recordEngagementEvent } = await import("../lib/engagement.js");
    await recordEngagementEvent({
      companyId: enr.company_id,
      estimateId: enr.estimate_id,
      enrollmentId: enr.id,
      eventType: sendStatus === "sent" ? "sent" : "failed",
      channel: step.channel,
      recipient: step.channel === "sms" ? recipientPhone : recipientEmail,
      meta: { step_number: step.step_number, status: sendStatus, ...(sendError ? { error: sendError } : {}) },
    });
  }

  // Advance or complete — next_fire_at clamped to 8am–9pm America/Chicago.
  const nextStepRows = await db.execute(sql`
    SELECT step_number, delay_hours FROM follow_up_steps
    WHERE sequence_id = ${enr.sequence_id} AND step_number = ${enr.current_step + 1}
    LIMIT 1
  `);

  if (nextStepRows.rows.length) {
    const next = nextStepRows.rows[0] as any;
    const rawNext = new Date(Date.now() + (Number(next.delay_hours) || 0) * 3600 * 1000);
    const fireAt = clampToBusinessHours(rawNext);
    await db.execute(sql`
      UPDATE follow_up_enrollments
      SET current_step = ${next.step_number},
          next_fire_at = ${fireAt.toISOString()}
      WHERE id = ${enr.id}
    `);
    console.log(`[follow-up] Enrollment ${enr.id} advanced to step ${next.step_number} (fires ${fireAt.toISOString()})`);
  } else {
    await db.execute(sql`
      UPDATE follow_up_enrollments SET completed_at = NOW() WHERE id = ${enr.id}
    `);
    console.log(`[follow-up] Enrollment ${enr.id} completed — all steps sent`);
  }
  return { channel: step.channel, status: sendStatus, recipient: step.channel === "sms" ? recipientPhone : recipientEmail };
}

// [estimate-send-now] Fire an estimate's Day-0 touch IMMEDIATELY (instead of
// waiting up to 30 min for the cron), through the same gated processEnrollment
// path (comms gates, opt-out, CC, engagement event, step-advance all apply).
// Returns whether the email actually went out so the office gets instant
// confirmation. Safe no-op if the estimate isn't enrolled / already advanced.
export async function fireEstimateDay0(
  companyId: number, estimateId: number,
): Promise<{ emailed: boolean; status: string; channel?: string; recipient?: string | null; reason?: string }> {
  try {
    const rows = await db.execute(sql`
      SELECT fe.id, fe.company_id, fe.sequence_id, fe.quote_id, fe.client_id, fe.lead_id,
             fe.abandoned_booking_id, fe.estimate_id, fe.current_step,
             fs.name AS sequence_name, fs.sequence_type
      FROM follow_up_enrollments fe
      JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
      WHERE fe.estimate_id = ${estimateId} AND fe.company_id = ${companyId}
        AND fe.completed_at IS NULL AND fe.stopped_at IS NULL
      ORDER BY fe.id DESC LIMIT 1
    `);
    const enr = (rows as any).rows[0];
    if (!enr) return { emailed: false, status: "not_enrolled", reason: "not_enrolled" };
    // Only fire if still on the first (Day-0) step — never re-send a later touch.
    if (Number(enr.current_step) !== 1) return { emailed: false, status: "already_started", reason: "already_started" };
    const r = await processEnrollment(enr);
    if (!r) return { emailed: false, status: "no_step", reason: "no_step" };
    return { emailed: r.status === "sent" && r.channel === "email", status: r.status, channel: r.channel, recipient: r.recipient, reason: r.status !== "sent" ? r.status : undefined };
  } catch (err: any) {
    console.error("[estimate-send-now] fireEstimateDay0 error:", err?.message ?? err);
    return { emailed: false, status: "error", reason: err?.message ?? "error" };
  }
}

// ── Scoped one-off: send a SINGLE enrollment's current touch ────────────────────
// Sends ONLY the named enrollment's current step. EMAIL goes via Resend directly
// (does NOT depend on COMMS_ENABLED — this path is itself the scoped authorization,
// one enrollment by id). SMS is NOT sent here (needs the per-company Twilio creds);
// it returns sent:false so callers can surface why. Never touches other enrollments.
export async function sendSingleEnrollmentTouch(
  companyId: number, enrollmentId: number, stepOverride?: number,
): Promise<{ sent: boolean; channel?: string; recipient?: string | null; step?: number; reason?: string; advanced_to_step?: number | null; completed?: boolean; provider_id?: string | null; error?: string }> {
  const enrRows = await db.execute(sql`
    SELECT fe.id, fe.company_id, fe.sequence_id, fe.quote_id, fe.client_id, fe.lead_id, fe.estimate_id, fe.current_step,
           fs.name AS sequence_name
    FROM follow_up_enrollments fe
    JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
    WHERE fe.id = ${enrollmentId} AND fe.company_id = ${companyId}
      AND fe.completed_at IS NULL AND fe.stopped_at IS NULL
    LIMIT 1`);
  if (!enrRows.rows.length) return { sent: false, reason: "enrollment_not_found_or_inactive" };
  const enr = enrRows.rows[0] as any;
  const stepNum = stepOverride ?? enr.current_step;

  const stepRows = await db.execute(sql`
    SELECT id, step_number, delay_hours, channel, subject, message_template, template_id
    FROM follow_up_steps WHERE sequence_id = ${enr.sequence_id} AND step_number = ${stepNum} LIMIT 1`);
  if (!stepRows.rows.length) return { sent: false, reason: "step_not_found" };
  const step = stepRows.rows[0] as any;

  // Resolve recipient + zip (branch) from client / quote / lead
  let firstName = "", recipientEmail: string | null = null, recipientPhone: string | null = null, zip: string | null = null;
  if (enr.client_id) {
    const r = await db.execute(sql`SELECT first_name, email, phone, zip FROM clients WHERE id = ${enr.client_id} LIMIT 1`);
    const c = r.rows[0] as any; if (c) { firstName = c.first_name || ""; recipientEmail = c.email || null; recipientPhone = c.phone || null; zip = c.zip || null; }
  } else if (enr.quote_id) {
    const r = await db.execute(sql`SELECT lead_name, lead_email, lead_phone, address FROM quotes WHERE id = ${enr.quote_id} LIMIT 1`);
    const qd = r.rows[0] as any; if (qd) { firstName = (qd.lead_name || "").split(" ")[0] || ""; recipientEmail = qd.lead_email || null; recipientPhone = qd.lead_phone || null; zip = (String(qd.address || "").match(/\b(\d{5})\b/) || [])[1] || null; }
  } else if (enr.lead_id) {
    const r = await db.execute(sql`SELECT first_name, email, phone, zip FROM leads WHERE id = ${enr.lead_id} LIMIT 1`);
    const l = r.rows[0] as any; if (l) { firstName = l.first_name || ""; recipientEmail = l.email || null; recipientPhone = l.phone || null; zip = l.zip || null; }
  } else if (enr.estimate_id) {
    const r = await db.execute(sql`SELECT contact_name, contact_email, contact_phone, service_address FROM estimates WHERE id = ${enr.estimate_id} LIMIT 1`);
    const e = r.rows[0] as any; if (e) { firstName = (e.contact_name || "").split(" ")[0] || ""; recipientEmail = e.contact_email || null; recipientPhone = e.contact_phone || null; zip = (String(e.service_address || "").match(/\b(\d{5})\b/) || [])[1] || null; }
  }
  const branch = getBranchByZip(zip || "");

  // Prefer managed template, else inline copy; render merge fields
  let rawBody = step.message_template || "", rawSubject = step.subject || "";
  if (step.template_id) {
    const t = await db.execute(sql`SELECT body, subject FROM message_templates WHERE id = ${step.template_id} AND company_id = ${companyId} AND active = true LIMIT 1`);
    if (t.rows.length) { rawBody = (t.rows[0] as any).body || rawBody; rawSubject = (t.rows[0] as any).subject || rawSubject; }
  }
  const ci = await companyInfo(companyId);
  const mergeVars: Record<string, string> = { first_name: firstName, company_name: ci.name, company_phone: ci.phone, company_email: ci.email };
  if (enr.quote_id) Object.assign(mergeVars, await buildQuoteMergeVars(companyId, enr.quote_id));
  if (enr.estimate_id) Object.assign(mergeVars, await buildEstimateMergeVars(companyId, enr.estimate_id, enr.id));
  const body = resolveMergeFields(rawBody, mergeVars);
  const subject = rawSubject ? resolveMergeFields(rawSubject, mergeVars) : "";
  const emailBrand: EmailBrand = { companyName: mergeVars.company_name, phone: mergeVars.company_phone, email: mergeVars.company_email };

  // ── Send the touch. EMAIL → Resend raw; SMS → Twilio raw via the saved
  //    company creds + branch from-number. BOTH bypass the global COMMS_ENABLED
  //    gate — the per-enrollment scope IS the authorization. ──────────────────
  const branchId = branch.branch === "schaumburg" ? 2 : 1;
  let providerId: string | null = null;
  let recipient: string | null = null;
  let logStatus = "sent", logErr = "";

  if (step.channel === "email") {
    if (!recipientEmail) return { sent: false, channel: "email", reason: "no_recipient_email", step: step.step_number };
    recipient = recipientEmail;
    try {
      providerId = await sendEmailRaw(recipientEmail, subject, body, await companyFromAddress(companyId), emailBrand);
    } catch (e: any) {
      logStatus = "failed"; logErr = e?.message || "email_send_error";
    }
  } else if (step.channel === "sms") {
    if (!recipientPhone) return { sent: false, channel: "sms", reason: "no_recipient_phone", step: step.step_number };
    recipient = recipientPhone;
    // resolveSender returns creds + branch from-number even when its gate `reason`
    // is set; we deliberately ignore reason here (scoped one-off) but still
    // require the physical creds + a from-number to actually send.
    const sender = await resolveSender(companyId, branchId);
    if (!sender.account_sid || !sender.auth_token) return { sent: false, channel: "sms", recipient: recipientPhone, step: step.step_number, reason: "twilio_unconfigured" };
    if (!sender.from_number) return { sent: false, channel: "sms", recipient: recipientPhone, step: step.step_number, reason: "no_from_number" };
    try {
      const tw = await sendSmsVia(sender, recipientPhone, body);
      providerId = tw?.sid ?? null;
    } catch (e: any) {
      logStatus = "failed"; logErr = e?.message || "sms_send_error";
    }
  } else {
    return { sent: false, channel: step.channel, step: step.step_number, reason: "unsupported_channel" };
  }

  await db.execute(sql`
    INSERT INTO message_log
      (company_id, enrollment_id, client_id, channel, recipient_phone, recipient_email,
       subject, body, status, sequence_name, step_number)
    VALUES (${companyId}, ${enr.id}, ${enr.client_id || null}, ${step.channel}, ${recipientPhone}, ${recipientEmail},
            ${subject || null}, ${body}, ${logStatus}, ${enr.sequence_name}, ${step.step_number})`);

  if (logStatus === "failed") {
    return { sent: false, channel: step.channel, recipient, step: step.step_number, reason: "send_failed", error: logErr };
  }

  // Advance ONLY when we sent the enrollment's CURRENT step (a stepOverride
  // re-send of an earlier step must not rewind/advance the cadence).
  let advancedTo: number | null = null, completed = false;
  if (step.step_number === enr.current_step) {
    const next = await db.execute(sql`SELECT step_number, delay_hours FROM follow_up_steps WHERE sequence_id = ${enr.sequence_id} AND step_number = ${enr.current_step + 1} LIMIT 1`);
    if (next.rows.length) {
      const n = next.rows[0] as any;
      const fireAt = clampToBusinessHours(new Date(Date.now() + (Number(n.delay_hours) || 0) * 3600 * 1000));
      await db.execute(sql`UPDATE follow_up_enrollments SET current_step = ${n.step_number}, next_fire_at = ${fireAt.toISOString()} WHERE id = ${enr.id}`);
      advancedTo = n.step_number;
    } else {
      await db.execute(sql`UPDATE follow_up_enrollments SET completed_at = NOW() WHERE id = ${enr.id}`);
      completed = true;
    }
  }
  console.log(`[follow-up] one-off ${step.channel} sent for enrollment ${enr.id} step ${step.step_number} → ${recipient} [branch=${branch.branch}] provider=${providerId}`);
  return { sent: true, channel: step.channel, recipient, step: step.step_number, advanced_to_step: advancedTo, completed, provider_id: providerId };
}
