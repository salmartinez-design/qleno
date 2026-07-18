/**
 * Follow-Up Sequence Engine
 * Handles enrollment, processing, and stop logic for automated follow-up sequences.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { resolveSender, sendSmsVia } from "../lib/comms-sender.js";
import { getBranchByZip } from "../lib/branchRouter.js";
import { appBaseUrl, emailLogoUrl } from "../lib/app-url.js";
import { shortenUrl } from "../lib/short-link.js";
import { estTimeLabel } from "../lib/estimated-time.js";
import { renderPhesQuote, type QuoteOption } from "../lib/phes-quote-email.js";

// ── Merge field resolver ───────────────────────────────────────────────────────
function resolveMergeFields(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

// [sms-opt-out 2026-07-09] Every marketing/drip TEXT must carry opt-out language
// (TCPA/CTIA — Sal: "Stop SMS has to be enabled per law"). Appended to every
// follow-up SMS at send time. Idempotent: if the copy already mentions STOP we
// leave it, so a tenant that writes their own opt-out line isn't doubled up.
// (Email opt-out is handled separately via buildEmailUnsubData / unsubscribe
// link. Transactional messages go through notificationService, not this file.)
function appendSmsOptOut(body: string): string {
  const b = (body || "").trim();
  if (/\bSTOP\b/i.test(b)) return b;
  return `${b}\n\nReply STOP to opt out`;
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
  // A COMPLETE HTML document (the bespoke quote email) is sent as-is — the
  // branded shell would nest a second <html> inside a <div>. The unsub footer
  // slots in before </body> so the one-click headers + visible link still apply.
  const isFullDoc = /^\s*(<!doctype|<html)/i.test(body);
  const bodyHtml = isFullDoc
    ? (unsub?.footerHtml ? body.replace(/<\/body>/i, `${unsub.footerHtml}</body>`) : body)
    : `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#F7F6F3;">
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

// Returns the Resend email ID (for delivery tracking / comms-log) or null when
// suppressed. Existing callers that ignore the return value are unaffected.
async function sendEmail(to: string, subject: string, body: string, fromAddress?: string, brand?: EmailBrand, unsub?: { headers: Record<string, string>; footerHtml: string }, cc?: string[]): Promise<string | null> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] Follow-up email suppressed:", { to, subject });
    return null;
  }
  return await sendEmailRaw(to, subject, body, fromAddress, brand, unsub, cc);
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
  const est = estTimeLabel(q.manual_hours) || estTimeLabel(q.estimated_hours);
  const estLine = est ? `<p style="font-size:13px;color:#6B6860;margin:2px 0 0;">Estimated time &middot; ${est}</p>` : "";
  const table = `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0;">${rows.join("")}<tr><td style="padding:8px 0 0;font-weight:700;border-top:1px solid #E5E2DC;">Total</td><td style="padding:8px 0 0;text-align:right;font-weight:700;border-top:1px solid #E5E2DC;">$${Number(total).toFixed(2)}</td></tr></table>`;
  if (!showHeading) return `${estLine}${table}`;
  const freq = quoteFreqLabel(q.frequency);
  return `<p style="font-size:15px;font-weight:700;color:#1A1917;margin:16px 0 2px;">${q.service_type || "Cleaning service"}${freq ? ` &middot; ${freq}` : ""}</p>${estLine}${table}`;
}

// Shared loader for the quote email surfaces: the triggering quote (+ company
// brand) and EVERY still-open quote for that lead, one-time options first.
// Used by buildQuoteMergeVars (legacy {{line_items}} vars, SMS) and
// buildPhesQuoteEmailHtml (the bespoke on-brand email).
async function loadQuoteEmailData(companyId: number, quoteId: number): Promise<{ q: any; quotes: any[] } | null> {
  const r = await db.execute(sql`
    SELECT q.id, q.total_price, q.base_price, q.address, q.service_type, q.frequency, q.addons,
           q.sign_token, q.lead_email, q.lead_phone, q.client_id, q.estimated_hours, q.manual_hours,
           c.name AS company_name, c.phone AS company_phone, c.email AS company_email, c.logo_url AS company_logo
    FROM quotes q JOIN companies c ON c.id = q.company_id
    WHERE q.id = ${quoteId} AND q.company_id = ${companyId} LIMIT 1
  `);
  const q: any = r.rows[0];
  if (!q) return null;

  // All of this lead's still-open quotes. Match by client_id when known, else by
  // lead email/phone. Only quotes actually sent to the customer (or this trigger),
  // excluding anything already accepted / booked / expired / declined. One-time
  // options list before recurring so the "book now" clean reads first.
  const leadEmail = String(q.lead_email || "").trim().toLowerCase();
  const leadPhone10 = String(q.lead_phone || "").replace(/\D/g, "").slice(-10);
  const allRows = await db.execute(sql`
    SELECT id, total_price, base_price, service_type, frequency, addons, sign_token,
           estimated_hours, manual_hours
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
  return { q, quotes };
}

// One quote row → a bespoke-template option card (itemized rows + est. time +
// its own /book-quote/<token> deep link).
function quoteAsOption(qq: any): QuoteOption {
  const rows: { label: string; amount: string }[] = [];
  if (qq.base_price != null) rows.push({ label: qq.service_type || "Cleaning service", amount: `$${Number(qq.base_price).toFixed(2)}` });
  for (const a of (Array.isArray(qq.addons) ? qq.addons : [])) {
    const amt = a?.amount ?? a?.price;
    rows.push({ label: a?.name || "Add-on", amount: amt != null ? `+$${Number(amt).toFixed(2)}` : "—" });
  }
  return {
    title: qq.service_type || "Cleaning service",
    freqLabel: quoteFreqLabel(qq.frequency),
    estTime: estTimeLabel(qq.manual_hours) || estTimeLabel(qq.estimated_hours),
    rows,
    total: `$${Number(qq.total_price ?? qq.base_price ?? 0).toFixed(2)}`,
    bookUrl: qq.sign_token ? `${appBaseUrl()}/book-quote/${qq.sign_token}` : "",
  };
}

// The bespoke on-brand quote email (renderPhesQuote — same family as the
// booking confirmation), with every open option itemized + a Book button per
// option. Returns null for non-Phes tenants (they keep the plain template) or
// when the quote can't be loaded, so callers can fall back safely.
export async function buildPhesQuoteEmailHtml(companyId: number, quoteId: number, firstName: string): Promise<string | null> {
  const data = await loadQuoteEmailData(companyId, quoteId);
  if (!data) return null;
  const { q, quotes } = data;
  if (!/phes/i.test(q.company_name || "")) return null;
  return renderPhesQuote({
    logoUrl: emailLogoUrl(q.company_logo),
    companyName: q.company_name || "Phes",
    companyPhone: q.company_phone || "(773) 706-6000",
    companyPhoneTel: q.company_phone ? String(q.company_phone).replace(/[^\d+]/g, "") : "+17737066000",
    companyEmail: q.company_email || "info@phes.io",
    website: "phes.io",
    firstName,
    serviceAddress: q.address || "",
    options: quotes.map(quoteAsOption),
    checklistUrl: "https://phes.io/cleaning-checklist",
  });
}

// Build the merge vars for a quote-tied enrollment touch (the quote email + SMS).
// Pulls the triggering quote for the customer-facing link + brand info, then
// gathers EVERY open quote for that lead so the customer sees all the options
// they were quoted (e.g. a one-time deep clean AND a recurring plan), each
// itemized, even the ones that didn't trigger this drip. Returns extra vars
// merged on top of the base {first_name, company_name}.
async function buildQuoteMergeVars(companyId: number, quoteId: number): Promise<Record<string, string>> {
  const data = await loadQuoteEmailData(companyId, quoteId);
  if (!data) return {};
  const { q, quotes } = data;
  const total = q.total_price ?? q.base_price ?? "0";
  // Residential quotes use the /quote/ route (the hosted page self-labels as
  // "Quote"). Clean short link for the customer SMS/email; falls back to full URL.
  const fullLink = q.sign_token ? `${appBaseUrl()}/quote/${q.sign_token}` : `${appBaseUrl()}/quote`;
  const link = q.sign_token ? ((await shortenUrl(fullLink, companyId)) || fullLink) : fullLink;
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
  // [cart-drip-visible 2026-07-09] The lead this abandoned booking maps to.
  // Stamped onto the enrollment so the cart drip shows on the LEAD card + Drip
  // tab (both key off lead_id) and auto-fires there — before this, the cart
  // drip ran only against the hidden abandoned_bookings row, so the lead read
  // "No drip running" even though it was firing.
  leadId?: number | null,
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
    if (existing.rows.length > 0) {
      // Already enrolled (e.g. a repeat abandon on the same email). Backfill the
      // lead link if it wasn't set yet, so the lead surfaces the running drip.
      if (leadId != null) {
        await db.execute(sql`
          UPDATE follow_up_enrollments SET lead_id = ${leadId}
          WHERE id = ${(existing.rows[0] as any).id} AND lead_id IS NULL
        `);
      }
      return;
    }

    await db.execute(sql`
      INSERT INTO follow_up_enrollments
        (company_id, sequence_id, abandoned_booking_id, lead_id, current_step, next_fire_at)
      VALUES
        (${companyId}, ${sequenceId}, ${abandonedBookingId}, ${leadId ?? null}, 1, NOW() + INTERVAL '20 minutes')
    `);
    console.log(`[follow-up] Enrolled abandoned_booking ${abandonedBookingId} (lead ${leadId ?? "—"}) in abandoned_booking sequence ${sequenceId}`);
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
    // [cart-drip-visible 2026-07-09] If this lead already has an active
    // abandoned-booking (cart) drip, that drip OWNS the conversation — don't
    // stack a second lead drip on top (an abandoner who later submits a full
    // quote would otherwise get double-texted). The cart drip is the more
    // specific, purpose-built sequence, so it wins.
    const cart = await db.execute(sql`
      SELECT fe.id FROM follow_up_enrollments fe
      JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
      WHERE fe.lead_id = ${leadId} AND fs.sequence_type = 'abandoned_booking'
        AND fe.completed_at IS NULL AND fe.stopped_at IS NULL
      LIMIT 1
    `);
    if (cart.rows.length > 0) {
      console.log(`[follow-up] lead ${leadId} already in abandoned_booking (cart) drip — skipping ${seqType} to avoid a double drip.`);
      return;
    }
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

// ── Stop only the LEAD DRIP enrollments for a lead ────────────────────────────
// Used at the quoted handoff: the quote_followup cadence takes over the
// conversation, so the nurture drip must stop or the lead gets both.
export async function stopLeadDripEnrollments(
  companyId: number,
  leadId: number,
  reason: string,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE follow_up_enrollments fe
      SET stopped_at = NOW(), stopped_reason = ${reason}
      FROM follow_up_sequences fs
      WHERE fs.id = fe.sequence_id
        AND fe.company_id = ${companyId}
        AND fe.lead_id = ${leadId}
        AND fs.sequence_type IN ('lead_drip_web','lead_drip_phone')
        AND fe.completed_at IS NULL
        AND fe.stopped_at IS NULL
    `);
    console.log(`[follow-up] Stopped lead-drip enrollments for lead ${leadId} — reason: ${reason}`);
  } catch (err) {
    console.error("[follow-up] stopLeadDripEnrollments error (non-fatal):", err);
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

// [booked-send-guard 2026-07-09] The sender (processDueEnrollments) trusts
// `stopped_at` 100% — it never re-checks whether the recipient is already
// booked. So if ANY booking path forgets to stop the enrollment, a booked
// customer keeps getting follow-ups (Francisco: "why are booked clients
// receiving follow up messages?"). This is a catch-all defense at send time:
// right before sending, if the subject is already booked / converted (lead),
// booked / accepted (quote), or a retention target who now has an upcoming job
// (client), we STOP the enrollment and skip the send. It closes the whole class
// no matter which booking path missed its stop hook. Returns a stop reason
// string when the subject is booked, else null. Best-effort — a check error
// never blocks the normal flow (returns null so the send proceeds as before).
async function subjectAlreadyBooked(enr: any): Promise<string | null> {
  try {
    if (enr.lead_id) {
      const r = await db.execute(sql`SELECT status FROM leads WHERE id = ${enr.lead_id} LIMIT 1`);
      const st = String((r.rows[0] as any)?.status ?? "");
      // A lead that's booked (won) or terminal (dead) should not be chased.
      if (["booked", "not_interested", "no_response", "closed"].includes(st)) return `lead_${st}`;
    }
    if (enr.quote_id) {
      const r = await db.execute(sql`SELECT status FROM quotes WHERE id = ${enr.quote_id} LIMIT 1`);
      const st = String((r.rows[0] as any)?.status ?? "");
      if (["booked", "accepted", "converted", "won"].includes(st)) return `quote_${st}`;
    }
    // post_job_retention is a win-back for clients with NO upcoming visit. If a
    // future (non-cancelled) job now exists they've rebooked — stop chasing.
    // Scoped to that sequence type so other client-keyed sequences are unaffected.
    if (enr.client_id && enr.sequence_type === "post_job_retention") {
      const r = await db.execute(sql`
        SELECT 1 FROM jobs
         WHERE client_id = ${enr.client_id} AND company_id = ${enr.company_id}
           AND status NOT IN ('cancelled', 'complete')
           AND scheduled_date >= CURRENT_DATE
         LIMIT 1`);
      if (r.rows.length) return "client_rebooked";
    }
  } catch (e) {
    console.error("[follow-up] subjectAlreadyBooked check failed for enrollment", enr.id, e);
  }
  return null;
}

// Returns the outcome of the touch it just processed (used by the immediate
// "Send now" path to report whether the email actually went out). The cron
// callers ignore the return.
type TouchResult = { channel: string; status: string; recipient: string | null };
// [quoted-lead quick-book 2026-07-11] Resolve the customer's quick-book link for
// a drip touch: their most-recent OPEN, already-sent quote's /book-quote/<token>
// page (their quote → pick date → card on file → booked). This is what keeps a
// quoted lead who clicks a follow-up from being dumped into a blank new-quote
// wizard. Match order mirrors loadQuoteEmailData: the quote keyed to the
// enrollment, else the lead's quote by client_id → email → last-10 phone. Falls
// back to the generic booking wizard ONLY when the lead has no such quote.
async function resolveBookLink(
  companyId: number,
  opts: { clientId?: number | null; quoteId?: number | null; email?: string | null; phone?: string | null },
): Promise<string> {
  const base = appBaseUrl();
  let token: string | null = null;

  if (opts.quoteId) {
    const r = await db.execute(sql`SELECT sign_token FROM quotes WHERE id = ${opts.quoteId} AND company_id = ${companyId} LIMIT 1`);
    token = (r.rows[0] as any)?.sign_token ?? null;
  }
  if (!token) {
    const email = String(opts.email || "").trim().toLowerCase();
    const phone10 = String(opts.phone || "").replace(/\D/g, "").slice(-10);
    const clientId = opts.clientId ?? null;
    if (clientId != null || email || phone10) {
      const r = await db.execute(sql`
        SELECT sign_token FROM quotes
         WHERE company_id = ${companyId}
           AND status NOT IN ('accepted','booked','converted','expired','declined','lost')
           AND sent_at IS NOT NULL
           AND sign_token IS NOT NULL
           AND (
             (${clientId}::int IS NOT NULL AND client_id = ${clientId})
             OR (${email} <> '' AND lower(lead_email) = ${email})
             OR (${phone10} <> '' AND right(regexp_replace(coalesce(lead_phone,''),'\\D','','g'),10) = ${phone10})
           )
         ORDER BY id DESC LIMIT 1`);
      token = (r.rows[0] as any)?.sign_token ?? null;
    }
  }
  if (token) return `${base}/book-quote/${token}`;

  const slugRows = await db.execute(sql`SELECT slug FROM companies WHERE id = ${companyId} LIMIT 1`);
  const slug = (slugRows.rows[0] as any)?.slug;
  return slug ? `${base}/book/${slug}` : `${base}/book`;
}

async function processEnrollment(enr: any): Promise<TouchResult | null> {
  // [booked-send-guard 2026-07-09] Skip + stop before doing any work if the
  // subject is already booked/converted — see subjectAlreadyBooked above.
  const bookedReason = await subjectAlreadyBooked(enr);
  if (bookedReason) {
    await db.execute(sql`
      UPDATE follow_up_enrollments SET stopped_at = NOW(), stopped_reason = ${bookedReason}
       WHERE id = ${enr.id} AND stopped_at IS NULL`);
    console.log(`[follow-up] enrollment ${enr.id} stopped pre-send (${bookedReason}) — subject already booked`);
    return null;
  }
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
  // [quoted-lead quick-book 2026-07-11] Every drip touch gets {{book_link}} — the
  // lead's existing quote's /book-quote page when they have one, else the generic
  // booking wizard. So a quoted lead clicking any follow-up lands on THEIR quote
  // to book in a tap, instead of rebuilding a quote from scratch.
  const bookLink = await resolveBookLink(enr.company_id, {
    clientId: enr.client_id ?? null,
    quoteId: enr.quote_id ?? null,
    email: recipientEmail,
    phone: recipientPhone,
  });
  mergeVars.book_link = bookLink;
  // Abandoned-booking enrollments' {{resume_link}} now points at the same target
  // (their quote when one exists), plus {{office_phone}} the steps reference.
  if (enr.abandoned_booking_id) {
    let resumeLink = bookLink;
    // [resume-link 2026-07-18] No quote (pre-price abandon) → bookLink is a blank
    // /book form. Attach the resume token so the widget pre-fills the captured
    // contact + home details and drops them where they left off. If a quote DOES
    // exist, bookLink is already the pre-filled /book-quote quick-book — leave it.
    if (!bookLink.includes("/book-quote/")) {
      try {
        const rt = await db.execute(sql`SELECT resume_token FROM abandoned_bookings WHERE id = ${enr.abandoned_booking_id} LIMIT 1`);
        const token = (rt.rows[0] as any)?.resume_token;
        if (token) resumeLink = bookLink + (bookLink.includes("?") ? "&" : "?") + "resume=" + token;
      } catch { /* fall back to the plain book link */ }
    }
    mergeVars.resume_link = resumeLink;
    mergeVars.office_phone = mergeVars.company_phone;
  }
  let body      = resolveMergeFields(rawBody, mergeVars);
  // [quote-email-live] The quote-delivery touch (the template carrying
  // {{line_items}}) sends the bespoke on-brand quote email — same design family
  // as the booking confirmation, every open option itemized with its own Book
  // button. Phes-only; other tenants (and any load failure) keep the plain
  // template rendered above. Subject stays the office-edited template subject.
  if (enr.quote_id && step.channel === "email" && /\{\{\s*line_items\s*\}\}/.test(rawBody)) {
    const bespoke = await buildPhesQuoteEmailHtml(enr.company_id, enr.quote_id, firstName).catch(() => null);
    if (bespoke) body = bespoke;
  }
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
  // [quote-email-tracking] Resend ID of the delivered quote email, captured so
  // it can be logged to communication_log (comms log + delivery webhook).
  let emailProviderId: string | null = null;
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
        await sendSmsVia(sender, recipientPhone, appendSmsOptOut(body));
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
          emailProviderId = await sendEmail(recipientEmail, subject, body, fromAddr, emailBrand, unsub ?? undefined, ccEmails);
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

  // [quote-email-tracking 2026-07-16] The quote-delivery email (cadence touch 1)
  // also lands in communication_log so the office sees it in the comms log AND
  // gets delivered/opened/bounced updates via the Resend webhook
  // (POST /api/comms/email/webhook keys off resend_email_id). Only on a real
  // send with a captured Resend ID — a blocked/suppressed touch writes nothing
  // here (message_log above already records the attempt). Best-effort: a log
  // failure must never break the cadence.
  if (enr.quote_id && step.channel === "email" && sendStatus === "sent" && emailProviderId && recipientEmail) {
    try {
      await db.execute(sql`
        INSERT INTO communication_log
          (company_id, customer_id, quote_id, direction, channel, subject, body,
           source, recipient, resend_email_id, delivery_status, logged_at)
        VALUES
          (${enr.company_id}, ${enr.client_id || null}, ${enr.quote_id}, 'outbound',
           'email', ${subject || null}, ${body}, 'quote_email', ${recipientEmail},
           ${emailProviderId}, 'sent', now())
      `);
    } catch (logErr: any) {
      console.error(`[follow-up] comms-log insert failed (quote ${enr.quote_id}):`, logErr?.message || logErr);
    }
  }

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

// [seq-test-run 2026-07-09] Owner/admin/OFFICE real-time sequence tester (like
// GHL): fire a sequence's messages to a TEST phone/email right now so staff can
// preview the whole campaign land, without waiting the real delays. Sample
// merge data is filled in, every message is prefixed "[TEST]", and NOTHING is
// persisted — no enrollment, no message_log, no analytics, no lead. It bypasses
// the COMMS_ENABLED / company / branch gate ladder exactly like testSendService
// (staff-sanctioned) but still requires real Twilio/Resend creds. Tenant-scoped
// by companyId. Pass stepNumber to fire ONE step (the step-through UI); omit it
// to fire the whole sequence (the fast auto-run UI).
export type SeqTestStepResult = {
  step_number: number; channel: string; status: "sent" | "skipped" | "failed";
  recipient: string | null; error?: string; subject?: string | null; preview?: string;
};
export async function runSequenceTest(
  companyId: number,
  sequenceId: number,
  opts: { toPhone?: string | null; toEmail?: string | null; stepNumber?: number | null },
): Promise<{ sequence_name: string; results: SeqTestStepResult[] }> {
  const seqRows = await db.execute(sql`
    SELECT id, name FROM follow_up_sequences
    WHERE id = ${sequenceId} AND company_id = ${companyId} LIMIT 1`);
  if (!seqRows.rows.length) throw new Error("sequence_not_found");
  const seqName = String((seqRows.rows[0] as any).name);

  const stepRows = await db.execute(sql`
    SELECT step_number, channel, subject, message_template
    FROM follow_up_steps
    WHERE sequence_id = ${sequenceId}
      ${opts.stepNumber != null ? sql`AND step_number = ${opts.stepNumber}` : sql``}
    ORDER BY step_number ASC`);

  const info = await companyInfo(companyId);
  const fromAddr = await companyFromAddress(companyId);
  // Sample merge data so every {{field}} renders something real in the preview.
  // Unknown fields resolve to "" via resolveMergeFields, so this covers the
  // common lead/quote/estimate/cart fields; anything else just blanks out.
  const vars: Record<string, string> = {
    first_name: "Alex", last_name: "Sample", name: "Alex Sample",
    company_name: info.name || "our team",
    company_phone: info.phone || "", office_phone: info.phone || "", company_email: info.email || "",
    resume_link: "https://app.qleno.com/book?resume=test",
    quote_link: "https://app.qleno.com/quote/test", estimate_link: "https://app.qleno.com/estimate/test",
    line_items: "Deep Clean (2,000 sqft), Oven Cleaning", quote_total: "$581.00",
    monthly: "$0.00", property: "123 Sample St",
  };

  const results: SeqTestStepResult[] = [];
  let sender: any = null;
  for (const st of stepRows.rows as any[]) {
    const channel = String(st.channel);
    const body = resolveMergeFields(String(st.message_template || ""), vars);
    const subject = st.subject ? resolveMergeFields(String(st.subject), vars) : null;
    try {
      if (channel === "email") {
        if (!opts.toEmail) { results.push({ step_number: st.step_number, channel, status: "skipped", recipient: null, error: "no test email entered", subject, preview: body }); continue; }
        await sendEmailRaw(opts.toEmail, `[TEST] ${subject ?? seqName}`, body, fromAddr);
        results.push({ step_number: st.step_number, channel, status: "sent", recipient: opts.toEmail, subject, preview: body });
      } else {
        if (!opts.toPhone) { results.push({ step_number: st.step_number, channel, status: "skipped", recipient: null, error: "no test phone entered", subject: null, preview: body }); continue; }
        if (!sender) sender = await resolveSender(companyId, null);
        if (!sender.account_sid || !sender.auth_token) throw new Error("Texting is not set up (Twilio credentials missing)");
        if (!sender.from_number) throw new Error("No from-number configured for texts");
        const smsOut = appendSmsOptOut(`[TEST] ${body}`);
        await sendSmsVia(sender, opts.toPhone, smsOut);
        results.push({ step_number: st.step_number, channel, status: "sent", recipient: opts.toPhone, subject: null, preview: smsOut });
      }
    } catch (e: any) {
      results.push({ step_number: st.step_number, channel, status: "failed", recipient: channel === "email" ? (opts.toEmail ?? null) : (opts.toPhone ?? null), error: String(e?.message || e), subject, preview: body });
    }
  }
  const sent = results.filter(r => r.status === "sent").length;
  console.log(`[follow-up] TEST run seq ${sequenceId} "${seqName}" → ${sent}/${results.length} sent (phone=${opts.toPhone ? "y" : "n"} email=${opts.toEmail ? "y" : "n"})`);
  return { sequence_name: seqName, results };
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

// [quote-send-now 2026-07-17] Fire the quote-followup Day-0 touch (the quote
// email) IMMEDIATELY on Send, instead of waiting up to 30 min for the cron — and
// RETURN the outcome so the office sees whether it actually went out. Same
// send path (processEnrollment) as the cron, so gating/opt-out/logging are
// identical; only the timing changes. Advances the step, so the cron won't
// re-fire it. Mirror of fireEstimateDay0.
export async function fireQuoteEmailNow(
  companyId: number, quoteId: number,
): Promise<{ emailed: boolean; status: string; channel?: string; recipient?: string | null; reason?: string }> {
  try {
    const rows = await db.execute(sql`
      SELECT fe.id, fe.company_id, fe.sequence_id, fe.quote_id, fe.client_id, fe.lead_id,
             fe.abandoned_booking_id, fe.estimate_id, fe.current_step,
             fs.name AS sequence_name, fs.sequence_type
      FROM follow_up_enrollments fe
      JOIN follow_up_sequences fs ON fs.id = fe.sequence_id
      WHERE fe.quote_id = ${quoteId} AND fe.company_id = ${companyId}
        AND fe.completed_at IS NULL AND fe.stopped_at IS NULL
      ORDER BY fe.id DESC LIMIT 1
    `);
    const enr = (rows as any).rows[0];
    if (!enr) return { emailed: false, status: "not_enrolled", reason: "not_enrolled" };
    // Only fire on the first (Day-0) step — never re-send a later touch.
    if (Number(enr.current_step) !== 1) return { emailed: false, status: "already_started", reason: "already_started" };
    const r = await processEnrollment(enr);
    if (!r) return { emailed: false, status: "no_step", reason: "no_step" };
    return { emailed: r.status === "sent" && r.channel === "email", status: r.status, channel: r.channel, recipient: r.recipient, reason: r.status !== "sent" ? r.status : undefined };
  } catch (err: any) {
    console.error("[quote-send-now] fireQuoteEmailNow error:", err?.message ?? err);
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
  let body = resolveMergeFields(rawBody, mergeVars);
  // [quote-email-live] Same bespoke-quote-email swap as processEnrollment — a
  // scoped one-off re-send of the quote-delivery touch must look identical to
  // the cadence send.
  if (enr.quote_id && step.channel === "email" && /\{\{\s*line_items\s*\}\}/.test(rawBody)) {
    const bespoke = await buildPhesQuoteEmailHtml(companyId, enr.quote_id, firstName).catch(() => null);
    if (bespoke) body = bespoke;
  }
  const subject = rawSubject ? resolveMergeFields(rawSubject, mergeVars) : "";
  const emailBrand: EmailBrand = { companyName: mergeVars.company_name, phone: mergeVars.company_phone, email: mergeVars.company_email };

  // ── Send the touch. EMAIL → Resend raw; SMS → Twilio raw via the saved
  //    company creds + branch from-number. BOTH bypass the global COMMS_ENABLED
  //    gate — the per-enrollment scope IS the authorization. ──────────────────
  const branchId = branch.branch === "schaumburg" ? 2 : 1;
  let providerId: string | null = null;
  let recipient: string | null = null;
  let logStatus = "sent", logErr = "";

  // [compliance 2026-07-09] The manual send used to skip the opt-out list and
  // omit the email unsubscribe. Honor both here too: never send to someone who
  // opted out, always include the email unsubscribe, always append SMS opt-out.
  const { isSmsOptedOut, isEmailOptedOut, buildEmailUnsubData } = await import("../lib/opt-out.js");

  if (step.channel === "email") {
    if (!recipientEmail) return { sent: false, channel: "email", reason: "no_recipient_email", step: step.step_number };
    recipient = recipientEmail;
    if (await isEmailOptedOut(companyId, recipientEmail)) return { sent: false, channel: "email", recipient: recipientEmail, step: step.step_number, reason: "email_opt_out" };
    try {
      const unsub = await buildEmailUnsubData(companyId, recipientEmail);
      providerId = await sendEmailRaw(recipientEmail, subject, body, await companyFromAddress(companyId), emailBrand, unsub ?? undefined);
    } catch (e: any) {
      logStatus = "failed"; logErr = e?.message || "email_send_error";
    }
  } else if (step.channel === "sms") {
    if (!recipientPhone) return { sent: false, channel: "sms", reason: "no_recipient_phone", step: step.step_number };
    recipient = recipientPhone;
    if (await isSmsOptedOut(companyId, recipientPhone)) return { sent: false, channel: "sms", recipient: recipientPhone, step: step.step_number, reason: "sms_opt_out" };
    // resolveSender returns creds + branch from-number even when its gate `reason`
    // is set; we deliberately ignore reason here (scoped one-off) but still
    // require the physical creds + a from-number to actually send.
    const sender = await resolveSender(companyId, branchId);
    if (!sender.account_sid || !sender.auth_token) return { sent: false, channel: "sms", recipient: recipientPhone, step: step.step_number, reason: "twilio_unconfigured" };
    if (!sender.from_number) return { sent: false, channel: "sms", recipient: recipientPhone, step: step.step_number, reason: "no_from_number" };
    try {
      const tw = await sendSmsVia(sender, recipientPhone, appendSmsOptOut(body));
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

  // [quote-email-tracking 2026-07-16] Mirror the processEnrollment path: a
  // manually-fired quote-delivery email lands in communication_log too, so the
  // comms log + delivery webhook work regardless of send route. Best-effort.
  if (enr.quote_id && step.channel === "email" && providerId && recipientEmail) {
    try {
      await db.execute(sql`
        INSERT INTO communication_log
          (company_id, customer_id, quote_id, direction, channel, subject, body,
           source, recipient, resend_email_id, delivery_status, logged_at)
        VALUES
          (${companyId}, ${enr.client_id || null}, ${enr.quote_id}, 'outbound',
           'email', ${subject || null}, ${body}, 'quote_email', ${recipientEmail},
           ${providerId}, 'sent', now())
      `);
    } catch (e: any) {
      console.error(`[follow-up] comms-log insert failed (quote ${enr.quote_id}):`, e?.message || e);
    }
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
