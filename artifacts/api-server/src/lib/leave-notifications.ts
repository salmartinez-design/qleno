/**
 * Time-off request notifications — mirrors MaidCentral's employee
 * "Schedule Request" workflow, extended to SMS (Sal wants employee-facing
 * decisions on SMS + email; MC is email-only).
 *
 * Flow (Sal 2026-07-06: "ensure the office is getting an email of the request
 * as well as an employee ticket. In addition that they get an email letting
 * them know of the approval… we have to also do the email templates now"):
 *   - submit  → EMPLOYEE "Your Time-Off Request is Pending (<dates>)"
 *               (short-notice/sick → "Emergency Request Received")
 *             + OFFICE/OWNER in-app "ACTION REQUIRED" AND a direct email to
 *               every office/owner/admin user (template: leave_request_office).
 *               (The employee TICKET is created in the POST /requests route —
 *               a durable contact_tickets row, not a notification.)
 *   - approve → EMPLOYEE "Your Time-Off Request was Approved (<dates>)"
 *   - deny    → EMPLOYEE "Your Time-Off Request was Denied (<dates>)"
 *
 * Templates ([leave-templates 2026-07-07]): every email renders from the
 * tenant's editable notification_templates rows (triggers:
 * leave_request_office / leave_request_pending / leave_request_emergency /
 * leave_request_approved / leave_request_denied, channel 'email' — seeded in
 * phes-data-migration). A missing/inactive template falls back to the
 * built-in copy below, so a template mishap can never silence the flow.
 *
 * Gating ([staff-class 2026-07-07]): time-off emails go to EMPLOYEES and
 * OFFICE STAFF — internal workforce communications, not customer comms — so
 * they are TRANSACTIONAL/UNGATED like the staff-alert emails in notify.ts
 * (sendStaffAlertEmail precedent: "bypasses COMMS_ENABLED — internal staff
 * notification, never customer-facing"). Previously the employee emails were
 * gated by COMMS_ENABLED + the per-company comms pause, which meant NO
 * approval email ever reached an employee while customer comms stay paused —
 * exactly what Sal reported. Employee SMS keeps the full comms gate ladder
 * (per-tenant Twilio + comms flags) — texting stays off until comms go live.
 *
 * All sends are best-effort and never throw into the request path — the
 * leave_request row in the DB is the source of truth.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { notifyUser, notifyOfficeUsers } from "./notify.js";
import { resolveSender, sendSmsVia } from "./comms-sender.js";
import { applyMerge, wrapEmailHtml } from "../services/notificationService.js";
import { appBaseUrl } from "./app-url.js";

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
  start_time: string | null;
  end_time: string | null;
  note: string | null;
  status: string;
  decision_note: string | null;
  company_name: string;
  company_phone: string;
  company_email: string;
  company_logo_url: string | null;
  email_from: string;
};

async function loadCtx(requestId: number): Promise<LeaveCtx | null> {
  const r = await db.execute(sql`
    SELECT lr.id, lr.company_id, lr.user_id, lr.start_date, lr.end_date, lr.hours,
           lr.start_time, lr.end_time, lr.note, lr.status, lr.decision_note,
           lt.display_name AS bucket_name, lt.exempt_from_blackout,
           u.first_name, u.last_name, u.email, u.phone,
           c.name AS company_name, c.phone AS company_phone, c.email AS company_email,
           c.logo_url AS company_logo_url, c.email_from_address
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
    start_time: row.start_time ? String(row.start_time).slice(0, 5) : null,
    end_time: row.end_time ? String(row.end_time).slice(0, 5) : null,
    note: row.note ?? null,
    status: String(row.status),
    decision_note: row.decision_note ?? null,
    company_name: row.company_name || "Qleno",
    company_phone: row.company_phone || "",
    company_email: row.company_email || "",
    company_logo_url: row.company_logo_url || null,
    email_from: row.email_from_address || "noreply@phes.io",
  };
}

function dateLabel(c: LeaveCtx): string {
  const base = c.start_date === c.end_date ? c.start_date : `${c.start_date} → ${c.end_date}`;
  return c.start_time && c.end_time ? `${base}, ${c.start_time}–${c.end_time}` : base;
}

/** Merge vars available to every leave email template. */
function mergeVars(c: LeaveCtx): Record<string, string> {
  return {
    first_name: c.employee_first,
    employee_name: c.employee_name,
    bucket_name: c.bucket_name,
    dates: dateLabel(c),
    hours: Number(c.hours).toFixed(2),
    time_window: c.start_time && c.end_time ? `${c.start_time}–${c.end_time}` : "",
    note: c.note ?? "",
    decision_note: c.decision_note ?? "",
    review_link: `${appBaseUrl()}/leave-review`,
    my_time_off_link: `${appBaseUrl()}/leave`,
    company_name: c.company_name,
    company_phone: c.company_phone,
    company_email: c.company_email,
  };
}

/** Load the tenant's editable template for a leave trigger; null → fallback. */
async function loadTemplate(companyId: number, trigger: string): Promise<{ subject: string | null; body_html: string | null } | null> {
  try {
    const r = await db.execute(sql`
      SELECT subject, body_html FROM notification_templates
       WHERE company_id = ${companyId} AND trigger = ${trigger}
         AND channel = 'email' AND is_active = true
       LIMIT 1`);
    const row: any = r.rows[0];
    if (!row || !row.body_html) return null;
    return { subject: row.subject ?? null, body_html: String(row.body_html) };
  } catch {
    return null;
  }
}

/** Render subject+html from the tenant template, falling back to built-ins. */
async function renderEmail(
  c: LeaveCtx,
  trigger: string,
  fallbackSubject: string,
  fallbackBodyHtml: string,
): Promise<{ subject: string; html: string }> {
  const vars = mergeVars(c);
  const tpl = await loadTemplate(c.company_id, trigger);
  const subject = applyMerge(tpl?.subject || fallbackSubject, vars);
  const inner = applyMerge(tpl?.body_html || fallbackBodyHtml, vars);
  // Same branded wrapper the customer templates use (logo header + footer);
  // the wrapper's own {{company_*}} footer tags resolve from the same vars.
  const html = applyMerge(
    wrapEmailHtml(inner, { logoUrl: c.company_logo_url, companyName: c.company_name }),
    vars,
  );
  return { subject, html };
}

/** [staff-class 2026-07-07] Internal workforce email — TRANSACTIONAL/UNGATED,
 *  same class as notify.ts sendStaffAlertEmail. Never customer-facing. */
async function sendInternalEmail(c: LeaveCtx, to: string, subject: string, html: string): Promise<void> {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key || !to) return;
    const from = `${c.company_name} <${c.email_from}>`;
    const { Resend } = await import("resend");
    const resend = new Resend(key);
    const r: any = await resend.emails.send({ from, to: [to], subject, html });
    if (r?.error) console.error("[leave-notify] email error:", r.error?.message ?? r.error);
  } catch (e) {
    console.error("[leave-notify] email failed:", e);
  }
}

/** Employee-facing SMS — keeps the full comms gate ladder (COMMS_ENABLED +
 *  per-tenant flags + Twilio config via resolveSender). */
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

/** Direct email to every active office/owner/admin user in the tenant. */
async function emailOfficeUsers(c: LeaveCtx, subject: string, html: string): Promise<void> {
  try {
    const users = await db.execute(sql`
      SELECT DISTINCT u.email FROM users u
       WHERE u.is_active = true AND u.email IS NOT NULL AND u.email <> '' AND (
         (u.company_id = ${c.company_id} AND u.role IN ('owner', 'admin', 'office'))
         OR u.id IN (SELECT user_id FROM user_companies
                      WHERE company_id = ${c.company_id} AND role IN ('owner', 'admin', 'office'))
       )`);
    for (const u of users.rows as any[]) {
      await sendInternalEmail(c, String(u.email), subject, html);
    }
  } catch (e) {
    console.error("[leave-notify] office email fan-out failed:", e);
  }
}

/** On submit: office/owner "ACTION REQUIRED" (in-app + DIRECT EMAIL) +
 *  employee "Pending"/"Emergency" (or "Denied" if auto-denied at create). */
export async function notifyLeaveSubmitted(requestId: number, companyId: number): Promise<void> {
  const c = await loadCtx(requestId);
  if (!c) return;
  const dates = dateLabel(c);

  // Office + owner: ACTION REQUIRED. In-app + push via notify.ts, PLUS a
  // direct template-driven email to each office user (Sal: "ensure the office
  // is getting an email of the request"). Both fire even for auto-denied
  // (blackout) submissions — the office should know a request bounced.
  await notifyOfficeUsers(companyId, {
    type: "leave_request",
    title: `ACTION REQUIRED: Review ${c.employee_name}'s time-off request`,
    body: `${c.employee_name} requested ${Number(c.hours).toFixed(2)} h of ${c.bucket_name} for ${dates}. Review and approve or deny.`,
    link: "/leave-review",
    meta: { request_id: requestId },
  });
  {
    const { subject, html } = await renderEmail(
      c,
      "leave_request_office",
      `ACTION REQUIRED: {{employee_name}} requested time off ({{dates}})`,
      `<p style="margin:0 0 20px"><strong>{{employee_name}}</strong> submitted a time-off request.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E5E2DC;border-radius:6px;background:#FFFFFF;margin:0 0 24px">
<tr><td style="padding:20px">
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Type</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917;font-weight:600">{{bucket_name}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Dates</p>
  <p style="margin:0 0 16px;font-size:15px;color:#1A1917;font-weight:600">{{dates}}</p>
  <p style="margin:0 0 8px;font-size:13px;color:#6B6860;text-transform:uppercase;letter-spacing:.05em">Hours</p>
  <p style="margin:0;font-size:15px;color:#1A1917;font-weight:600">{{hours}}</p>
</td></tr>
</table>
<div style="text-align:center;margin:0 0 8px">
  <a href="{{review_link}}" style="display:inline-block;background:#5B9BD5;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:6px">Review &amp; Approve or Deny</a>
</div>`,
    );
    await emailOfficeUsers(c, subject, html);
  }

  // Auto-denied at create (blackout overlap on a non-exempt bucket) — tell the
  // employee the outcome; the office email above already carried the request.
  if (c.status === "denied") {
    await notifyLeaveDecision(requestId, "denied");
    return;
  }

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
    const { subject, html } = await renderEmail(
      c,
      "leave_request_emergency",
      `ATTN: You've submitted an Emergency Request ({{dates}})`,
      `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px">We received your <strong>emergency</strong> time-off request for <strong>{{bucket_name}}</strong> on <strong>{{dates}}</strong> ({{hours}} h). The office will follow up shortly.</p>`,
    );
    await sendInternalEmail(c, c.employee_email ?? "", subject, html);
    await sendEmployeeSms(c, `${c.company_name}: Emergency time-off request received for ${dates} (${c.bucket_name}). The office will follow up.`);
  } else {
    const { subject, html } = await renderEmail(
      c,
      "leave_request_pending",
      `Your Time-Off Request is Pending ({{dates}})`,
      `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px">Your request for <strong>{{bucket_name}}</strong> on <strong>{{dates}}</strong> ({{hours}} h) is pending office approval. You'll get a message when it's decided.</p>`,
    );
    await sendInternalEmail(c, c.employee_email ?? "", subject, html);
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
    const { subject, html } = await renderEmail(
      c,
      "leave_request_approved",
      `Congrats! Your Time-Off Request has been Approved ({{dates}})`,
      `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px">Your request for <strong>{{bucket_name}}</strong> on <strong>{{dates}}</strong> ({{hours}} h) has been <strong>approved</strong>. Enjoy your time off.</p>`,
    );
    await sendInternalEmail(c, c.employee_email ?? "", subject, html);
    await sendEmployeeSms(c, `${c.company_name}: Your time-off request for ${dates} (${c.bucket_name}) was APPROVED.`);
  } else {
    const { subject, html } = await renderEmail(
      c,
      "leave_request_denied",
      `Your Time-Off Request has been Denied ({{dates}})`,
      `<p style="margin:0 0 20px">Hi {{first_name}},</p>
<p style="margin:0 0 20px">Your request for <strong>{{bucket_name}}</strong> on <strong>{{dates}}</strong> ({{hours}} h) was <strong>denied</strong>.</p>
<p style="margin:0 0 20px;color:#6B6860">{{decision_note}}</p>
<p style="margin:0">Please reach out to the office with questions.</p>`,
    );
    await sendInternalEmail(c, c.employee_email ?? "", subject, html);
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
