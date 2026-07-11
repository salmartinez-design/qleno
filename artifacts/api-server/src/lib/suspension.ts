// [service-suspension 2026-07-11] Service-suspension engine: idempotent boot
// migration, a COMMS_ENABLED-gated customer email helper, and the daily
// lifecycle cron (30-days-before-expiry resume reminder + at-expiry final
// notice). The suspend/resume ACTIONS live in routes/client-suspension.ts;
// this module owns the schema + the time-driven emails.
//
// Design decisions (locked with the owner 2026-07-11):
//   - Suspending cancels future jobs + deactivates recurring schedules
//     (mirrors routes/cancellation.ts cancel_service).
//   - At the 90-day expiry we FLAG for office (final email) — NO automatic
//     cancel or resume; a person decides.
//   - Office picks the end date, default +90 days, capped at 90.
// All customer sends respect COMMS_ENABLED (hard project rule) and the
// client's email_opt_out_at.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  renderResumeReminderEmail,
  renderSuspensionExpiredEmail,
} from "./suspension-emails.js";
// Reuse the SAME email chrome (logo masthead + standard footer) + merge-tag
// substitution every other customer email uses, so suspension emails are
// visually consistent with the rest of client communications.
import { wrapEmailHtml, applyMerge } from "../services/notificationService.js";
import { emailLogoUrl } from "./app-url.js";

export const MAX_SUSPEND_DAYS = 90;
export const RESUME_REMINDER_LEAD_DAYS = 30;

// Wrap the inner content produced by the suspension-email renderers in the
// shared house chrome and resolve the footer's {{company_phone}}/{{company_email}}
// merge tags to real values.
export function buildSuspensionEmailHtml(
  contentHtml: string,
  company: { name?: string | null; logo_url?: string | null; phone?: string | null; email?: string | null },
): string {
  const wrapped = wrapEmailHtml(contentHtml, {
    logoUrl: emailLogoUrl(company.logo_url),
    companyName: company.name,
  });
  return applyMerge(wrapped, {
    company_phone: company.phone || "",
    company_email: company.email || "",
  });
}

// Idempotent boot migration — add the suspension columns to clients and the
// pause marker to recurring_schedules. Safe to run on every cold start.
export async function runSuspensionMigration(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS suspended_at timestamp`);
    await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS suspend_until date`);
    await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS suspend_reason text`);
    await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS suspended_by_user_id integer`);
    await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS suspend_resume_reminder_sent_at timestamp`);
    await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS suspend_expiry_notice_sent_at timestamp`);
    await db.execute(sql`
      ALTER TABLE recurring_schedules
        ADD COLUMN IF NOT EXISTS paused_by_suspension boolean NOT NULL DEFAULT false
    `);
    console.log("[suspension] migration ok");
  } catch (err) {
    console.error("[suspension] migration error (non-fatal):", err);
  }
}

// Send a customer email, respecting the same gates every automated send path
// honors: the global COMMS_ENABLED kill-switch and the client's email opt-out.
// Returns true only if an email was actually handed to Resend. Never throws —
// the caller (a cron sweep) must keep going for the other clients.
export async function sendSuspensionEmail(opts: {
  to: string | null | undefined;
  emailOptOutAt: unknown;
  fromName: string;
  fromAddress: string | null | undefined;
  subject: string;
  html: string;
}): Promise<boolean> {
  try {
    if (!opts.to || opts.emailOptOutAt) return false;
    if (process.env.COMMS_ENABLED !== "true") {
      console.log(`[suspension] [COMMS BLOCKED] would email ${opts.to}: ${opts.subject}`);
      return false;
    }
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.warn("[suspension] RESEND_API_KEY not set — email skipped");
      return false;
    }
    const { Resend } = await import("resend");
    const resend = new Resend(key);
    const from = `${opts.fromName || "Qleno"} <${opts.fromAddress || "noreply@phes.io"}>`;
    const resp = await resend.emails.send({ from, to: [opts.to], subject: opts.subject, html: opts.html });
    // The Resend SDK does NOT throw on API errors — it returns { error }.
    if ((resp as any)?.error) {
      console.error("[suspension] resend error:", (resp as any).error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[suspension] email send failed:", e);
    return false;
  }
}

// Log a suspension lifecycle event onto the client's comm log so the office
// sees what went out (and when the hold expired) in the Comm Log tab.
async function logClientComm(companyId: number, clientId: number, subject: string, body: string): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO client_communications
        (company_id, client_id, type, direction, subject, body, from_name, created_at)
      VALUES
        (${companyId}, ${clientId}, 'suspension', 'outbound', ${subject}, ${body}, 'System', now())
    `);
  } catch (e) {
    console.warn("[suspension] comm-log insert non-fatal:", e);
  }
}

// Daily sweep (called once per day from the notification cron). Two idempotent
// passes, each stamped so it fires exactly once per client:
//   A) resume reminder — hold ends within RESUME_REMINDER_LEAD_DAYS and hasn't
//      already been reminded.
//   B) expiry final notice — hold end date has arrived and no notice sent yet.
// `todayYmd` is the CT calendar date the cron computes (YYYY-MM-DD).
export async function runSuspensionReminders(todayYmd: string): Promise<{ reminders: number; expiries: number }> {
  let reminders = 0;
  let expiries = 0;

  // ── A) 30-days-before-expiry resume reminder ────────────────────────────────
  try {
    const due = await db.execute(sql`
      SELECT c.id, c.company_id, c.first_name, c.email, c.email_opt_out_at, c.suspend_until,
             co.name AS company_name, co.phone AS company_phone, co.email AS company_email,
             co.logo_url AS company_logo, co.email_from_address
        FROM clients c
        JOIN companies co ON co.id = c.company_id
       WHERE c.suspended_at IS NOT NULL
         AND c.suspend_until IS NOT NULL
         AND c.suspend_resume_reminder_sent_at IS NULL
         AND c.suspend_until > ${todayYmd}::date
         AND c.suspend_until <= (${todayYmd}::date + ${RESUME_REMINDER_LEAD_DAYS} * INTERVAL '1 day')
    `);
    for (const r of due.rows as any[]) {
      const expiry = String(r.suspend_until).slice(0, 10);
      const { subject, contentHtml } = renderResumeReminderEmail({
        clientName: r.first_name,
        expiryDate: expiry,
      });
      const html = buildSuspensionEmailHtml(contentHtml, {
        name: r.company_name, logo_url: r.company_logo, phone: r.company_phone, email: r.company_email,
      });
      await sendSuspensionEmail({
        to: r.email, emailOptOutAt: r.email_opt_out_at,
        fromName: r.company_name || "Qleno", fromAddress: r.email_from_address,
        subject, html,
      });
      // Stamp regardless of whether the email actually shipped (opt-out /
      // comms-off) so we never re-scan this client every day. The office sees
      // the [COMMS BLOCKED] log if it was suppressed.
      await db.execute(sql`UPDATE clients SET suspend_resume_reminder_sent_at = now() WHERE id = ${r.id}`);
      await logClientComm(r.company_id, r.id, subject, "Resume-reminder email (30 days before hold ends).");
      reminders++;
    }
  } catch (e) {
    console.error("[suspension] resume-reminder pass error:", e);
  }

  // ── B) at-expiry final notice (flag for office; no state change) ─────────────
  try {
    const expired = await db.execute(sql`
      SELECT c.id, c.company_id, c.first_name, c.email, c.email_opt_out_at, c.suspend_until,
             co.name AS company_name, co.phone AS company_phone, co.email AS company_email,
             co.logo_url AS company_logo, co.email_from_address
        FROM clients c
        JOIN companies co ON co.id = c.company_id
       WHERE c.suspended_at IS NOT NULL
         AND c.suspend_until IS NOT NULL
         AND c.suspend_expiry_notice_sent_at IS NULL
         AND c.suspend_until <= ${todayYmd}::date
    `);
    for (const r of expired.rows as any[]) {
      const expiry = String(r.suspend_until).slice(0, 10);
      const { subject, contentHtml } = renderSuspensionExpiredEmail({
        clientName: r.first_name,
        expiryDate: expiry,
      });
      const html = buildSuspensionEmailHtml(contentHtml, {
        name: r.company_name, logo_url: r.company_logo, phone: r.company_phone, email: r.company_email,
      });
      await sendSuspensionEmail({
        to: r.email, emailOptOutAt: r.email_opt_out_at,
        fromName: r.company_name || "Qleno", fromAddress: r.email_from_address,
        subject, html,
      });
      await db.execute(sql`UPDATE clients SET suspend_expiry_notice_sent_at = now() WHERE id = ${r.id}`);
      await logClientComm(r.company_id, r.id, subject, "Hold expired — final notice sent; awaiting office follow-up.");
      // Office heads-up notification (same table cancellation.ts uses).
      try {
        await db.execute(sql`
          INSERT INTO notifications (company_id, user_id, type, title, body, link)
          VALUES (${r.company_id}, NULL, 'suspension_expired',
                  ${`Service hold ended — ${r.first_name ?? "client"}`},
                  ${`A 90-day service hold has ended. Follow up to resume or close out the account.`},
                  ${`/customers/${r.id}`})
        `);
      } catch (e) { console.warn("[suspension] office notification non-fatal:", e); }
      expiries++;
    }
  } catch (e) {
    console.error("[suspension] expiry pass error:", e);
  }

  if (reminders || expiries) {
    console.log(`[suspension] cron: ${reminders} resume reminder(s), ${expiries} expiry notice(s)`);
  }
  return { reminders, expiries };
}
