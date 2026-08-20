// [suspension-email-shell 2026-08-19] Put the three service-hold emails on the
// SAME shell as the booking confirmation ("our order emails"): centered logo
// over a brand underline, a coloured banner, mobile-stacking detail rows, and
// the navy contact footer.
//
// Before this, the hold emails went out through the generic wrapEmailHtml()
// chrome — left-aligned logo, no banner, no mobile CSS at all (so the
// service/rate/date rows stayed squeezed into two columns on a phone), and a
// pale footer whose phone number wasn't tappable. Same information, visibly a
// different product.
//
// Mechanism: sendNotification's ADDITIVE `renderEmail` hook, the same opt-in the
// job_scheduled confirmation uses. It replaces the shared chrome for THIS send
// only, so every other notification email is byte-for-byte unchanged. The BODY
// still comes from notification_templates, so the office keeps editing the copy
// in Settings > Customer Messages exactly as before — this only reskins the
// frame around it.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { phesEmailShell } from "./phes-email-shell.js";
import { emailLogoUrl } from "./app-url.js";

export type SuspensionEmailKind = "suspended" | "reminder" | "expired";

// Banner + <title> per message. Merge tags survive: sendNotification runs
// applyMerge over the renderer's OUTPUT, so {{end_date}} resolves here too.
const BANNER: Record<SuspensionEmailKind, string> = {
  suspended: "Your service is on hold until {{end_date}}",
  reminder: "Your hold ends {{end_date}}",
  expired: "Your hold ended {{end_date}}",
};
const TITLE: Record<SuspensionEmailKind, string> = {
  suspended: "Your service is on hold",
  reminder: "Your hold is ending soon",
  expired: "Your hold has ended",
};

const FALLBACK_PHONE = "(773) 706-6000";
const FALLBACK_TEL = "+17737066000";
const FALLBACK_EMAIL = "info@phes.io";
const FALLBACK_SITE = "phes.io";

/**
 * Resolve the tenant's logo once, then hand back the `renderEmail` callback.
 * Async because the logo lives on companies and the callback itself must stay
 * synchronous to match sendNotification's signature.
 */
export async function buildSuspensionEmailRenderer(
  companyId: number,
  kind: SuspensionEmailKind,
): Promise<(mergedBodyHtml: string, vars: Record<string, string>) => string> {
  let logoUrl = emailLogoUrl(null);
  let fallbackName = "Phes";
  try {
    const r = await db.execute(sql`SELECT name, logo_url FROM companies WHERE id = ${companyId} LIMIT 1`);
    const row: any = r.rows[0];
    if (row) {
      logoUrl = emailLogoUrl(row.logo_url);
      fallbackName = String(row.name || fallbackName);
    }
  } catch {
    /* branding is cosmetic — never block a hold notice on it */
  }

  return (mergedBodyHtml: string, vars: Record<string, string>): string => {
    const phone = String(vars.company_phone || "").trim() || FALLBACK_PHONE;
    const email = String(vars.company_email || "").trim() || FALLBACK_EMAIL;
    // Derive the site from the tenant's own send address so a non-Phes tenant
    // never gets phes.io in its footer.
    const site = (email.split("@")[1] || "").trim() || FALLBACK_SITE;
    return phesEmailShell({
      title: TITLE[kind],
      logoUrl,
      companyName: String(vars.company_name || "").trim() || fallbackName,
      bannerHtml: BANNER[kind],
      bodyHtml: mergedBodyHtml,
      companyPhone: phone,
      companyPhoneTel: phone.replace(/[^\d+]/g, "") || FALLBACK_TEL,
      companyEmail: email,
      website: site,
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// One-time copy upgrade for tenants seeded before the reskin.
//
// ensureCustomerMessageTemplates() only ever INSERTs missing rows — it never
// overwrites, so that an office edit survives a deploy. The consequence (the
// same one that left co1/co4 on plaintext invoice emails for months) is that
// changing the catalog changes NOTHING for a tenant already seeded. All four
// tenants were still carrying the July copy inside the old amber-pill layout.
//
// So: replace the stored body ONLY when it is byte-for-byte the previous seed,
// which proves nobody has edited it. Anything else is somebody's work and is
// left exactly alone. Idempotent — once upgraded, the guard no longer matches.
// ─────────────────────────────────────────────────────────────────────────────

const LEGACY_FONT = "'Plus Jakarta Sans', Arial, Helvetica, sans-serif";
function legacyRow(label: string, value: string, accent = false): string {
  return `<tr><td style="padding:11px 0;border-bottom:1px solid #E5E2DC;font-family:${LEGACY_FONT};font-size:13px;color:#6B6860;">${label}</td>` +
    `<td align="right" style="padding:11px 0;border-bottom:1px solid #E5E2DC;font-family:${LEGACY_FONT};font-size:14px;font-weight:${accent ? 800 : 600};color:${accent ? "#0A0E1A" : "#1A1917"};">${value}</td></tr>`;
}
function legacyEmail(pillText: string, heading: string, introHtml: string, rowsHtml: string, closingHtml: string): string {
  return `<div style="display:inline-block;padding:4px 12px;border-radius:999px;font-family:${LEGACY_FONT};font-size:12px;font-weight:700;background:#FEF3C7;color:#92400E;margin-bottom:14px;">${pillText}</div>` +
    `<h1 style="margin:0 0 6px;font-family:${LEGACY_FONT};font-size:22px;font-weight:700;color:#1A1917;">${heading}</h1>` +
    `<p style="margin:0 0 22px;font-family:${LEGACY_FONT};font-size:14px;color:#6B6860;line-height:1.6;">${introHtml}</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E2DC;border-radius:10px;padding:2px 16px;">${rowsHtml}</table>` +
    `<p style="margin:22px 0 0;font-family:${LEGACY_FONT};font-size:14px;color:#1A1917;line-height:1.6;">${closingHtml}</p>`;
}

/** The exact bodies seeded by the 2026-07-11 catalog, for the pristine check. */
export const LEGACY_SUSPENSION_BODIES: Record<string, string> = {
  service_suspended: legacyEmail(
    "On hold",
    "Your recurring service is on hold",
    "Hi {{first_name}}, this confirms that your recurring cleaning service has been placed on hold. During the hold we won't schedule any visits, and you won't be billed for cleanings.",
    legacyRow("Your service", "{{service_summary}}") + legacyRow("Your recurring rate", "{{service_price}}", true) +
      legacyRow("Suspension starts", "{{start_date}}") + legacyRow("Hold ends on", "{{end_date}}"),
    "As a recurring client you're locked in at {{service_price}}, and you keep your regular spot on our schedule and your usual cleaning team. Resume any time before {{end_date}} to keep those benefits - coming off recurring service means giving up your locked-in rate and rebooking at our standard rates. Just reply to this email or call us and we'll get you back on the schedule.",
  ),
  suspension_resume_reminder: legacyEmail(
    "Ending soon",
    "Keep your recurring cleaning benefits",
    "Hi {{first_name}}, your cleaning hold is coming to an end soon. Resume now to keep everything you have as a recurring client.",
    legacyRow("Your service", "{{service_summary}}") + legacyRow("Your recurring rate", "{{service_price}}", true) +
      legacyRow("Hold ends on", "{{end_date}}"),
    "Recurring clients keep a locked-in rate, a reserved place on our schedule, and their regular team. If your hold lapses on {{end_date}}, you'll come off recurring service and rebook at our standard rates. Want to keep your rate of {{service_price}}? Reply to this email or call us and we'll get you back on the calendar.",
  ),
  suspension_expired: legacyEmail(
    "Hold ended",
    "Your recurring hold has ended",
    "Hi {{first_name}}, your cleaning hold ended on {{end_date}}. We've kept your recurring spot and your rate open as long as we can, and we haven't rebooked yet - we wanted to check with you first.",
    legacyRow("Your service", "{{service_summary}}") + legacyRow("Your recurring rate", "{{service_price}}", true) +
      legacyRow("Hold ended", "{{end_date}}"),
    "Reactivate now to keep your rate of {{service_price}} and your regular team before your spot is released. If you come off recurring service, future cleanings would be booked at our standard rates. Just reply to this email or call us and we'll set up your next visit.",
  ),
};

/**
 * Swap un-edited hold-email copy onto the reskinned layout, for every tenant.
 * Returns the number of rows changed (0 on every run after the first).
 */
export async function runSuspensionCopyUpgrade(): Promise<number> {
  const { CUSTOMER_MESSAGE_CATALOG } = await import("./customer-messages.js");
  let updated = 0;
  for (const [trigger, legacyBody] of Object.entries(LEGACY_SUSPENSION_BODIES)) {
    const def = CUSTOMER_MESSAGE_CATALOG.find((d) => d.trigger === trigger);
    const ch = def?.channels.find((c) => c.channel === "email");
    if (!ch?.body) continue;
    try {
      const r = await db.execute(sql`
        UPDATE notification_templates
           SET body = ${ch.body},
               body_html = ${ch.body},
               subject = ${ch.subject ?? null}
         WHERE trigger = ${trigger}
           AND channel = 'email'
           AND COALESCE(body_html, body) = ${legacyBody}
        RETURNING id`);
      updated += (r.rows as any[]).length;
    } catch (e) {
      console.warn(`[suspension-email] copy upgrade skipped for ${trigger}:`, e);
    }
  }
  if (updated) console.log(`[suspension-email] reskinned ${updated} un-edited hold template(s)`);
  return updated;
}
