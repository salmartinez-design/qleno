// [service-suspension 2026-07-11] Suspend / resume a client's cleaning service.
// Suspending places the account on a temporary hold (up to 90 days): it cancels
// the client's future not-yet-done jobs, deactivates their recurring schedules,
// stamps the suspension columns, and sends the confirmation email. Resuming
// reverses the schedule pause and clears the hold. Mirrors the transaction +
// fire-and-forget notify shape of routes/cancellation.ts.
//
// Timed follow-ups (30-days-before-expiry reminder + at-expiry final notice)
// are driven by the daily cron in lib/suspension.ts — not here.

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { MAX_SUSPEND_DAYS, resolveServiceInfo, fmtHoldDateLong, fmtHoldDateShort } from "../lib/suspension.js";
import { sendNotification } from "../services/notificationService.js";

const router = Router();

// Today's calendar date as YYYY-MM-DD (UTC is fine — we only compare dates).
function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ── POST /api/clients/:id/suspend ──────────────────────────────────────────────
// body: { until?: "YYYY-MM-DD", reason?: string, notify?: boolean }
router.post("/:id/suspend", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const userId = req.auth!.userId as number;
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId)) { res.status(400).json({ error: "invalid client id" }); return; }

    const today = todayYmd();
    const maxDate = addDays(today, MAX_SUSPEND_DAYS);
    // Default the hold to the full 90 days; the office may pass a shorter date.
    let until = typeof req.body?.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.until)
      ? req.body.until
      : maxDate;
    if (until <= today) { res.status(400).json({ error: "Resume date must be in the future" }); return; }
    if (until > maxDate) { res.status(400).json({ error: `Suspension can't exceed ${MAX_SUSPEND_DAYS} days` }); return; }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : null;
    const notify = req.body?.notify !== false; // default ON

    // Load + guard the client (tenant-scoped) before mutating anything.
    const cRes = await db.execute(sql`
      SELECT id, first_name, email, phone, suspended_at
        FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1
    `);
    const client: any = cRes.rows[0];
    if (!client) { res.status(404).json({ error: "client not found" }); return; }
    if (client.suspended_at) { res.status(409).json({ error: "Client is already suspended" }); return; }

    let cancelledJobs = 0;
    let pausedSchedules = 0;
    await db.transaction(async (tx) => {
      // Stamp the hold on the client.
      await tx.execute(sql`
        UPDATE clients
           SET suspended_at = now(),
               suspend_until = ${until}::date,
               suspend_reason = ${reason},
               suspended_by_user_id = ${userId},
               suspend_resume_reminder_sent_at = NULL,
               suspend_expiry_notice_sent_at = NULL
         WHERE id = ${clientId} AND company_id = ${companyId}
      `);

      // Cancel this client's FUTURE not-yet-done jobs (from today forward),
      // anchored on the same COALESCE(occurrence_date, scheduled_date) key the
      // recurrence engine dedups on — never touch past/completed history.
      const cancelled = await tx.execute(sql`
        UPDATE jobs
           SET status = 'cancelled'::job_status,
               notes = COALESCE(notes, '') ||
                       (CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END) ||
                       '[service_suspended until ' || ${until} || ']'
         WHERE client_id = ${clientId}
           AND company_id = ${companyId}
           AND status::text IN ('scheduled','in_progress')
           AND COALESCE(occurrence_date, scheduled_date) >= ${today}::date
        RETURNING id
      `);
      cancelledJobs = (cancelled.rows as any[]).length;

      // Pause this client's active recurring schedules — mark them so resume
      // only re-activates the ones the suspension paused (not office-cancelled).
      const paused = await tx.execute(sql`
        UPDATE recurring_schedules
           SET is_active = false, paused_by_suspension = true
         WHERE customer_id = ${clientId}
           AND company_id = ${companyId}
           AND is_active = true
        RETURNING id
      `);
      pausedSchedules = (paused.rows as any[]).length;
    });

    // Fire-and-forget confirmation — after commit so a notify failure never
    // rolls back the suspension. Routes through the standard sendNotification
    // pipeline (editable "service_suspended" template, house chrome, COMMS_
    // ENABLED gate, email/SMS opt-out, per-tenant sender, comm log). prefClientId
    // is intentionally omitted so the per-client preference gate never runs.
    // reason is stored internally (clients.suspend_reason) but never sent.
    if (notify) {
      (async () => {
        try {
          const svc = await resolveServiceInfo(companyId, clientId);
          const base = { first_name: client.first_name || "there", service_summary: svc.serviceSummary, service_price: svc.servicePrice };
          const emailVars = { ...base, start_date: fmtHoldDateLong(today), end_date: fmtHoldDateLong(until) };
          const smsVars = { ...base, start_date: fmtHoldDateShort(today), end_date: fmtHoldDateShort(until) };
          const emailSent = await sendNotification("service_suspended", "email", companyId, client.email, null, emailVars).catch(() => false);
          const smsSent = await sendNotification("service_suspended", "sms", companyId, null, client.phone, smsVars).catch(() => false);
          // Mirror onto the client's Comm Log tab (client_communications is
          // separate from notification_log, which sendNotification already writes).
          await db.execute(sql`
            INSERT INTO client_communications
              (company_id, client_id, type, direction, subject, body, from_name, created_at)
            VALUES
              (${companyId}, ${clientId}, 'suspension', 'outbound', 'Service suspended',
               ${(emailSent || smsSent) ? "Suspension confirmation sent." : "Suspension recorded (message suppressed by comms settings / opt-out)."},
               'System', now())
          `);
        } catch (e) { console.error("[suspension] suspend notify failed:", e); }
      })();
    }

    res.status(200).json({ ok: true, suspend_until: until, cancelled_jobs: cancelledJobs, paused_schedules: pausedSchedules });
  } catch (e: any) {
    console.error("[suspension] suspend error:", e);
    res.status(500).json({ error: "Failed to suspend service", message: e?.message });
  }
});

// ── POST /api/clients/:id/resume ───────────────────────────────────────────────
// body: { notify?: boolean }
router.post("/:id/resume", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId)) { res.status(400).json({ error: "invalid client id" }); return; }

    const cRes = await db.execute(sql`
      SELECT id, suspended_at FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1
    `);
    const client: any = cRes.rows[0];
    if (!client) { res.status(404).json({ error: "client not found" }); return; }
    if (!client.suspended_at) { res.status(409).json({ error: "Client is not suspended" }); return; }

    let reactivated = 0;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE clients
           SET suspended_at = NULL,
               suspend_until = NULL,
               suspend_reason = NULL,
               suspended_by_user_id = NULL,
               suspend_resume_reminder_sent_at = NULL,
               suspend_expiry_notice_sent_at = NULL
         WHERE id = ${clientId} AND company_id = ${companyId}
      `);
      // Re-activate ONLY the schedules this suspension paused — never revive a
      // schedule the office had already cancelled before the hold.
      const re = await tx.execute(sql`
        UPDATE recurring_schedules
           SET is_active = true, paused_by_suspension = false
         WHERE customer_id = ${clientId}
           AND company_id = ${companyId}
           AND paused_by_suspension = true
        RETURNING id
      `);
      reactivated = (re.rows as any[]).length;
    });

    // Log the resume onto the comm log. (Individual cancelled jobs are not
    // un-cancelled — the recurring engine regenerates forward occurrences for
    // the re-activated schedules on its next run.)
    try {
      await db.execute(sql`
        INSERT INTO client_communications
          (company_id, client_id, type, direction, subject, body, from_name, created_at)
        VALUES
          (${companyId}, ${clientId}, 'suspension', 'internal', 'Service resumed',
           ${`Service hold lifted; ${reactivated} recurring schedule(s) re-activated.`}, 'System', now())
      `);
    } catch (e) { console.warn("[suspension] resume comm-log non-fatal:", e); }

    res.status(200).json({ ok: true, reactivated_schedules: reactivated });
  } catch (e: any) {
    console.error("[suspension] resume error:", e);
    res.status(500).json({ error: "Failed to resume service", message: e?.message });
  }
});

export default router;
