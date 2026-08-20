// [service-suspension 2026-07-11] Service-suspension engine: idempotent boot
// migration, the client service-info resolver, and the daily lifecycle cron
// (30-days-before-expiry resume reminder + at-expiry final notice). The
// suspend/resume ACTIONS live in routes/client-suspension.ts; this module owns
// the schema + the time-driven sends.
//
// All customer messages route through the standard sendNotification() pipeline
// (editable Customer-Messages templates, house chrome, COMMS_ENABLED gate,
// email/SMS opt-out, per-tenant sender, comm log) — the triggers are
// service_suspended / suspension_resume_reminder / suspension_expired in
// lib/customer-messages.ts. prefClientId is omitted so the per-client
// preference gate never runs (these are account-lifecycle, not the 6 job msgs).
//
// Design decisions (locked with the owner 2026-07-11):
//   - Suspending cancels future jobs + deactivates recurring schedules
//     (mirrors routes/cancellation.ts cancel_service).
//   - At the 90-day expiry we FLAG for office (final message) — NO automatic
//     cancel or resume; a person decides.
//   - Office picks the end date, default +90 days, capped at 90.
//
// [hold-allowance 2026-08-20] NARROW REVERSAL of the flag-for-office rule, for
// NOTICE holds only. A hold that exceeded the client's free-day allowance is,
// under Section 9 of the service agreement, the client's written termination
// notice. The agreement fixes what happens the day it runs out: service ends and
// the notice-period visits are billed. A human cannot be the one to decide that
// without contradicting a signed contract. FREE holds are untouched — they still
// flag for the office and change nothing. The branch is on the service_holds
// ledger's `kind`; a client with no ledger row (any hold placed before this
// shipped) falls through to the original flag-for-office path.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sendNotification, labelServiceType } from "../services/notificationService.js";
import { getActiveHold, endExpiredNoticeHold } from "./service-hold.js";

export const MAX_SUSPEND_DAYS = 90;
export const RESUME_REMINDER_LEAD_DAYS = 30;

// Hold-date formatters: long form for email ("Monday, October 12, 2026"), short
// for SMS ("Oct 12, 2026"). Both anchor a bare YYYY-MM-DD at local noon so the
// day never shifts across a US-Central timezone boundary.
function fmtHoldDate(ymd: string, opts: Intl.DateTimeFormatOptions): string {
  const s = /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd + "T12:00:00" : ymd;
  const d = new Date(s);
  return isNaN(d.getTime()) ? ymd : d.toLocaleDateString("en-US", opts);
}
export function fmtHoldDateLong(ymd: string): string {
  return fmtHoldDate(ymd, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
export function fmtHoldDateShort(ymd: string): string {
  return fmtHoldDate(ymd, { year: "numeric", month: "short", day: "numeric" });
}

const FREQ_LABEL: Record<string, string> = {
  weekly: "Weekly", biweekly: "Bi-weekly", every_2_weeks: "Bi-weekly",
  every_3_weeks: "Every 3 weeks", monthly: "Monthly", monthly_weekday: "Monthly",
  semi_monthly: "Twice a month", daily: "Daily", weekdays: "Weekday",
  custom_days: "Recurring", on_demand: "As-needed",
};
function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
function money(v: unknown): string | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  if (!isFinite(n) || n <= 0) return null;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// Resolve the client's current service description + per-visit price for the
// suspension messages ("the service they have and the price they pay"). Prefers
// the client's recurring schedule (the carrier of the real cadence + rate),
// falling back to the client record. Always returns display-ready strings.
export async function resolveServiceInfo(
  companyId: number,
  clientId: number,
): Promise<{ serviceSummary: string; servicePrice: string }> {
  let freq: string | null = null, svc: string | null = null;
  let fee: unknown = null, monthly: unknown = null;
  try {
    const rs = await db.execute(sql`
      SELECT frequency, service_type, base_fee, monthly_charge_amount
        FROM recurring_schedules
       WHERE customer_id = ${clientId} AND company_id = ${companyId}
       ORDER BY (is_active OR paused_by_suspension) DESC, id DESC
       LIMIT 1
    `);
    const r: any = rs.rows[0];
    if (r) { freq = r.frequency; svc = r.service_type; fee = r.base_fee; monthly = r.monthly_charge_amount; }
  } catch { /* fall through to client fields */ }

  let clientType = "residential", hourly: unknown = null;
  try {
    const cl = await db.execute(sql`
      SELECT frequency, service_type, base_fee, commercial_hourly_rate, client_type
        FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1
    `);
    const c: any = cl.rows[0] || {};
    freq = freq || c.frequency; svc = svc || c.service_type; fee = fee ?? c.base_fee;
    clientType = c.client_type || "residential"; hourly = c.commercial_hourly_rate;
  } catch { /* use whatever we have */ }

  // Resolve the service_type slug to the tenant's OWN display label. This is the
  // per-tenant source of truth that covers residential, commercial, AND any
  // custom types the office added — so a unique slug on one client still shows a
  // proper name. Falls back to the static labeler, then a plain title-case.
  let svcLabel = "";
  if (svc) {
    try {
      const st = await db.execute(sql`
        SELECT name FROM service_types
         WHERE company_id = ${companyId} AND slug = ${String(svc)}
         ORDER BY is_active DESC, display_order ASC
         LIMIT 1
      `);
      svcLabel = String((st.rows[0] as any)?.name || "").trim();
    } catch { /* table may be mid-migration — fall back below */ }
    if (!svcLabel) svcLabel = labelServiceType(String(svc)) || titleCase(String(svc));
  }

  const freqLabel = freq ? (FREQ_LABEL[String(freq)] || titleCase(String(freq))) : "";
  const serviceSummary = svcLabel
    ? [freqLabel, svcLabel].filter(Boolean).join(" ")
    : (freqLabel ? `${freqLabel} cleaning` : "your recurring cleaning service");

  // Price catches per-visit, monthly-batch commercial, and hourly commercial.
  const perMonth = money(monthly);
  const perVisit = money(fee);
  const hourlyStr = money(hourly);
  const servicePrice = perMonth
    ? `${perMonth} per month`
    : perVisit
      ? `${perVisit} per visit`
      : (clientType === "commercial" && hourlyStr)
        ? `${hourlyStr}/hr`
        // Fallback deliberately avoids the word "rate" so it composes cleanly in
        // copy like "keep your rate of {price}" without doubling up.
        : "your current pricing";

  return { serviceSummary, servicePrice };
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
    // The hold ledger rides along here rather than claiming its own boot step,
    // so it inherits the same withBootTimeout wrapper in index.ts.
    const { runServiceHoldMigration } = await import("./service-hold.js");
    await runServiceHoldMigration();
  } catch (err) {
    console.error("[suspension] migration error (non-fatal):", err);
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

// Office heads-up on the client's notifications feed. Never throws — an alert
// that fails must not roll back the lifecycle work that produced it.
async function officeNotice(companyId: number, clientId: number, title: string, body: string): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO notifications (company_id, user_id, type, title, body, link)
      VALUES (${companyId}, NULL, 'suspension_expired', ${title}, ${body}, ${`/customers/${clientId}`})
    `);
  } catch (e) { console.warn("[suspension] office notification non-fatal:", e); }
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
      SELECT c.id, c.company_id, c.first_name, c.email, c.phone, c.suspend_until
        FROM clients c
       WHERE c.suspended_at IS NOT NULL
         AND c.suspend_until IS NOT NULL
         AND c.suspend_resume_reminder_sent_at IS NULL
         AND c.suspend_until > ${todayYmd}::date
         AND c.suspend_until <= (${todayYmd}::date + ${RESUME_REMINDER_LEAD_DAYS} * INTERVAL '1 day')
    `);
    for (const r of due.rows as any[]) {
      const expiry = String(r.suspend_until).slice(0, 10);
      const svc = await resolveServiceInfo(r.company_id, r.id);
      const base = { first_name: r.first_name || "there", service_summary: svc.serviceSummary, service_price: svc.servicePrice };
      await sendNotification("suspension_resume_reminder", "email", r.company_id, r.email, null, { ...base, end_date: fmtHoldDateLong(expiry) }).catch(() => false);
      await sendNotification("suspension_resume_reminder", "sms", r.company_id, null, r.phone, { ...base, end_date: fmtHoldDateShort(expiry) }).catch(() => false);
      // Stamp regardless of whether a message actually shipped (opt-out /
      // comms-off) so we never re-scan this client every day. sendNotification
      // logs the suppression reason to notification_log.
      await db.execute(sql`UPDATE clients SET suspend_resume_reminder_sent_at = now() WHERE id = ${r.id}`);
      await logClientComm(r.company_id, r.id, "Resume reminder", "Resume reminder sent (30 days before hold ends).");
      reminders++;
    }
  } catch (e) {
    console.error("[suspension] resume-reminder pass error:", e);
  }

  // ── B) at-expiry final notice (flag for office; no state change) ─────────────
  try {
    const expired = await db.execute(sql`
      SELECT c.id, c.company_id, c.first_name, c.email, c.phone, c.suspend_until
        FROM clients c
       WHERE c.suspended_at IS NOT NULL
         AND c.suspend_until IS NOT NULL
         AND c.suspend_expiry_notice_sent_at IS NULL
         AND c.suspend_until <= ${todayYmd}::date
    `);
    for (const r of expired.rows as any[]) {
      const expiry = String(r.suspend_until).slice(0, 10);
      const svc = await resolveServiceInfo(r.company_id, r.id);
      const base = { first_name: r.first_name || "there", service_summary: svc.serviceSummary, service_price: svc.servicePrice };

      // ── notice hold: the agreement itself says what happens today ──────────
      const hold = await getActiveHold(r.company_id, r.id);
      if (hold?.kind === "notice") {
        let out: Awaited<ReturnType<typeof endExpiredNoticeHold>> | null = null;
        try {
          out = await endExpiredNoticeHold(hold);
        } catch (e) {
          // Close-out failed mid-flight. Do NOT fall through to the free-hold
          // message — telling a terminating client "reactivate to keep your
          // rate" is worse than sending nothing. Leave the row unstamped so
          // tomorrow's sweep retries, and put it in front of a person now.
          console.error(`[suspension] notice close-out failed for client ${r.id}:`, e);
          await officeNotice(r.company_id, r.id, `Hold close-out failed — ${r.first_name ?? "client"}`,
            "A notice hold ended but the automatic close-out errored. End the service and bill the notice period by hand.");
          continue;
        }
        const amountStr = `$${out.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        // The template cannot branch, so the sender writes the money sentence.
        const noticeStatus = out.amount <= 0
          ? "There is no balance due."
          : out.chargeOutcome === "paid"
            ? "That amount has been charged to the card we have on file."
            : "That amount is due now, and we will follow up with the invoice.";
        const closeVars = {
          ...base,
          notice_visits: String(out.visits),
          notice_amount: amountStr,
          notice_status: noticeStatus,
        };
        await sendNotification("service_hold_ended_final", "email", r.company_id, r.email, null, { ...closeVars, end_date: fmtHoldDateLong(expiry) }).catch(() => false);
        await sendNotification("service_hold_ended_final", "sms", r.company_id, null, r.phone, { ...closeVars, end_date: fmtHoldDateShort(expiry) }).catch(() => false);
        await logClientComm(r.company_id, r.id, "Service ended (hold used as notice)",
          `Hold ended ${expiry}. Service closed. ${out.visits} notice visit(s), ${amountStr}. Charge: ${out.chargeOutcome ?? "none attempted"}.`);
        // The office always hears about this one — money moved, or tried to.
        const paid = out.chargeOutcome === "paid";
        await officeNotice(r.company_id, r.id,
          paid ? `Service ended, notice billed — ${r.first_name ?? "client"}`
               : `Service ended, notice UNPAID — ${r.first_name ?? "client"}`,
          `A hold that counted as the client's notice ended ${expiry}. Recurring service is closed and ${out.visits} notice visit(s) totalling ${amountStr} were invoiced. ${paid ? "The card on file was charged." : `Payment did not go through (${out.chargeOutcome ?? "no card on file"}). Collect this manually.`}`);
        expiries++;
        continue;
      }

      // ── free hold: unchanged. Flag for office, change nothing, move no money ─
      await sendNotification("suspension_expired", "email", r.company_id, r.email, null, { ...base, end_date: fmtHoldDateLong(expiry) }).catch(() => false);
      await sendNotification("suspension_expired", "sms", r.company_id, null, r.phone, { ...base, end_date: fmtHoldDateShort(expiry) }).catch(() => false);
      await db.execute(sql`UPDATE clients SET suspend_expiry_notice_sent_at = now() WHERE id = ${r.id}`);
      await logClientComm(r.company_id, r.id, "Hold ended", "Hold expired — final notice sent; awaiting office follow-up.");
      // Office heads-up notification (same table cancellation.ts uses).
      await officeNotice(r.company_id, r.id, `Service hold ended — ${r.first_name ?? "client"}`,
        "A service hold has ended. Follow up to resume or close out the account.");
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
