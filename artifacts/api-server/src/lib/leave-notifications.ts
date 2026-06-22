/**
 * Time-off request notifications — mirrors MaidCentral's employee
 * "Schedule Request" workflow, extended to SMS (Sal wants employee-facing
 * decisions on SMS + email; MC is email-only).
 *
 * MC templates mirrored (subjects kept close to MC's wording):
 *   - submit  → EMPLOYEE "Your Time-Off Request is Pending (<dates>)"
 *               (short-notice/sick → "Emergency Request Received")
 *             + OFFICE/OWNER "ACTION REQUIRED: review & approve …"
 *   - approve → EMPLOYEE "Your Time-Off Request was Approved (<dates>)"
 *   - deny    → EMPLOYEE "Your Time-Off Request was Denied (<dates>)"
 *
 * Channels:
 *   - In-app + web push: via notify.ts (internal staff alerts, ungated).
 *   - Office/owner email: via notifyOfficeUsers (existing staff-alert path).
 *   - EMPLOYEE email + SMS: employee-facing → gated by COMMS_ENABLED
 *     (SMS additionally by the per-tenant/branch gate via resolveSender),
 *     honoring the hard rule that no SMS/email leaves the system until
 *     comms are explicitly enabled. Until then employees still get the
 *     in-app + push alert.
 *
 * All sends are best-effort and never throw into the request path — the
 * leave_request row in the DB is the source of truth.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { notifyUser, notifyOfficeUsers } from "./notify.js";
import { resolveSender, sendSmsVia } from "./comms-sender.js";

type LeaveCtx = {
  request_id: number;
  company_id: number;
  user_id: number;
  employee_name: string;
  employee_first: string;
  employee_email: string | null;
  employee_phone: string | null;
  bucket_name: string;
  exempt_from_blackout: boolean;
  start_date: string;
  end_date: string;
  hours: string;
  status: string;
  decision_note: string | null;
  company_name: string;
  email_from: string;
};

async function loadCtx(requestId: number): Promise<LeaveCtx | null> {
  const r = await db.execute(sql`
    SELECT lr.id, lr.company_id, lr.user_id, lr.start_date, lr.end_date, lr.hours,
           lr.status, lr.decision_note,
           lt.display_name AS bucket_name, lt.exempt_from_blackout,
           u.first_name, u.last_name, u.email, u.phone,
           c.name AS company_name, c.email_from_address
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      JOIN users u ON u.id = lr.user_id
      JOIN companies c ON c.id = lr.company_id
     WHERE lr.id = ${requestId} LIMIT 1`);
  const row: any = r.rows[0];
  if (!row) return null;
  return {
    request_id: Number(row.id),
    company_id: Number(row.company_id),
    user_id: Number(row.user_id),
    employee_name: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim(),
    employee_first: row.first_name ?? "there",
    employee_email: row.email ?? null,
    employee_phone: row.phone ?? null,
    bucket_name: row.bucket_name,
    exempt_from_blackout: !!row.exempt_from_blackout,
    start_date: String(row.start_date),
    end_date: String(row.end_date),
    hours: String(row.hours),
    status: String(row.status),
    decision_note: row.decision_note ?? null,
    company_name: row.company_name || "Qleno",
    email_from: row.email_from_address || "noreply@phes.io",
  };
}

function dateLabel(c: LeaveCtx): string {
  return c.start_date === c.end_date ? c.start_date : `${c.start_date} → ${c.end_date}`;
}

/** Employee-facing email — gated by COMMS_ENABLED (employee-facing comms). */
async function sendEmployeeEmail(c: LeaveCtx, subject: string, bodyHtml: string): Promise<void> {
  try {
    if (process.env.COMMS_ENABLED !== "true") return;
    const key = process.env.RESEND_API_KEY;
    if (!key || !c.employee_email) return;
    const from = `${c.company_name} <${c.email_from}>`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1A1917">
${bodyHtml}
<p style="font-size:12px;color:#9E9B94;margin:16px 0 0">${c.company_name} · Time Off</p>
</div>`;
    const { Resend } = await import("resend");
    const resend = new Resend(key);
    const r: any = await resend.emails.send({ from, to: [c.employee_email], subject, html });
    if (r?.error) console.error("[leave-notify] employee email error:", r.error?.message ?? r.error);
  } catch (e) {
    console.error("[leave-notify] employee email failed:", e);
  }
}

/** Employee-facing SMS — gated by COMMS_ENABLED + tenant/branch via resolveSender. */
async function sendEmployeeSms(c: LeaveCtx, body: string): Promise<void> {
  try {
    if (!c.employee_phone) return;
    const sender = await resolveSender(c.company_id, null);
    if (sender.reason) {
      console.log(`[leave-notify] SMS suppressed (${sender.reason}) for request #${c.request_id}`);
      return;
    }
    await sendSmsVia(sender, c.employee_phone, body);
  } catch (e) {
    console.error("[leave-notify] employee SMS failed:", e);
  }
}

/** On submit: office/owner "ACTION REQUIRED" + employee "Pending"/"Emergency"
 *  (or "Denied" if the request was auto-denied at create, e.g. blackout). */
export async function notifyLeaveSubmitted(requestId: number, companyId: number): Promise<void> {
  const c = await loadCtx(requestId);
  if (!c) return;
  const dates = dateLabel(c);

  // Auto-denied at create (blackout overlap on a non-exempt bucket).
  if (c.status === "denied") {
    await notifyLeaveDecision(requestId, "denied");
    return;
  }

  // Office + owner: ACTION REQUIRED (in-app + push + staff email).
  await notifyOfficeUsers(companyId, {
    type: "leave_request",
    title: `ACTION REQUIRED: Review ${c.employee_name}'s time-off request`,
    body: `${c.employee_name} requested ${Number(c.hours).toFixed(2)} h of ${c.bucket_name} for ${dates}. Review and approve or deny.`,
    link: "/leave-review",
    meta: { request_id: requestId },
  });

  // Employee: emergency (short-notice/sick) vs standard pending.
  const emergency = c.exempt_from_blackout || isShortNotice(c.start_date);
  await notifyUser({
    companyId,
    userId: c.user_id,
    type: "leave_request",
    title: emergency ? "Emergency time-off request received" : "Your time-off request is pending",
    body: `${c.bucket_name} · ${dates} · ${Number(c.hours).toFixed(2)} h`,
    link: "/leave",
    meta: { request_id: requestId },
  });
  if (emergency) {
    await sendEmployeeEmail(
      c,
      `ATTN: You've submitted an Emergency Request (${dates})`,
      `<p style="font-size:16px;font-weight:700;margin:0 0 8px">Emergency time-off request received</p>
<p style="font-size:14px;line-height:1.5;margin:0">Hi ${c.employee_first}, we received your emergency request for <b>${c.bucket_name}</b> on <b>${dates}</b> (${Number(c.hours).toFixed(2)} h). The office will follow up shortly.</p>`,
    );
    await sendEmployeeSms(c, `${c.company_name}: Emergency time-off request received for ${dates} (${c.bucket_name}). The office will follow up.`);
  } else {
    await sendEmployeeEmail(
      c,
      `Your Time-Off Request is Pending (${dates})`,
      `<p style="font-size:16px;font-weight:700;margin:0 0 8px">Your time-off request is pending</p>
<p style="font-size:14px;line-height:1.5;margin:0">Hi ${c.employee_first}, your request for <b>${c.bucket_name}</b> on <b>${dates}</b> (${Number(c.hours).toFixed(2)} h) is pending office approval. You'll get a message when it's decided.</p>`,
    );
    await sendEmployeeSms(c, `${c.company_name}: Your time-off request for ${dates} (${c.bucket_name}) is pending approval.`);
  }
}

/** On approve/deny: employee Approved/Denied (in-app + push + email + SMS). */
export async function notifyLeaveDecision(requestId: number, outcome: "approved" | "denied"): Promise<void> {
  const c = await loadCtx(requestId);
  if (!c) return;
  const dates = dateLabel(c);
  const approved = outcome === "approved";

  await notifyUser({
    companyId: c.company_id,
    userId: c.user_id,
    type: "leave_decision",
    title: approved ? "Your time-off request was approved" : "Your time-off request was denied",
    body: `${c.bucket_name} · ${dates}${c.decision_note ? ` · ${c.decision_note}` : ""}`,
    link: "/leave",
    meta: { request_id: requestId },
  });

  if (approved) {
    await sendEmployeeEmail(
      c,
      `Congrats! Your Time-Off Request has been Approved (${dates})`,
      `<p style="font-size:16px;font-weight:700;margin:0 0 8px">Your time-off request was approved</p>
<p style="font-size:14px;line-height:1.5;margin:0">Hi ${c.employee_first}, your request for <b>${c.bucket_name}</b> on <b>${dates}</b> (${Number(c.hours).toFixed(2)} h) has been <b>approved</b>.</p>`,
    );
    await sendEmployeeSms(c, `${c.company_name}: Your time-off request for ${dates} (${c.bucket_name}) was APPROVED.`);
  } else {
    const note = c.decision_note ? ` Reason: ${c.decision_note}.` : "";
    await sendEmployeeEmail(
      c,
      `Your Time-Off Request has been Denied (${dates})`,
      `<p style="font-size:16px;font-weight:700;margin:0 0 8px">Your time-off request was denied</p>
<p style="font-size:14px;line-height:1.5;margin:0">Hi ${c.employee_first}, your request for <b>${c.bucket_name}</b> on <b>${dates}</b> (${Number(c.hours).toFixed(2)} h) was <b>denied</b>.${note} Please reach out to the office with questions.</p>`,
    );
    await sendEmployeeSms(c, `${c.company_name}: Your time-off request for ${dates} (${c.bucket_name}) was denied.${c.decision_note ? ` ${c.decision_note}` : ""}`);
  }
}

/** Short notice = start date within the 7-day window from today (UTC date). */
function isShortNotice(startDate: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const cutoff = new Date(`${today}T00:00:00Z`).getTime() + 7 * 86400000;
  return start < cutoff;
}
