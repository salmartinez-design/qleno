import { db } from "@workspace/db";
import { notificationTemplatesTable, notificationLogTable, clientsTable, companiesTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
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
async function sendTwilioSms(to: string, body: string): Promise<void> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] SMS suppressed:", { to, body: body.substring(0, 80) });
    return;
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !from) throw new Error("Twilio not configured");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });
  if (!res.ok) {
    const err: any = await res.json();
    throw new Error(err?.message || "Twilio error");
  }
}

// ── Core send function ───────────────────────────────────────────────────────
export async function sendNotification(
  templateKey: string,
  channel: "email" | "sms",
  companyId: number,
  recipientEmail: string | null,
  recipientPhone: string | null,
  mergeVars: Record<string, string>
): Promise<void> {
  let status = "sent";
  let errorMsg: string | null = null;

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

      const bodyHtml = tpl.body_html || tpl.body || "";
      const subject  = applyMerge(tpl.subject || "", fullVars);
      const rawHtml  = applyMerge(bodyHtml, fullVars);
      const wrapped  = applyMerge(wrapEmailHtml(rawHtml), fullVars);

      if (process.env.COMMS_ENABLED !== "true") {
        console.log("[COMMS BLOCKED] Email suppressed:", { to: recipientEmail, subject });
        await logNotification(companyId, recipientEmail, channel, templateKey, "suppressed", "COMMS_ENABLED=false", fullVars);
        return;
      }
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from:     "info@phes.io",
        replyTo:  "info@phes.io",
        to:       recipientEmail,
        subject,
        html:     wrapped,
      });

    } else if (channel === "sms") {
      if (!recipientPhone) {
        await logNotification(companyId, "no-phone", channel, templateKey, "skipped", "No recipient phone", fullVars);
        return;
      }
      if (!process.env.TWILIO_ACCOUNT_SID) {
        await logNotification(companyId, recipientPhone, channel, templateKey, "skipped", "Twilio not configured", fullVars);
        return;
      }

      const bodyText = applyMerge(tpl.body_text || tpl.body || "", fullVars);
      await sendTwilioSms(recipientPhone, bodyText);
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
    mergeVars,
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
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] runReminderCron suppressed — COMMS_ENABLED=false");
    return;
  }
  try {
    const target = new Date();
    target.setDate(target.getDate() + daysAhead);
    const targetStr = target.toISOString().slice(0, 10);
    const templateKey = daysAhead === 3 ? "reminder_3day" : "reminder_1day";

    const rows = await db.execute(
      (await import("drizzle-orm")).sql`
        SELECT j.id, j.scheduled_date, j.scheduled_time, j.service_type, j.company_id,
               c.first_name, c.last_name, c.email, c.phone,
               c.address, c.city, c.state, c.zip,
               co.name AS company_name, co.phone AS company_phone, co.email AS company_email
          FROM jobs j
          JOIN clients c ON c.id = j.client_id
          JOIN companies co ON co.id = j.company_id
         WHERE j.scheduled_date = ${targetStr}
           AND j.status NOT IN ('cancelled', 'complete')
      `
    );
    const jobs: any[] = (rows as any).rows ?? [];
    for (const job of jobs) {
      const addr = [job.address, job.city, job.state].filter(Boolean).join(", ");
      const window = job.scheduled_time
        ? `${formatTime(job.scheduled_time)} \u2013 ${formatTimeOffset(job.scheduled_time, 2)}`
        : "scheduled window";
      const mergeVars = {
        first_name:          job.first_name || "",
        last_name:           job.last_name  || "",
        appointment_date:    formatDate(job.scheduled_date),
        appointment_window:  window,
        service_address:     addr,
        scope:               labelServiceType(job.service_type),
      };
      await sendNotification(templateKey, "email", job.company_id, job.email, null, mergeVars);
      await sendNotification(templateKey, "sms",   job.company_id, null, job.phone, mergeVars);
    }
    console.log(`[notifications] ${templateKey} cron: processed ${jobs.length} jobs`);
  } catch (err) {
    console.error(`[notifications] reminder cron error:`, err);
  }
}

// ── Review request cron ──────────────────────────────────────────────────────
export async function runReviewRequestCron(): Promise<void> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] runReviewRequestCron suppressed — COMMS_ENABLED=false");
    return;
  }
  try {
    const cutoffMs  = 24 * 60 * 60 * 1000;
    const now       = new Date();
    const from      = new Date(now.getTime() - cutoffMs - 30 * 60 * 1000); // 24h30m ago
    const to        = new Date(now.getTime() - cutoffMs + 30 * 60 * 1000); // 23h30m ago
    const fromStr   = from.toISOString().slice(0, 10);

    const rows = await db.execute(
      (await import("drizzle-orm")).sql`
        SELECT j.id, j.company_id, j.client_id, j.created_at, j.scheduled_date, j.service_type,
               c.first_name, c.last_name, c.email, c.phone,
               c.address, c.city, c.state, c.survey_last_sent,
               co.review_link
          FROM jobs j
          JOIN clients c ON c.id = j.client_id
          JOIN companies co ON co.id = j.company_id
         WHERE j.status = 'complete'
           AND DATE(j.created_at) = ${fromStr}
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
