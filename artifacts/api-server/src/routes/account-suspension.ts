// [suspension-commercial 2026-08-19] Suspend / resume a COMMERCIAL account's
// service. The residential twin is routes/client-suspension.ts; this is the
// same contract on the account carrier — Sal: "we need this for both commercial
// and residential". Everything that differs is structural, not policy:
//
//   - future jobs are found by jobs.account_id, not jobs.client_id;
//   - recurring schedules are paused by recurring_schedules.account_id;
//   - the notice goes to the account's billing/primary contact rather than to a
//     client row, because an account has no email of its own;
//   - the hold event lands in communication_log (account_id), which is what the
//     account Activity tab unions — accounts have no client_communications row.
//
// The 90-day cap, the default end date, the 30-day reminder and the at-expiry
// notice are shared with the residential path (lib/suspension.ts) so a hold
// means the same thing on both sides of the book.

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import {
  MAX_SUSPEND_DAYS,
  resolveAccountServiceInfo,
  resolveAccountRecipient,
  fmtHoldDateLong,
  fmtHoldDateShort,
} from "../lib/suspension.js";
import { sendNotification } from "../services/notificationService.js";
import { buildSuspensionEmailRenderer } from "../lib/suspension-email.js";

const router = Router();

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Log a hold event onto the account's Activity feed.
async function logAccountComm(companyId: number, accountId: number, subject: string, summary: string, direction: "outbound" | "internal"): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO communication_log
        (company_id, account_id, direction, channel, summary, subject, source, sent_by, logged_at)
      VALUES
        (${companyId}, ${accountId}, ${direction}::comm_direction, 'email', ${summary}, ${subject}, 'system', 'System', now())
    `);
  } catch (e) { console.warn("[suspension] account comm-log non-fatal:", e); }
}

// ── POST /api/accounts/:id/suspend ────────────────────────────────────────────
// body: { until?: "YYYY-MM-DD", reason?: string, notify?: boolean }
router.post("/:id/suspend", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const userId = req.auth!.userId as number;
    const accountId = Number(req.params.id);
    if (!Number.isInteger(accountId)) { res.status(400).json({ error: "invalid account id" }); return; }

    const today = todayYmd();
    const maxDate = addDays(today, MAX_SUSPEND_DAYS);
    let until = typeof req.body?.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.until)
      ? req.body.until
      : maxDate;
    if (until <= today) { res.status(400).json({ error: "Resume date must be in the future" }); return; }
    if (until > maxDate) { res.status(400).json({ error: `Suspension can't exceed ${MAX_SUSPEND_DAYS} days` }); return; }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : null;
    const notify = req.body?.notify !== false; // default ON

    const aRes = await db.execute(sql`
      SELECT id, account_name, suspended_at
        FROM accounts WHERE id = ${accountId} AND company_id = ${companyId} LIMIT 1
    `);
    const account: any = aRes.rows[0];
    if (!account) { res.status(404).json({ error: "account not found" }); return; }
    if (account.suspended_at) { res.status(409).json({ error: "Account is already suspended" }); return; }

    let cancelledJobs = 0;
    let pausedSchedules = 0;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE accounts
           SET suspended_at = now(),
               suspend_until = ${until}::date,
               suspend_reason = ${reason},
               suspended_by_user_id = ${userId},
               suspend_resume_reminder_sent_at = NULL,
               suspend_expiry_notice_sent_at = NULL
         WHERE id = ${accountId} AND company_id = ${companyId}
      `);

      // Cancel the account's future not-yet-done visits across every property.
      const cancelled = await tx.execute(sql`
        UPDATE jobs
           SET status = 'cancelled'::job_status,
               notes = COALESCE(notes, '') ||
                       (CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END) ||
                       '[service_suspended until ' || ${until} || ']'
         WHERE account_id = ${accountId}
           AND company_id = ${companyId}
           AND status::text IN ('scheduled','in_progress')
           AND COALESCE(occurrence_date, scheduled_date) >= ${today}::date
        RETURNING id
      `);
      cancelledJobs = (cancelled.rows as any[]).length;

      const paused = await tx.execute(sql`
        UPDATE recurring_schedules
           SET is_active = false, paused_by_suspension = true
         WHERE account_id = ${accountId}
           AND company_id = ${companyId}
           AND is_active = true
        RETURNING id
      `);
      pausedSchedules = (paused.rows as any[]).length;
    });

    if (notify) {
      (async () => {
        try {
          const svc = await resolveAccountServiceInfo(companyId, accountId);
          const who = await resolveAccountRecipient(companyId, accountId);
          const base = { first_name: who.contactName, service_summary: svc.serviceSummary, service_price: svc.servicePrice };
          const emailVars = { ...base, start_date: fmtHoldDateLong(today), end_date: fmtHoldDateLong(until) };
          const smsVars = { ...base, start_date: fmtHoldDateShort(today), end_date: fmtHoldDateShort(until) };
          const renderHold = await buildSuspensionEmailRenderer(companyId, "suspended");
          const emailSent = await sendNotification("service_suspended", "email", companyId, who.email, null, emailVars, false, renderHold).catch(() => false);
          const smsSent = await sendNotification("service_suspended", "sms", companyId, null, who.phone, smsVars).catch(() => false);
          await logAccountComm(
            companyId, accountId, "Service suspended",
            (emailSent || smsSent)
              ? `Suspension confirmation sent to ${who.email || who.phone || "the account contact"}.`
              : "Suspension recorded (no reachable contact, or message suppressed by comms settings / opt-out).",
            "outbound",
          );
        } catch (e) { console.error("[suspension] account suspend notify failed:", e); }
      })();
    } else {
      await logAccountComm(companyId, accountId, "Service suspended", "Suspension recorded; notification skipped by the office.", "internal");
    }

    res.status(200).json({ ok: true, suspend_until: until, cancelled_jobs: cancelledJobs, paused_schedules: pausedSchedules });
  } catch (e: any) {
    console.error("[suspension] account suspend error:", e);
    res.status(500).json({ error: "Failed to suspend service", message: e?.message });
  }
});

// ── POST /api/accounts/:id/resume ─────────────────────────────────────────────
router.post("/:id/resume", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const accountId = Number(req.params.id);
    if (!Number.isInteger(accountId)) { res.status(400).json({ error: "invalid account id" }); return; }

    const aRes = await db.execute(sql`
      SELECT id, suspended_at FROM accounts WHERE id = ${accountId} AND company_id = ${companyId} LIMIT 1
    `);
    const account: any = aRes.rows[0];
    if (!account) { res.status(404).json({ error: "account not found" }); return; }
    if (!account.suspended_at) { res.status(409).json({ error: "Account is not suspended" }); return; }

    let reactivated = 0;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE accounts
           SET suspended_at = NULL,
               suspend_until = NULL,
               suspend_reason = NULL,
               suspended_by_user_id = NULL,
               suspend_resume_reminder_sent_at = NULL,
               suspend_expiry_notice_sent_at = NULL
         WHERE id = ${accountId} AND company_id = ${companyId}
      `);
      // Only revive what THIS hold paused — never a schedule the office had
      // already ended before the account went on hold.
      const re = await tx.execute(sql`
        UPDATE recurring_schedules
           SET is_active = true, paused_by_suspension = false
         WHERE account_id = ${accountId}
           AND company_id = ${companyId}
           AND paused_by_suspension = true
        RETURNING id
      `);
      reactivated = (re.rows as any[]).length;
    });

    await logAccountComm(
      companyId, accountId, "Service resumed",
      `Service hold lifted; ${reactivated} recurring schedule(s) re-activated.`,
      "internal",
    );

    res.status(200).json({ ok: true, reactivated_schedules: reactivated });
  } catch (e: any) {
    console.error("[suspension] account resume error:", e);
    res.status(500).json({ error: "Failed to resume service", message: e?.message });
  }
});

export default router;
