/**
 * Follow-Up Sequence Engine
 * Handles enrollment, processing, and stop logic for automated follow-up sequences.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { resolveSender, sendSmsVia } from "../lib/comms-sender.js";
import { getBranchByZip } from "../lib/branchRouter.js";

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
async function sendEmailRaw(to: string, subject: string, body: string): Promise<string | null> {
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
  const res: any = await resend.emails.send({
    from: "Phes Cleaning <noreply@phes.io>",
    to: [to],
    subject,
    html: bodyHtml,
  });
  return res?.data?.id ?? res?.id ?? null;
}

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log("[COMMS BLOCKED] Follow-up email suppressed:", { to, subject });
    return;
  }
  await sendEmailRaw(to, subject, body);
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
        fe.id, fe.company_id, fe.sequence_id, fe.quote_id, fe.client_id, fe.lead_id,
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
    return;
  }
  const step = stepRows.rows[0] as any;

  // Resolve recipient + zip (for branch routing) from linked client, quote, or lead.
  let firstName = "";
  let recipientEmail: string | null = null;
  let recipientPhone: string | null = null;
  let zip: string | null = null;

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

  const mergeVars: Record<string, string> = {
    first_name:   firstName,
    company_name: "Phes",
  };
  const body    = resolveMergeFields(rawBody, mergeVars);
  const subject = rawSubject ? resolveMergeFields(rawSubject, mergeVars) : "";

  let sendStatus = "sent";
  let sendError  = "";
  // Resolve the per-branch sender once; gates BOTH channels on
  // global master (COMMS_ENABLED) AND company master AND the branch comms flag.
  const sender = await resolveSender(enr.company_id, branchId);
  // Email rides Resend (not Twilio), so it only needs the master/company/branch
  // gates — not from_number/creds. SMS needs the full sender.reason check.
  const masterGate = process.env.COMMS_ENABLED === "true" && sender.enabled && sender.branch_comms_enabled;
  try {
    if (step.channel === "sms" && recipientPhone) {
      if (sender.reason) {
        sendStatus = "blocked";
        sendError  = sender.reason;
        console.log(`[follow-up] SMS suppressed (${sender.reason}) enrollment ${enr.id}`);
      } else {
        await sendSmsVia(sender, recipientPhone, body);
      }
    } else if (step.channel === "email" && recipientEmail) {
      if (!masterGate) {
        sendStatus = "blocked";
        sendError  = sender.reason || "branch_comms_disabled";
        console.log(`[follow-up] email suppressed (${sendError}) enrollment ${enr.id}`);
      } else {
        await sendEmail(recipientEmail, subject, body);
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
    SELECT fe.id, fe.company_id, fe.sequence_id, fe.quote_id, fe.client_id, fe.lead_id, fe.current_step,
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
  }
  const branch = getBranchByZip(zip || "");

  // Prefer managed template, else inline copy; render merge fields
  let rawBody = step.message_template || "", rawSubject = step.subject || "";
  if (step.template_id) {
    const t = await db.execute(sql`SELECT body, subject FROM message_templates WHERE id = ${step.template_id} AND company_id = ${companyId} AND active = true LIMIT 1`);
    if (t.rows.length) { rawBody = (t.rows[0] as any).body || rawBody; rawSubject = (t.rows[0] as any).subject || rawSubject; }
  }
  const mergeVars = { first_name: firstName, company_name: "Phes" };
  const body = resolveMergeFields(rawBody, mergeVars);
  const subject = rawSubject ? resolveMergeFields(rawSubject, mergeVars) : "";

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
    providerId = await sendEmailRaw(recipientEmail, subject, body);
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
