// [agreement-lifecycle 2026-08-20] Everything that happens to a sent agreement
// BEFORE and INSTEAD OF a signature.
//
// Up to now the engine could only do one thing: send a link and wait. If the
// customer never signed, nothing chased them. If the office got the price wrong,
// the bad link stayed live until it expired. If the customer disagreed with a
// clause, they had no button to say so — they closed the tab and the office
// found out by phone, or never. This module adds the four states that were
// missing (reminded, declined, cancelled, resent) and the audit rows for each.
//
// Nothing here moves money and nothing here signs anything.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { appBaseUrl, emailLogoUrl } from "./app-url.js";
import { sendNotification } from "../services/notificationService.js";
import { agreementEmailShell } from "./phes-agreement-emails.js";
import { notifyOfficeUsers } from "./notify.js";

/**
 * Additive columns behind the lifecycle. Idempotent — safe on every cold start,
 * same contract as ensureAgreementViewColumns.
 */
export async function ensureAgreementLifecycleColumns(): Promise<void> {
  const cols: string[] = [
    // Customer said no. reason is free text they typed.
    "declined_at timestamp",
    "decline_reason text",
    "declined_name text",
    // Office pulled it back. kind separates "we are fixing it and resending"
    // from "this is dead", because the customer email differs and so does what
    // the office expects to happen next.
    "cancelled_at timestamp",
    "cancelled_by integer",
    "cancel_reason text",
    "cancel_kind text",
    // Chase cadence. step is how many reminders have gone out; next_reminder_at
    // is the single field the sweep reads.
    "reminder_step integer NOT NULL DEFAULT 0",
    "next_reminder_at timestamp",
    "last_reminder_at timestamp",
    "reminders_enabled boolean NOT NULL DEFAULT true",
    // Resend, possibly to a different address or number than the first send.
    "sent_to_phone text",
    "resend_count integer NOT NULL DEFAULT 0",
    "last_resent_at timestamp",
    // The clock the cadence counts from: sent_at, or the most recent resend.
    "cadence_anchor_at timestamp",
  ];
  for (const c of cols) {
    await db.execute(sql.raw(`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS ${c}`));
  }
  // Backfill: rows sent before this shipped have no anchor and no next
  // reminder, so they would sit forever. Anchor them to their own send and
  // schedule the first due step. Only rows still waiting — a signed or expired
  // agreement is never chased.
  await db.execute(sql`
    UPDATE form_submissions
       SET cadence_anchor_at = COALESCE(cadence_anchor_at, sent_at, created_at)
     WHERE cadence_anchor_at IS NULL AND sent_at IS NOT NULL`);
}

/**
 * The chase cadence: seven touches over 30 days, front-loaded, alternating
 * email and text.
 *
 * WHY THIS SHAPE. Three things are well established about documents sent out
 * for signature, and all three point the same way:
 *
 *  1. Speed is everything. Proposal and contract data consistently shows that
 *     the large majority of documents that get signed are signed within the
 *     first day or two of being opened, and that the odds fall off steeply the
 *     longer one sits unsigned. So the chase has to be heaviest at the front —
 *     three touches in the first five days — not spread evenly over the month.
 *  2. Persistence past the first try is where the extra closes come from.
 *     Sales-cadence studies keep landing on the same number: most of the
 *     conversions that happen at all happen within the first five or six
 *     touches, and response decays sharply after the first week or so. Seven
 *     touches sits just past that knee: it captures the tail without becoming
 *     harassment.
 *  3. Two channels beat one. A text is opened almost every time and read within
 *     minutes; an email is opened maybe a fifth of the time. But a contract
 *     needs a real email to carry the wording and the link, so the right answer
 *     is both — email to carry the document, text to get eyes back on it.
 *
 * The last touch lands two days before the 30-day link expires, so "this
 * expires Friday" is true when it is said, and the customer still has time to
 * act on it.
 *
 * Days are measured from cadence_anchor_at, which is the original send or the
 * most recent resend. A resend restarts the chase from the top, which is the
 * behaviour the office expects when they fix a price and send it again.
 */
export const AGREEMENT_REMINDER_STEPS: Array<{ day: number; channels: Array<"email" | "sms">; final?: boolean }> = [
  { day: 1, channels: ["email"] },
  { day: 3, channels: ["sms"] },
  { day: 5, channels: ["email"] },
  { day: 8, channels: ["sms"] },
  { day: 14, channels: ["email"] },
  { day: 21, channels: ["email"] },
  { day: 28, channels: ["email", "sms"], final: true },
];

/** When step `afterStep` (0 = nothing sent yet) should next fire, or null when the chase is done. */
export function nextReminderAt(anchor: Date | string | null, afterStep: number): Date | null {
  if (!anchor) return null;
  const step = AGREEMENT_REMINDER_STEPS[afterStep];
  if (!step) return null;
  const d = new Date(anchor);
  d.setDate(d.getDate() + step.day);
  // Reminders go out on the daily 10 AM sweep, so the exact clock time stored
  // here only decides WHICH day it is picked up. Normalising to midnight keeps
  // a send made at 9 PM from pushing every later touch a day out.
  d.setHours(0, 0, 0, 0);
  return d;
}

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric" });

export interface ReminderRunResult {
  considered: number;
  emails: number;
  texts: number;
  companies: number;
}

/**
 * Daily sweep. Sends whatever touch is due on each waiting agreement.
 *
 * These are automated, so they go through sendNotification NON-transactional:
 * the per-tenant comms gate, the global COMMS_ENABLED gate and the customer's
 * own opt-out all apply. Only the first send and the signed copy are
 * transactional, because those are a person pressing a button and a contract
 * the signer is legally owed.
 */
export async function runAgreementReminders(): Promise<ReminderRunResult> {
  const out: ReminderRunResult = { considered: 0, emails: 0, texts: 0, companies: 0 };
  const seenCompanies = new Set<number>();

  const due = (await db.execute(sql`
    SELECT fs.id, fs.company_id, fs.client_id, fs.sign_token, fs.sent_to, fs.sent_to_phone,
           fs.reminder_step, fs.cadence_anchor_at, fs.expires_at, fs.view_count,
           ft.name AS form_name,
           c.first_name AS client_first, c.phone AS client_phone,
           co.logo_url AS company_logo
      FROM form_submissions fs
      LEFT JOIN form_templates ft ON ft.id = fs.form_id
      LEFT JOIN clients c ON c.id = fs.client_id
      LEFT JOIN companies co ON co.id = fs.company_id
     WHERE fs.status = 'pending'
       AND fs.reminders_enabled = true
       AND fs.next_reminder_at IS NOT NULL
       AND fs.next_reminder_at <= now()
       AND (fs.expires_at IS NULL OR fs.expires_at > now())
     ORDER BY fs.id ASC
     LIMIT 500`)).rows as any[];

  for (const row of due) {
    out.considered++;
    seenCompanies.add(Number(row.company_id));
    const stepIndex = Number(row.reminder_step || 0);
    const step = AGREEMENT_REMINDER_STEPS[stepIndex];
    if (!step) {
      await db.execute(sql`UPDATE form_submissions SET next_reminder_at = NULL WHERE id = ${row.id}`);
      continue;
    }

    const link = `${appBaseUrl()}/sign/${row.sign_token}`;
    const expires = row.expires_at ? new Date(row.expires_at) : null;
    const daysLeft = expires ? Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 86400000)) : 0;
    // The one line that changes with what we can actually see. An agreement
    // that was opened and left unsigned is a different conversation from one
    // that was never opened at all, and the office should not have to guess
    // which message went out.
    const opened = Number(row.view_count || 0) > 0;
    const statusLine = opened
      ? "We can see it was opened, but it has not been signed yet."
      : "It looks like it has not been opened yet.";
    const vars: Record<string, string> = {
      first_name: String(row.client_first || "").trim(),
      agreement_name: String(row.form_name || "Service Agreement"),
      agreement_link: link,
      status_line: statusLine,
      days_left: String(daysLeft),
      expires_on: expires ? fmtDate(expires) : "",
    };

    const key = step.final ? "agreement_final_notice" : "agreement_reminder";
    const logoUrl = emailLogoUrl(row.company_logo ?? null);

    for (const channel of step.channels) {
      const to = channel === "email" ? String(row.sent_to || "").trim() : String(row.sent_to_phone || row.client_phone || "").trim();
      if (!to) continue;
      let ok = false;
      try {
        ok = await sendNotification(
          key,
          channel,
          Number(row.company_id),
          channel === "email" ? to : null,
          channel === "sms" ? to : null,
          vars,
          false,
          channel === "email"
            ? (bodyHtml, v) => agreementEmailShell({
                logoUrl,
                companyName: v.company_name,
                companyPhone: v.company_phone,
                companyEmail: v.company_email,
                title: `Your ${v.company_name || "Phes"} service agreement`,
                banner: step.final ? "Last call on your service agreement" : "Your service agreement is still waiting",
              }, bodyHtml)
            : undefined,
          Number(row.client_id) || null,
        );
      } catch (e) {
        console.error(`[agreement-reminder] submission ${row.id} ${channel} failed:`, (e as any)?.message);
      }
      if (ok) {
        if (channel === "email") out.emails++; else out.texts++;
        await db.execute(sql`
          INSERT INTO agreement_events (company_id, agreement_id, event_type, actor_email, meta)
          VALUES (${row.company_id}, ${row.id}, 'reminder_sent', ${channel === "email" ? to : null},
                  ${JSON.stringify({ step: stepIndex + 1, day: step.day, channel, final: !!step.final, opened })}::jsonb)`);
      }
    }

    // Advance regardless of whether the provider took it. A tenant with comms
    // gated off must not sit on step 1 forever and then fire all seven touches
    // the day the gate opens.
    const next = nextReminderAt(row.cadence_anchor_at, stepIndex + 1);
    await db.execute(sql`
      UPDATE form_submissions
         SET reminder_step = ${stepIndex + 1},
             last_reminder_at = now(),
             next_reminder_at = ${next}
       WHERE id = ${row.id}`);
  }

  out.companies = seenCompanies.size;
  if (out.considered) {
    console.log(`[cron] agreement_reminders: ${out.emails} email(s), ${out.texts} text(s) across ${out.considered} agreement(s)`);
  }
  return out;
}

/**
 * Tell the office an agreement came back declined. In-app alert for everyone who
 * can act on it; the reason the customer typed is the whole point, so it goes in
 * the body rather than behind a click.
 */
export async function alertOfficeDeclined(args: {
  companyId: number; submissionId: number; clientId: number | null;
  clientName: string; formName: string; reason: string;
}): Promise<void> {
  const reason = String(args.reason || "").trim();
  await notifyOfficeUsers(args.companyId, {
    type: "agreement_declined",
    title: `${args.clientName || "A customer"} declined the ${args.formName}`,
    body: reason ? `Reason given: ${reason}` : "No reason was given.",
    link: args.clientId ? `/customers/${args.clientId}` : "/settings/forms",
    meta: { submission_id: args.submissionId, client_id: args.clientId ?? null, reason },
  });
}
