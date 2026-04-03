/**
 * Follow-Up Sequence Engine
 * Handles enrollment, processing, and stop logic for automated follow-up sequences.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Merge field resolver ───────────────────────────────────────────────────────
function resolveMergeFields(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

// ── Twilio SMS sender ──────────────────────────────────────────────────────────
async function sendSms(to: string, body: string): Promise<void> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] Follow-up SMS suppressed:", { to, body: body.substring(0, 80) });
    return;
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !from) throw new Error("Twilio not configured");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    }
  );
  const data = await res.json() as any;
  if (!res.ok) throw new Error(data?.message || "Twilio error");
}

// ── Resend email sender ────────────────────────────────────────────────────────
async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] Follow-up email suppressed:", { to, subject });
    return;
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Resend not configured");
  const { Resend } = await import("resend");
  const resend = new Resend(key);
  const bodyHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#F7F6F3;">
<div style="background:#fff;border:1px solid #E5E2DC;border-radius:8px;padding:32px;">
<div style="background:#5B9BD5;padding:14px 20px;border-radius:4px;margin-bottom:24px;">
  <span style="color:#fff;font-size:16px;font-weight:bold;">Phes Cleaning</span>
</div>
<p style="font-size:15px;color:#1A1917;line-height:1.7;margin:0 0 20px;">${body.replace(/\n/g, "<br>")}</p>
<p style="font-size:13px;color:#9E9B94;margin:0;">Phes Cleaning &mdash; (773) 706-6000 &mdash; info@phes.io</p>
</div></div>`;
  await resend.emails.send({
    from: "Phes Cleaning <noreply@phes.io>",
    to: [to],
    subject,
    html: bodyHtml,
  });
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

// ── Process due enrollments (cron body) ───────────────────────────────────────
export async function processDueEnrollments(): Promise<void> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] processDueEnrollments suppressed — COMMS_ENABLED=false");
    return;
  }
  try {
    const due = await db.execute(sql`
      SELECT
        fe.id, fe.company_id, fe.sequence_id, fe.quote_id, fe.client_id,
        fe.current_step,
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

async function processEnrollment(enr: any): Promise<void> {
  // Fetch the current step
  const stepRows = await db.execute(sql`
    SELECT id, step_number, delay_hours, channel, subject, message_template
    FROM follow_up_steps
    WHERE sequence_id = ${enr.sequence_id} AND step_number = ${enr.current_step}
    LIMIT 1
  `);
  if (!stepRows.rows.length) {
    // No step found — mark complete
    await db.execute(sql`
      UPDATE follow_up_enrollments SET completed_at = NOW() WHERE id = ${enr.id}
    `);
    return;
  }
  const step = stepRows.rows[0] as any;

  // Resolve merge fields from linked client or quote
  let firstName = "";
  let recipientEmail: string | null = null;
  let recipientPhone: string | null = null;

  if (enr.client_id) {
    const clientRows = await db.execute(sql`
      SELECT first_name, email, phone FROM clients WHERE id = ${enr.client_id} LIMIT 1
    `);
    if (clientRows.rows.length) {
      const c = clientRows.rows[0] as any;
      firstName = c.first_name || "";
      recipientEmail = c.email || null;
      recipientPhone = c.phone || null;
    }
  } else if (enr.quote_id) {
    const quoteRows = await db.execute(sql`
      SELECT lead_name, lead_email, lead_phone FROM quotes WHERE id = ${enr.quote_id} LIMIT 1
    `);
    if (quoteRows.rows.length) {
      const q = quoteRows.rows[0] as any;
      firstName = (q.lead_name || "").split(" ")[0] || "";
      recipientEmail = q.lead_email || null;
      recipientPhone = q.lead_phone || null;
    }
  }

  const mergeVars: Record<string, string> = {
    first_name:   firstName,
    company_name: "Phes",
  };
  const body    = resolveMergeFields(step.message_template, mergeVars);
  const subject = step.subject ? resolveMergeFields(step.subject, mergeVars) : "";

  let sendStatus = "sent";
  let sendError  = "";
  try {
    if (step.channel === "sms" && recipientPhone) {
      await sendSms(recipientPhone, body);
    } else if (step.channel === "email" && recipientEmail) {
      await sendEmail(recipientEmail, subject, body);
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

  // Advance or complete
  const nextStepRows = await db.execute(sql`
    SELECT step_number, delay_hours FROM follow_up_steps
    WHERE sequence_id = ${enr.sequence_id} AND step_number = ${enr.current_step + 1}
    LIMIT 1
  `);

  if (nextStepRows.rows.length) {
    const next = nextStepRows.rows[0] as any;
    await db.execute(sql`
      UPDATE follow_up_enrollments
      SET current_step = ${next.step_number},
          next_fire_at = NOW() + (${next.delay_hours} || ' hours')::INTERVAL
      WHERE id = ${enr.id}
    `);
    console.log(`[follow-up] Enrollment ${enr.id} advanced to step ${next.step_number}`);
  } else {
    await db.execute(sql`
      UPDATE follow_up_enrollments SET completed_at = NOW() WHERE id = ${enr.id}
    `);
    console.log(`[follow-up] Enrollment ${enr.id} completed — all steps sent`);
  }
}
