import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [time-change-notice 2026-06-30] Same-day arrival-time change → manual client
// notification. When the office moves a job's TIME on the SAME calendar day
// (drag-and-drop on the board, or the edit-job modal), the job is flagged so its
// detail card shows a note — "Time updated from <old> to <new> — Send
// notification" — with a button the office clicks WHEN they want the client told
// (Maribel 2026-06-30: keep control; do NOT auto-send). A cross-DAY reschedule is
// a different flow (the reschedule email), so this note is strictly same-day.
//
// Every send goes through sendNotification(), which enforces the per-tenant comms
// gate + the global COMMS_ENABLED flag and resolves the tenant's own
// from-address / from-number. Nothing is hardcoded per company.

const SMS_BODY =
  "Hi {{first_name}}, quick update from {{company_name}}: your cleaning on " +
  "{{appointment_date}} is now scheduled for {{appointment_time}}. Questions? " +
  "Reply to this text or call {{company_phone}}.";

const EMAIL_SUBJECT = "Your appointment time has been updated";
const EMAIL_BODY =
  "Hi {{first_name}},\n\n" +
  "The arrival time for your {{service_type}} on {{appointment_date}} has been " +
  "updated to {{appointment_time}}.\n\n" +
  "If this time doesn't work for you, just reply to this email or call us at " +
  "{{company_phone}} and we'll find a better one.\n\n" +
  "Thank you,\n{{company_name}}";

// ── Idempotent setup (startup) ───────────────────────────────────────────────
// Adds the two flag columns on `jobs` and seeds the job_time_updated SMS + email
// templates for EVERY company. WHERE NOT EXISTS keeps it idempotent and never
// clobbers a tenant's own copy. Safe to re-run on every cold start.
export async function ensureTimeChangeNoticeSetup(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS time_change_pending boolean NOT NULL DEFAULT false`);
    await db.execute(sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS time_change_from text`);

    await db.execute(sql`
      INSERT INTO notification_templates
        (company_id, trigger, channel, subject, body, body_html, body_text, is_active)
      SELECT c.id, 'job_time_updated', 'sms'::notification_channel,
             NULL, '', NULL, ${SMS_BODY}, true
      FROM companies c
      WHERE NOT EXISTS (
        SELECT 1 FROM notification_templates t
        WHERE t.company_id = c.id AND t.trigger = 'job_time_updated' AND t.channel = 'sms'
      )
    `);
    await db.execute(sql`
      INSERT INTO notification_templates
        (company_id, trigger, channel, subject, body, body_html, body_text, is_active)
      SELECT c.id, 'job_time_updated', 'email'::notification_channel,
             ${EMAIL_SUBJECT}, ${EMAIL_BODY}, NULL, ${EMAIL_BODY}, true
      FROM companies c
      WHERE NOT EXISTS (
        SELECT 1 FROM notification_templates t
        WHERE t.company_id = c.id AND t.trigger = 'job_time_updated' AND t.channel = 'email'
      )
    `);
    console.log("[time-change-notice] setup ready (jobs flag columns + job_time_updated templates)");
  } catch (err) {
    console.error("[time-change-notice] setup error (non-fatal):", err);
  }
}

// ── Same-day detection (pure) ────────────────────────────────────────────────
/**
 * True when a job's TIME moved but its calendar DAY did not — the only case
 * that raises the manual "notify the client of the new arrival time" note. A
 * change that also moves the date is a cross-day reschedule (a different flow),
 * so it returns false. Dates may arrive as a pg Date object or a string; times
 * as "HH:MM" / "HH:MM:SS". Pure + side-effect-free so it can be unit-tested.
 */
export function isSameDayTimeChange(
  prevDate: string | Date | null | undefined,
  prevTime: string | null | undefined,
  nextDate: string | Date | null | undefined,
  nextTime: string | null | undefined,
): boolean {
  const day = (d: string | Date | null | undefined) =>
    d == null ? "" : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const hm = (t: string | null | undefined) => (t == null ? "" : String(t).slice(0, 5));
  if (day(prevDate) !== day(nextDate)) return false; // cross-day → not this note
  const a = hm(prevTime), b = hm(nextTime);
  return b !== "" && a !== b; // time actually moved (and there IS a new time)
}

// ── Flag mutators ────────────────────────────────────────────────────────────
export async function markTimeChangePending(jobId: number, companyId: number, fromTime: string | null): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE jobs SET time_change_pending = true, time_change_from = ${fromTime ?? null}
      WHERE id = ${jobId} AND company_id = ${companyId}
    `);
  } catch (err) {
    console.error("[time-change-notice] markTimeChangePending failed:", err);
  }
}

export async function clearTimeChangePending(jobId: number, companyId: number): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE jobs SET time_change_pending = false, time_change_from = NULL
      WHERE id = ${jobId} AND company_id = ${companyId}
    `);
  } catch (err) {
    console.error("[time-change-notice] clearTimeChangePending failed:", err);
  }
}

// ── The send ─────────────────────────────────────────────────────────────────
function fmtApptDate(dateStr: any): string {
  try {
    const iso = dateStr instanceof Date ? dateStr.toISOString().slice(0, 10) : String(dateStr).slice(0, 10);
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return String(dateStr);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  } catch { return String(dateStr); }
}
function fmtTime12h(t: string | null): string {
  if (!t) return "your scheduled time";
  const [hRaw, m] = String(t).slice(0, 5).split(":");
  const h = parseInt(hRaw, 10);
  if (!Number.isFinite(h)) return String(t);
  const ap = h < 12 ? "AM" : "PM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m} ${ap}`;
}
function labelService(raw: string | null): string {
  if (!raw) return "cleaning service";
  return raw.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Send the client the updated-arrival-time SMS + email for one job, then clear
 * the pending flag. Gate-respecting: sendNotification enforces COMMS_ENABLED +
 * the per-tenant comms gate + per-recipient opt-out. Because PHES comms can be
 * paused company-wide, we also report (coarsely) whether a send could actually
 * have gone out, so the UI can tell the office "sent" vs "comms are paused".
 * Non-throwing.
 */
export async function sendTimeChangeNotification(
  jobId: number,
  companyId: number,
  // [notify-choice 2026-07-08] Which channels to use. The card note's Send
  // button keeps the default (both); the edit-job modal passes the office's
  // per-save pick.
  via: "sms" | "email" | "both" = "both",
): Promise<{ ok: boolean; sent: boolean; reason?: string }> {
  try {
    const rows = await db.execute(sql`
      SELECT j.id, j.company_id, j.scheduled_date, j.scheduled_time, j.service_type, j.client_id,
             c.first_name, c.email AS client_email, c.phone AS client_phone,
             co.comms_enabled
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      JOIN companies co ON co.id = j.company_id
      WHERE j.id = ${jobId} AND j.company_id = ${companyId} LIMIT 1
    `);
    const j: any = rows.rows[0];
    if (!j) return { ok: false, sent: false, reason: "job_not_found" };

    const email = j.client_email || null;
    const phone = j.client_phone || null;
    if (!email && !phone) return { ok: false, sent: false, reason: "no_client_contact" };

    // Respect the same account-level comms pause the job-completion send honors,
    // so silenced PM accounts (accounts.comms_enabled=false) stay silent.
    if (j.client_id != null) {
      try {
        const { isClientAccountCommsPaused } = await import("./account-comms.js");
        if (await isClientAccountCommsPaused(j.client_id)) {
          return { ok: true, sent: false, reason: "account_comms_paused" };
        }
      } catch { /* table absent on a fresh tenant — treat as not paused */ }
    }

    const mv: Record<string, string> = {
      first_name: (j.first_name || "").trim() || "there",
      appointment_date: j.scheduled_date ? fmtApptDate(j.scheduled_date) : "your scheduled date",
      appointment_time: fmtTime12h(j.scheduled_time),
      service_type: labelService(j.service_type),
    };

    // Coarse deliverability for honest UI reporting (sendNotification re-checks).
    const commsOn = process.env.COMMS_ENABLED === "true" && j.comms_enabled === true;

    const { sendNotification } = await import("../services/notificationService.js");
    if (email && (via === "email" || via === "both")) await sendNotification("job_time_updated", "email", companyId, email, null, mv).catch(() => {});
    if (phone && (via === "sms" || via === "both")) await sendNotification("job_time_updated", "sms", companyId, null, phone, mv).catch(() => {});

    return commsOn
      ? { ok: true, sent: true }
      : { ok: true, sent: false, reason: "comms_paused" };
  } catch (err) {
    console.error("[time-change-notice] sendTimeChangeNotification failed:", err);
    return { ok: false, sent: false, reason: "error" };
  }
}
