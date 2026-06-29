import { db } from "@workspace/db";
import { notificationTemplatesTable, notificationLogTable, clientsTable, companiesTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getBranchByZip } from "../lib/branchRouter";
import { buildReminderEmail } from "../lib/emailTemplates";
import { resolveSender, sendSmsVia } from "../lib/comms-sender.js";
import { isSmsOptedOut, isEmailOptedOut, buildEmailUnsubData, buildUnsubDataFromToken } from "../lib/opt-out.js";
import { renderCustomerTemplate } from "../lib/customer-messages.js";
import { Resend } from "resend";

// ── Email brand constants ────────────────────────────────────────────────────
const BRAND = {
  bg:        "#F7F6F3",
  card:      "#FFFFFF",
  accent:    "#5B9BD5",
  textMain:  "#1A1917",
  textSub:   "#6B6860",
  border:    "#E5E2DC",
  font:      "Arial, Helvetica, sans-serif",
};

// ── Merge tag substitution ────────────────────────────────────────────────────
function applyMerge(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => vars[key.trim()] ?? "");
}

// ── Email HTML wrapper ───────────────────────────────────────────────────────
function wrapEmailHtml(contentHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notification</title></head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:${BRAND.font};">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${BRAND.card};border-radius:8px;overflow:hidden;border:1px solid ${BRAND.border};">
<tr><td style="background:${BRAND.accent};padding:20px 32px;">
  <span style="color:#ffffff;font-size:20px;font-weight:bold;font-family:${BRAND.font};">Phes</span>
</td></tr>
<tr><td style="padding:32px;color:${BRAND.textMain};font-size:15px;line-height:1.6;font-family:${BRAND.font};">
${contentHtml}
</td></tr>
<tr><td style="background:${BRAND.bg};padding:16px 32px;border-top:1px solid ${BRAND.border};text-align:center;color:${BRAND.textSub};font-size:12px;font-family:${BRAND.font};">
  Phes &nbsp;|&nbsp; {{company_phone}} &nbsp;|&nbsp; {{company_email}} &nbsp;|&nbsp; phes.io
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Twilio SMS sender ─────────────────────────────────────────────────────────
// Per-tenant ONLY. Resolves the company's own creds + from-number via
// resolveSender(companyId) and sends through sendSmsVia. The old global-env
// path (process.env.TWILIO_FROM_NUMBER = the Oak Lawn / MaidCentral number
// +17737869902) is GONE — Qleno must never send from a shared global number
// again. Honors the full gate ladder (global + company + twilio + creds + from).
async function sendTenantSms(companyId: number, to: string, body: string): Promise<void> {
  const sender = await resolveSender(companyId, null);
  if (sender.reason) {
    console.log(`[COMMS BLOCKED] SMS suppressed (${sender.reason}) company=${companyId} to=${to}`);
    return;
  }
  await sendSmsVia(sender, to, body);
}

// ── Core send function ───────────────────────────────────────────────────────
export async function sendNotification(
  templateKey: string,
  channel: "email" | "sms",
  companyId: number,
  recipientEmail: string | null,
  recipientPhone: string | null,
  mergeVars: Record<string, string>,
  // Transactional (password reset, user invite, etc.) — triggered by an explicit
  // user action, so it ALWAYS sends: bypasses both the per-tenant comms gate and
  // the global COMMS_ENABLED. Marketing/cadence/notification sends leave this false.
  transactional: boolean = false,
  // [confirmation-email Pass2] ADDITIVE, opt-in: when provided (email only), the
  // caller's renderer builds the entire email shell from the merged template body
  // + merge vars, REPLACING the shared wrapEmailHtml() chrome for THIS send only.
  // Every other caller omits it → wrapEmailHtml is used exactly as before, so the
  // other transactional emails are byte-for-byte unchanged. Gating + logging are
  // untouched. Used solely by the job_scheduled confirmation email.
  renderEmail?: (mergedBodyHtml: string, vars: Record<string, string>) => string,
): Promise<void> {
  let status = "sent";
  let errorMsg: string | null = null;
  let providerId: string | null = null;

  try {
    // Fetch template
    const [tpl] = await db
      .select()
      .from(notificationTemplatesTable)
      .where(and(
        eq(notificationTemplatesTable.company_id, companyId),
        eq(notificationTemplatesTable.trigger, templateKey),
        eq(notificationTemplatesTable.channel, channel as any),
        eq(notificationTemplatesTable.is_active, true),
      ))
      .limit(1);

    if (!tpl) {
      await logNotification(companyId, recipientEmail || recipientPhone || "unknown", channel, templateKey, "skipped", "Template not found or inactive", {});
      return;
    }

    // Per-tenant comms gate + per-tenant send-from address. Raw SQL to avoid
    // coupling to the regenerated drizzle column types.
    const commsRow = await db.execute(sql`SELECT comms_enabled, email_from_address FROM companies WHERE id = ${companyId} LIMIT 1`);
    const fromAddr = (commsRow.rows[0] as any)?.email_from_address || "info@phes.io";
    // Marketing/notification sends require the tenant's comms gate. Transactional
    // sends (reset/invite) skip it — they must always reach the user.
    if (!transactional && !(commsRow.rows[0] as any)?.comms_enabled) {
      await logNotification(companyId, recipientEmail || recipientPhone || "unknown", channel, templateKey, "suppressed", "company_comms_disabled", {});
      return;
    }

    // Fetch company info for merge vars
    const [company] = await db
      .select({ name: companiesTable.name, phone: companiesTable.phone, email: companiesTable.email })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);

    const fullVars: Record<string, string> = {
      company_name:  company?.name  || "Phes",
      company_phone: company?.phone || "(708) 974-5517",
      company_email: company?.email || "info@phes.io",
      ...mergeVars,
    };

    if (channel === "email") {
      if (!recipientEmail) {
        await logNotification(companyId, "no-email", channel, templateKey, "skipped", "No recipient email", fullVars);
        return;
      }
      if (!process.env.RESEND_API_KEY) {
        await logNotification(companyId, recipientEmail, channel, templateKey, "skipped", "RESEND_API_KEY not configured", fullVars);
        return;
      }
      // [comms-opt-out] Honor email opt-out. Transactional sends (reset/invite,
      // to users not clients) bypass — they must always reach the recipient.
      if (!transactional && await isEmailOptedOut(companyId, recipientEmail)) {
        await logNotification(companyId, recipientEmail, channel, templateKey, "suppressed", "email_opt_out", fullVars);
        return;
      }

      const bodyHtml = tpl.body_html || tpl.body || "";
      const subject  = applyMerge(tpl.subject || "", fullVars);
      let rawHtml    = applyMerge(bodyHtml, fullVars);
      // [booking-confirmation GAP1] When the caller supplies an appointment_link
      // (job_scheduled), append a branded "View your appointment" button unless
      // the template already references the link — so any tenant's confirmation
      // email gets the customer job-view link without editing their template.
      const apptLink = fullVars.appointment_link;
      // The GAP1 fallback button only applies when there's no dedicated renderer
      // (the Pass-2 confirmation renderer supplies its own CTA).
      if (!renderEmail && apptLink && !rawHtml.includes(apptLink) && !bodyHtml.includes("appointment_link")) {
        rawHtml += `<div style="text-align:center;margin:24px 0 8px"><a href="${apptLink}" style="display:inline-block;background:${BRAND.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:6px">View your appointment</a></div>`;
      }
      // Opt-in dedicated renderer (confirmation email) replaces the shared chrome
      // for this send only; all other emails keep wrapEmailHtml unchanged.
      let wrapped  = renderEmail
        ? applyMerge(renderEmail(rawHtml, fullVars), fullVars)
        : applyMerge(wrapEmailHtml(rawHtml), fullVars);

      // [comms-opt-out] Tokenized unsubscribe: append the footer link + set the
      // List-Unsubscribe (+ one-click) headers for transactional-marketing
      // sends. Skipped for true transactional sends (reset/invite) which aren't
      // bulk mail and shouldn't carry an unsubscribe.
      const emailHeaders: Record<string, string> = {};
      if (!transactional) {
        const unsub = await buildEmailUnsubData(companyId, recipientEmail);
        if (unsub) {
          Object.assign(emailHeaders, unsub.headers);
          if (!wrapped.includes(unsub.unsubUrl)) wrapped = wrapped.replace(/<\/body>/i, `${unsub.footerHtml}</body>`);
        }
      }

      if (!transactional && process.env.COMMS_ENABLED !== "true") {
        console.log("[COMMS BLOCKED] Email suppressed:", { to: recipientEmail, subject });
        await logNotification(companyId, recipientEmail, channel, templateKey, "suppressed", "COMMS_ENABLED=false", fullVars);
        return;
      }
      const resend = new Resend(process.env.RESEND_API_KEY);
      const sendRes: any = await resend.emails.send({
        from:     fromAddr,
        replyTo:  fromAddr,
        to:       recipientEmail,
        subject,
        html:     wrapped,
        ...(Object.keys(emailHeaders).length ? { headers: emailHeaders } : {}),
      });
      // The Resend SDK returns { error } instead of throwing — surface it so a
      // rejected send isn't logged as success.
      if (sendRes?.error) throw new Error(`Resend error: ${sendRes.error?.message ?? JSON.stringify(sendRes.error)}`);
      providerId = sendRes?.data?.id ?? null;

    } else if (channel === "sms") {
      if (!recipientPhone) {
        await logNotification(companyId, "no-phone", channel, templateKey, "skipped", "No recipient phone", fullVars);
        return;
      }
      // [comms-opt-out] Honor SMS STOP. Transactional bypasses (to users).
      if (!transactional && await isSmsOptedOut(companyId, recipientPhone)) {
        await logNotification(companyId, recipientPhone, channel, templateKey, "suppressed", "sms_opt_out", fullVars);
        return;
      }

      const bodyText = applyMerge(tpl.body_text || tpl.body || "", fullVars);
      // Per-tenant send only — resolveSender(companyId) picks THIS company's
      // creds + from-number. Never the global env number.
      await sendTenantSms(companyId, recipientPhone, bodyText);
    }

  } catch (err: any) {
    status   = "failed";
    errorMsg = err?.message || String(err);
    console.error(`[notifications] ${templateKey}/${channel} failed:`, errorMsg);
  }

  await logNotification(
    companyId,
    (channel === "email" ? recipientEmail : recipientPhone) || "unknown",
    channel,
    templateKey,
    status,
    errorMsg,
    // Stamp the Resend provider id into metadata for delivery traceability.
    { ...mergeVars, ...(providerId ? { _provider_id: providerId } : {}) },
  );
}

async function logNotification(
  companyId: number,
  recipient: string,
  channel: string,
  trigger: string,
  status: string,
  errorMsg: string | null,
  metadata: Record<string, string>,
) {
  try {
    await db.insert(notificationLogTable).values({
      company_id:    companyId,
      recipient,
      channel,
      trigger,
      status,
      error_message: errorMsg,
      metadata:      metadata as any,
    });
  } catch (logErr) {
    console.error("[notifications] Failed to write log:", logErr);
  }
}

// ── Job reminder cron ────────────────────────────────────────────────────────
export async function runReminderCron(daysAhead: number): Promise<void> {
  const hoursAhead = daysAhead === 3 ? 72 : 24;
  const sentCol = hoursAhead === 72 ? "reminder_72h_sent" : "reminder_24h_sent";
  const label = hoursAhead === 72 ? "72h" : "24h";

  if (process.env.COMMS_ENABLED !== "true") {
    console.log(`[COMMS BLOCKED] runReminderCron (${label}) suppressed — COMMS_ENABLED=false`);
    // Still mark reminders as sent so we don't accumulate a backlog when comms re-enable
    // Actually: do NOT mark sent when blocked — retry on next run instead (per spec: "log and skip")
    return;
  }

  try {
    const target = new Date();
    target.setDate(target.getDate() + daysAhead);
    const targetStr = target.toISOString().slice(0, 10);
    // [reminder-catchup 2026-06-26] The in-process scheduler fires this cron in
    // a single daily window (9 AM / 4 PM CT). A server restart during that hour
    // used to silently skip the whole day with no retry (reminder_72h_sent was 0
    // across all jobs, ever). Fix: match a DATE RANGE, not a single day, so a
    // missed window is recovered on the next run. The per-job reminder_*_sent
    // flag still guards every send, so this never double-sends or blasts the
    // back-catalog. The 72h reminder gets a 1-day grace (today+2..today+3); the
    // 24h reminder stays exact (today+1) — a "your cleaning is tomorrow" message
    // can't sensibly fire once the job is already same-day. Lower bound never
    // reaches into the past.
    const fromDays = daysAhead === 3 ? daysAhead - 1 : daysAhead;
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() + fromDays);
    const fromStr = fromDate.toISOString().slice(0, 10);
    const { sql: drizzleSql } = await import("drizzle-orm");

    const rows = await db.execute(
      hoursAhead === 72
        ? drizzleSql`
            SELECT j.id, j.company_id, co.name AS company_name,
                   j.scheduled_date, j.service_type, j.arrival_window,
                   j.address_street, j.address_city, j.address_state, j.address_zip,
                   c.first_name, c.last_name, c.email, c.phone, c.zip,
                   c.sms_opt_out_at, c.email_opt_out_at, c.email_unsub_token
              FROM jobs j
              JOIN clients c ON c.id = j.client_id
              JOIN companies co ON co.id = j.company_id
              LEFT JOIN accounts a ON a.id = c.account_id
             WHERE j.scheduled_date >= ${fromStr}
               AND j.scheduled_date <= ${targetStr}
               AND j.status NOT IN ('cancelled', 'complete')
               AND co.comms_enabled = true
               AND (a.id IS NULL OR a.comms_enabled = true)
               AND j.reminder_72h_sent = false
          `
        : drizzleSql`
            SELECT j.id, j.company_id, co.name AS company_name,
                   j.scheduled_date, j.service_type, j.arrival_window,
                   j.address_street, j.address_city, j.address_state, j.address_zip,
                   c.first_name, c.last_name, c.email, c.phone, c.zip,
                   c.sms_opt_out_at, c.email_opt_out_at, c.email_unsub_token
              FROM jobs j
              JOIN clients c ON c.id = j.client_id
              JOIN companies co ON co.id = j.company_id
              LEFT JOIN accounts a ON a.id = c.account_id
             WHERE j.scheduled_date >= ${fromStr}
               AND j.scheduled_date <= ${targetStr}
               AND j.status NOT IN ('cancelled', 'complete')
               AND co.comms_enabled = true
               AND (a.id IS NULL OR a.comms_enabled = true)
               AND j.reminder_24h_sent = false
          `
    );
    const jobs: any[] = (rows as any).rows ?? [];

    const resendKey = process.env.RESEND_API_KEY;
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;

    for (const job of jobs) {
      const jobZip = job.address_zip || job.zip || "";
      const branchConfig = getBranchByZip(jobZip);
      // [AI.7.6] Canonical address format — "<street>, <city>, <state> <zip>".
      // Same rule as the frontend formatAddress(): zip MUST be shown when
      // address is shown.
      const stateZip = [job.address_state, job.address_zip].filter(Boolean).join(" ");
      const serviceAddress = [job.address_street, job.address_city, stateZip].filter(Boolean).join(", ") || "On file";
      const arrivalWindowLabel = job.arrival_window === "morning"
        ? "9:00 AM – 12:00 PM"
        : job.arrival_window === "afternoon"
        ? "12:00 PM – 2:00 PM"
        : "scheduled window";
      const scheduledDate = formatDate(job.scheduled_date);
      const serviceType = labelServiceType(job.service_type);

      let emailSent = false;
      let smsSent = false;

      // [customer-messages] The reminder copy now comes from the office-editable
      // notification_templates rows (reminder_3day / reminder_1day), so edits in
      // the Customer Messages panel actually take effect. A null template (no
      // row) falls back to the built-in copy so a missing row never silences a
      // reminder; a PAUSED template (is_active=false) honors the office's "off".
      const reminderTrigger = hoursAhead === 72 ? "reminder_3day" : "reminder_1day";
      const mergeVars: Record<string, string> = {
        first_name: job.first_name || "there",
        client_name: [job.first_name, job.last_name].filter(Boolean).join(" ") || "there",
        company_name: job.company_name || "Phes",
        company_phone: branchConfig.clientPhone,
        company_email: branchConfig.officeEmail,
        service_type: serviceType,
        date: scheduledDate,
        arrival_window: arrivalWindowLabel,
        service_address: serviceAddress,
      };
      const logMeta = { job_id: String(job.id) };

      // Email reminder — skip if the client opted out of email.
      if (resendKey && job.email && !job.email_opt_out_at) {
        const emailTpl = await renderCustomerTemplate(job.company_id, reminderTrigger, "email", mergeVars);
        if (emailTpl && !emailTpl.is_active) {
          console.log(`[reminder-${label}] email paused by template job=${job.id}`);
          await logNotification(job.company_id, job.email, "email", reminderTrigger, "suppressed", "template_paused", logMeta);
        } else {
          try {
            let subject: string;
            let html: string;
            if (emailTpl) {
              subject = emailTpl.subject || `Reminder: your cleaning on ${scheduledDate}`;
              const htmlBody = /<[a-z][\s\S]*>/i.test(emailTpl.body) ? emailTpl.body : emailTpl.body.replace(/\n/g, "<br>");
              html = wrapEmailHtml(htmlBody);
            } else {
              ({ subject, html } = buildReminderEmail({
                firstName: job.first_name || "",
                email: job.email,
                serviceType,
                scheduledDate,
                arrivalWindow: arrivalWindowLabel,
                serviceAddress,
                branchConfig,
                hoursAhead: hoursAhead as 72 | 24,
              }));
            }
            // [comms-opt-out] List-Unsubscribe header + footer link.
            let emailHtml = html;
            const headers: Record<string, string> = {};
            if (job.email_unsub_token) {
              const u = buildUnsubDataFromToken(job.email_unsub_token);
              Object.assign(headers, u.headers);
              emailHtml = emailHtml.includes("</body>") ? emailHtml.replace(/<\/body>/i, `${u.footerHtml}</body>`) : emailHtml + u.footerHtml;
            }
            const resend = new Resend(resendKey);
            await resend.emails.send({
              from: `Phes <${branchConfig.officeEmail}>`,
              replyTo: branchConfig.officeEmail,
              to: [job.email],
              subject,
              html: emailHtml,
              ...(Object.keys(headers).length ? { headers } : {}),
            });
            emailSent = true;
            await logNotification(job.company_id, job.email, "email", reminderTrigger, "sent", null, logMeta);
          } catch (emailErr) {
            console.error(`[reminder-${label}] Email failed for job ${job.id}:`, emailErr);
            await logNotification(job.company_id, job.email, "email", reminderTrigger, "failed", String(emailErr), logMeta);
          }
        }
      } else if (job.email_opt_out_at) {
        console.log(`[reminder-${label}] email suppressed (opt-out) job=${job.id}`);
      }

      // SMS reminder — skip if the client opted out of SMS.
      if (accountSid && authToken && job.phone && !job.sms_opt_out_at) {
        const smsTpl = await renderCustomerTemplate(job.company_id, reminderTrigger, "sms", mergeVars);
        if (smsTpl && !smsTpl.is_active) {
          console.log(`[reminder-${label}] SMS paused by template job=${job.id}`);
          await logNotification(job.company_id, job.phone, "sms", reminderTrigger, "suppressed", "template_paused", logMeta);
        } else {
          try {
            const smsBody = smsTpl
              ? smsTpl.body
              : hoursAhead === 72
              ? `Hi ${job.first_name || "there"}, this is Phes confirming your cleaning appointment on ${scheduledDate} with a ${arrivalWindowLabel} arrival window at ${serviceAddress}. Questions? Call us at ${branchConfig.clientPhone}. Reply STOP to unsubscribe.`
              : `Hi ${job.first_name || "there"}, your Phes cleaning is tomorrow with a ${arrivalWindowLabel} arrival window at ${serviceAddress}. Please ensure access to your home is available. Questions? Call ${branchConfig.clientPhone}. Reply STOP to unsubscribe.`;
            const smsRes = await fetch(
              `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
              {
                method: "POST",
                headers: {
                  Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({ To: job.phone, From: branchConfig.twilioFrom, Body: smsBody }).toString(),
              }
            );
            if (smsRes.ok) {
              smsSent = true;
              await logNotification(job.company_id, job.phone, "sms", reminderTrigger, "sent", null, logMeta);
            } else {
              const errText = await smsRes.text();
              console.error(`[reminder-${label}] Twilio failed for job ${job.id}:`, errText);
              await logNotification(job.company_id, job.phone, "sms", reminderTrigger, "failed", errText.slice(0, 200), logMeta);
            }
          } catch (smsErr) {
            console.error(`[reminder-${label}] SMS error for job ${job.id}:`, smsErr);
            await logNotification(job.company_id, job.phone, "sms", reminderTrigger, "failed", String(smsErr), logMeta);
          }
        }
      } else if (job.sms_opt_out_at) {
        console.log(`[reminder-${label}] SMS suppressed (opt-out) job=${job.id}`);
      }

      // Mark sent if at least one channel succeeded
      if (emailSent || smsSent) {
        try {
          await db.execute(
            hoursAhead === 72
              ? drizzleSql`UPDATE jobs SET reminder_72h_sent = true WHERE id = ${job.id}`
              : drizzleSql`UPDATE jobs SET reminder_24h_sent = true WHERE id = ${job.id}`
          );
        } catch (markErr) {
          console.error(`[reminder-${label}] Failed to mark ${sentCol} for job ${job.id}:`, markErr);
        }
      }
    }

    console.log(`[notifications] reminder-${label} cron: processed ${jobs.length} jobs`);
  } catch (err) {
    console.error(`[notifications] reminder-${label} cron error:`, err);
  }
}

// ── Scheduled customer-message engine (configurable cadence) ──────────────────
// Generalizes the old fixed 72h/24h reminders into a per-tenant, office-editable
// set of offset-based messages (before/after the appointment), PLUS any custom
// messages the office adds. Drives off customer_message_schedules (timing) +
// notification_templates (copy) and is made idempotent by the job_message_sends
// ledger — a message fires AT MOST once per (job, key, channel), so restarts,
// catch-up runs, and overlapping ticks can never double-send. This REPLACES the
// hardcoded runReminderCron calls in index.ts; runReminderCron is retained only
// as the copy fallback's historical reference and is no longer scheduled.
export async function runScheduledJobMessages(): Promise<void> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] scheduled-messages cron suppressed — COMMS_ENABLED!=true");
    return;
  }
  const { sql: drizzleSql } = await import("drizzle-orm");
  const { renderCustomerTemplate } = await import("../lib/customer-messages.js");

  // CT "now" (DST-aware), matching the offset math used elsewhere.
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1);
  const jul = new Date(now.getFullYear(), 6, 1);
  const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  const isDST = now.getTimezoneOffset() < stdOffset;
  const ctOffset = isDST ? -5 : -6;
  const ctNow = new Date(now.getTime() + ctOffset * 3600000 + now.getTimezoneOffset() * 60000);
  const ctHour = ctNow.getUTCHours();
  const todayStr = ctNow.toISOString().slice(0, 10);

  const resendKey = process.env.RESEND_API_KEY;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  let schedules: any[] = [];
  try {
    const r = await db.execute(drizzleSql`
      SELECT s.company_id, s.key, s.label, s.anchor, s.offset_days, s.send_hour, s.channels
        FROM customer_message_schedules s
        JOIN companies co ON co.id = s.company_id
       WHERE s.is_active = true
         AND s.anchor IN ('before_appointment', 'after_appointment')
         AND co.comms_enabled = true
         AND s.offset_days IS NOT NULL`);
    schedules = (r as any).rows ?? [];
  } catch (err) {
    console.error("[scheduled-messages] failed to load schedules:", err);
    return;
  }

  for (const sched of schedules) {
    try {
      const offset = Number(sched.offset_days);
      const sendHour = sched.send_hour == null ? 0 : Number(sched.send_hour);
      const channels: string[] = Array.isArray(sched.channels) ? sched.channels : [];
      if (!channels.length || !Number.isFinite(offset)) continue;
      const isBefore = sched.anchor === "before_appointment";
      // 1-day catch-up grace for offset >= 2 (a date-based message can fire a day
      // late). offset 1 ("tomorrow"/"day after") gets NO grace — you can't sensibly
      // say "tomorrow" once the day has arrived. This mirrors the deployed
      // reminder behavior (72h fired [today+2,today+3], 24h fired exactly today+1)
      // and stops a same-day job from collecting both the 3-day and 1-day copy.
      const lowerOffset = offset >= 2 ? offset - 1 : offset;

      // Candidate jobs in the catch-up window. before: [today+lowerOffset,
      // today+offset], not yet started; after: [today-offset-1, today-offset],
      // completed.
      const rows = await db.execute(
        isBefore
          ? drizzleSql`
              SELECT j.id, j.company_id, j.client_id, co.name AS company_name,
                     j.scheduled_date::date AS sdate, j.service_type, j.arrival_window,
                     j.address_street, j.address_city, j.address_state, j.address_zip,
                     c.first_name, c.last_name, c.email, c.phone, c.zip,
                     c.sms_opt_out_at, c.email_opt_out_at, c.email_unsub_token
                FROM jobs j
                JOIN clients c ON c.id = j.client_id
                JOIN companies co ON co.id = j.company_id
                LEFT JOIN accounts a ON a.id = c.account_id
               WHERE j.company_id = ${sched.company_id}
                 AND j.scheduled_date >= (${todayStr}::date + ${lowerOffset}::int)
                 AND j.scheduled_date <= (${todayStr}::date + ${offset}::int)
                 AND j.status NOT IN ('cancelled', 'complete')
                 AND (a.id IS NULL OR a.comms_enabled = true)`
          : drizzleSql`
              SELECT j.id, j.company_id, j.client_id, co.name AS company_name,
                     j.scheduled_date::date AS sdate, j.service_type, j.arrival_window,
                     j.address_street, j.address_city, j.address_state, j.address_zip,
                     c.first_name, c.last_name, c.email, c.phone, c.zip,
                     c.sms_opt_out_at, c.email_opt_out_at, c.email_unsub_token
                FROM jobs j
                JOIN clients c ON c.id = j.client_id
                JOIN companies co ON co.id = j.company_id
                LEFT JOIN accounts a ON a.id = c.account_id
               WHERE j.company_id = ${sched.company_id}
                 AND j.scheduled_date <= (${todayStr}::date - ${offset}::int)
                 AND j.scheduled_date >= (${todayStr}::date - ${offset}::int - 1)
                 AND j.status = 'complete'
                 AND (a.id IS NULL OR a.comms_enabled = true)`
      );
      const jobs: any[] = (rows as any).rows ?? [];

      for (const job of jobs) {
        // Hour gate ONLY on the exact target day — earlier (a missed prior day,
        // now caught up) sends immediately so a skipped window self-recovers.
        const sdate = String(job.sdate).slice(0, 10);
        const targetStr = isBefore
          ? new Date(Date.parse(`${todayStr}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
          : new Date(Date.parse(`${todayStr}T00:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);
        if (sdate === targetStr && ctHour < sendHour) continue;

        const jobZip = job.address_zip || job.zip || "";
        const branchConfig = getBranchByZip(jobZip);
        const stateZip = [job.address_state, job.address_zip].filter(Boolean).join(" ");
        const serviceAddress = [job.address_street, job.address_city, stateZip].filter(Boolean).join(", ") || "On file";
        const arrivalWindowLabel = job.arrival_window === "morning" ? "9:00 AM – 12:00 PM"
          : job.arrival_window === "afternoon" ? "12:00 PM – 2:00 PM" : "scheduled window";
        const vars: Record<string, string> = {
          first_name: job.first_name || "there",
          client_name: [job.first_name, job.last_name].filter(Boolean).join(" ") || "there",
          company_name: job.company_name || "Phes",
          company_phone: branchConfig.clientPhone,
          company_email: branchConfig.officeEmail,
          service_type: labelServiceType(job.service_type),
          date: formatDate(job.scheduled_date),
          arrival_window: arrivalWindowLabel,
          service_address: serviceAddress,
        };

        for (const channel of channels) {
          if (channel !== "email" && channel !== "sms") continue;
          // Ledger guard — the hard idempotency gate. One row = already fired.
          const led = await db.execute(drizzleSql`
            SELECT 1 FROM job_message_sends
             WHERE job_id = ${job.id} AND schedule_key = ${sched.key} AND channel = ${channel} LIMIT 1`);
          if (((led as any).rows ?? []).length) continue;

          const tpl = await renderCustomerTemplate(job.company_id, sched.key, channel as "email" | "sms", vars);
          if (tpl && !tpl.is_active) continue; // channel paused by office
          if (!tpl) continue; // no copy row — skip (built-ins always have one)

          if (channel === "email") {
            if (!resendKey || !job.email || job.email_opt_out_at) continue;
            try {
              const htmlBody = /<[a-z][\s\S]*>/i.test(tpl.body) ? tpl.body : tpl.body.replace(/\n/g, "<br>");
              let emailHtml = wrapEmailHtml(htmlBody);
              const headers: Record<string, string> = {};
              if (job.email_unsub_token) {
                const u = buildUnsubDataFromToken(job.email_unsub_token);
                Object.assign(headers, u.headers);
                emailHtml = emailHtml.includes("</body>") ? emailHtml.replace(/<\/body>/i, `${u.footerHtml}</body>`) : emailHtml + u.footerHtml;
              }
              await new Resend(resendKey).emails.send({
                from: `Phes <${branchConfig.officeEmail}>`,
                replyTo: branchConfig.officeEmail,
                to: [job.email],
                subject: tpl.subject || sched.label,
                html: emailHtml,
                ...(Object.keys(headers).length ? { headers } : {}),
              });
              await recordJobMessageSend(job, sched.key, "email", "sent", job.email);
              await logNotification(job.company_id, job.email, "email", sched.key, "sent", null, { job_id: String(job.id) });
            } catch (e) {
              console.error(`[scheduled-messages] email failed key=${sched.key} job=${job.id}:`, e);
            }
          } else {
            if (!accountSid || !authToken || !job.phone || job.sms_opt_out_at) continue;
            try {
              const smsRes = await fetch(
                `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: new URLSearchParams({ To: job.phone, From: branchConfig.twilioFrom, Body: tpl.body }).toString(),
                }
              );
              if (smsRes.ok) {
                await recordJobMessageSend(job, sched.key, "sms", "sent", job.phone);
                await logNotification(job.company_id, job.phone, "sms", sched.key, "sent", null, { job_id: String(job.id) });
              } else {
                console.error(`[scheduled-messages] twilio failed key=${sched.key} job=${job.id}:`, (await smsRes.text()).slice(0, 200));
              }
            } catch (e) {
              console.error(`[scheduled-messages] sms error key=${sched.key} job=${job.id}:`, e);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[scheduled-messages] schedule ${sched.key} (co ${sched.company_id}) error:`, err);
    }
  }
}

// Ledger writer — the row that both prevents a re-send and feeds the customer
// audit trail. ON CONFLICT keeps it idempotent under concurrent ticks.
async function recordJobMessageSend(
  job: { id: number; company_id: number; client_id: number | null },
  scheduleKey: string,
  channel: string,
  status: string,
  recipient: string,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO job_message_sends (company_id, job_id, client_id, schedule_key, channel, status, recipient, sent_at)
      VALUES (${job.company_id}, ${job.id}, ${job.client_id ?? null}, ${scheduleKey}, ${channel}, ${status}, ${recipient}, NOW())
      ON CONFLICT (job_id, schedule_key, channel) DO NOTHING`);
  } catch (err) {
    console.error(`[scheduled-messages] ledger write failed job=${job.id} key=${scheduleKey}:`, err);
  }
}

// ── Review request cron ──────────────────────────────────────────────────────
export async function runReviewRequestCron(): Promise<void> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] runReviewRequestCron suppressed — COMMS_ENABLED=false");
    return;
  }
  try {
    // Match jobs SERVICED yesterday (scheduled_date = yesterday). Using
    // scheduled_date rather than created_at so recurring jobs (booked weeks
    // in advance) still trigger the review request the morning after service.
    // The 30-day survey_last_sent throttle prevents double-sends per client.
    const rows = await db.execute(
      (await import("drizzle-orm")).sql`
        SELECT j.id, j.company_id, j.client_id, j.scheduled_date, j.service_type,
               c.first_name, c.last_name, c.email, c.phone,
               c.address, c.city, c.state, c.survey_last_sent,
               co.review_link
          FROM jobs j
          JOIN clients c ON c.id = j.client_id
          JOIN companies co ON co.id = j.company_id
          LEFT JOIN accounts a ON a.id = c.account_id
         WHERE j.status = 'complete'
           AND j.scheduled_date = (CURRENT_DATE - INTERVAL '1 day')::date
           AND co.comms_enabled = true
           AND (a.id IS NULL OR a.comms_enabled = true)
           AND (c.survey_last_sent IS NULL OR c.survey_last_sent < NOW() - INTERVAL '30 days')
      `
    );
    const jobs: any[] = (rows as any).rows ?? [];
    for (const job of jobs) {
      const mergeVars = {
        first_name:  job.first_name || "",
        review_link: job.review_link || "https://g.page/r/phes/review",
        scope:       labelServiceType(job.service_type),
      };
      await sendNotification("review_request", "email", job.company_id, job.email, null, mergeVars);
      await sendNotification("review_request", "sms",   job.company_id, null, job.phone, mergeVars);
      // Update survey_last_sent
      await db.execute(
        (await import("drizzle-orm")).sql`UPDATE clients SET survey_last_sent = NOW() WHERE id = ${job.client_id}`
      );
    }
    if (jobs.length > 0) console.log(`[notifications] review_request cron: sent ${jobs.length}`);
  } catch (err) {
    console.error("[notifications] review_request cron error:", err);
  }
}

// ── Helper formatters ─────────────────────────────────────────────────────────
function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function formatTime(timeStr: string): string {
  const [h, min] = timeStr.split(":").map(Number);
  const ampm = h < 12 ? "AM" : "PM";
  const hour  = h % 12 || 12;
  return `${hour}:${String(min).padStart(2, "0")} ${ampm}`;
}

function formatTimeOffset(timeStr: string, hoursOffset: number): string {
  const [h, min] = timeStr.split(":").map(Number);
  const newH = h + hoursOffset;
  const ampm = newH < 12 ? "AM" : "PM";
  const hour  = newH % 12 || 12;
  return `${hour}:${String(min).padStart(2, "0")} ${ampm}`;
}

export function labelServiceType(raw: string | null): string {
  if (!raw) return "Cleaning Service";
  return raw.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
