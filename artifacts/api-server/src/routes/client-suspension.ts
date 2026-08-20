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
import {
  classifyHold, openHold, closeHoldOnResume, getHoldAllowance, resolveHoldPolicy,
} from "../lib/service-hold.js";

const router = Router();

// Today's calendar date as YYYY-MM-DD (UTC is fine — we only compare dates).
function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}
function money(n: number): string {
  return `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ── GET /api/clients/:id/hold-preview?until=YYYY-MM-DD ────────────────────────
// What this hold would be BEFORE anything is saved: free or notice, how many
// free days are left in the client's rolling year, and — if it is notice — the
// exact visits and dollars that come due should they never resume.
//
// This exists so the office is never the last to know. A 90-day hold on a client
// with 4 free days left is a termination with a four-figure bill attached, and
// the person clicking the button has to see that number first.
router.get("/:id/hold-preview", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId)) { res.status(400).json({ error: "invalid client id" }); return; }

    const today = todayYmd();
    const policy = await resolveHoldPolicy(companyId);
    const until = typeof req.query.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.until)
      ? req.query.until
      : addDays(today, policy.maxDays);
    if (until <= today) { res.status(400).json({ error: "Resume date must be in the future" }); return; }

    const cRes = await db.execute(sql`
      SELECT id FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1
    `);
    if (!cRes.rows[0]) { res.status(404).json({ error: "client not found" }); return; }

    const cls = await classifyHold(companyId, clientId, today, until);
    res.status(200).json(cls);
  } catch (e: any) {
    console.error("[suspension] hold-preview error:", e);
    res.status(500).json({ error: "Failed to preview hold", message: e?.message });
  }
});

// ── POST /api/clients/:id/suspend ──────────────────────────────────────────────
// body: { until?: "YYYY-MM-DD", reason?: string, notify?: boolean }
router.post("/:id/suspend", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const userId = req.auth!.userId as number;
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId)) { res.status(400).json({ error: "invalid client id" }); return; }

    const today = todayYmd();
    // The cap is the tenant's own agr_hold_max_days, not the hardcoded 90 — the
    // agreement prints that number, so the button has to honour the same one.
    // MAX_SUSPEND_DAYS stays the ceiling on the ceiling.
    const policy = await resolveHoldPolicy(companyId);
    const capDays = Math.min(policy.maxDays || MAX_SUSPEND_DAYS, MAX_SUSPEND_DAYS);
    const maxDate = addDays(today, capDays);
    // Default the hold to the full allowed window; the office may pass a shorter date.
    let until = typeof req.body?.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.until)
      ? req.body.until
      : maxDate;
    if (until <= today) { res.status(400).json({ error: "Resume date must be in the future" }); return; }
    if (until > maxDate) { res.status(400).json({ error: `Suspension can't exceed ${capDays} days` }); return; }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : null;
    const notify = req.body?.notify !== false; // default ON
    // Office override: hand this client extra free days for this hold only, with
    // a reason on the record. Owner/admin/office all reach this route, so the
    // grant is audited rather than gated to a narrower role.
    const grantedFreeDays = Math.max(0, Math.min(365, Number(req.body?.granted_free_days ?? 0) || 0));
    const overrideReason = typeof req.body?.override_reason === "string"
      ? req.body.override_reason.trim().slice(0, 500) : null;

    // Load + guard the client (tenant-scoped) before mutating anything.
    const cRes = await db.execute(sql`
      SELECT id, first_name, email, phone, suspended_at
        FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1
    `);
    const client: any = cRes.rows[0];
    if (!client) { res.status(404).json({ error: "client not found" }); return; }
    if (client.suspended_at) { res.status(409).json({ error: "Client is already suspended" }); return; }

    // Free or notice? Decided here, before a single row moves, so the answer we
    // store and the answer we showed the office are the same answer.
    //
    // The grant is applied by writing it onto this hold's ledger row, which
    // raises the ceiling for the allowance sum; classify against the raised
    // ceiling by adding it to the remaining days for this decision only.
    const cls = await classifyHold(companyId, clientId, today, until);
    const remainingWithGrant = cls.allowance.remaining + grantedFreeDays;
    const isFree = cls.days <= remainingWithGrant;
    const kind = isFree ? "free" : "notice";
    const freeDaysUsed = isFree ? cls.days : 0;

    // A notice hold ends the agreement and bills the notice period. Refuse to do
    // that silently: the caller must send acknowledge_notice after seeing the
    // preview. An older client of this API gets a 409 with the whole quote in the
    // body rather than an accidental termination.
    if (!isFree && req.body?.acknowledge_notice !== true) {
      res.status(409).json({
        error: "notice_acknowledgement_required",
        message: `This hold is longer than the ${cls.allowance.remaining} free hold day(s) ${client.first_name ?? "this client"} has left, so it counts as their notice to end service. Confirm to continue.`,
        classification: { ...cls, kind, free_days_used: freeDaysUsed },
      });
      return;
    }

    let cancelledJobs = 0;
    let holdId: number | null = null;
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

      // The ledger row IS the allowance. Without it the next hold has no idea
      // this one happened, and the chaining loophole reopens.
      holdId = await openHold(tx, {
        companyId, clientId,
        startDate: today, endDate: until,
        days: cls.days, kind, freeDaysUsed,
        grantedFreeDays, reason, userId, overrideReason,
      });
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
          const base: Record<string, string> = { first_name: String(client.first_name || "there"), service_summary: svc.serviceSummary, service_price: svc.servicePrice };
          // A notice hold gets its OWN template. The standard hold email says
          // "you keep your regular spot, resume any time" and never mentions
          // that this hold ends the agreement or what it costs. Sending that to
          // someone who has effectively just given notice would be the app
          // lying to a customer about a bill it is going to charge them.
          const isNotice = kind === "notice";
          const trig = isNotice ? "service_hold_notice_started" : "service_suspended";
          const noticeVars: Record<string, string> = isNotice && cls.notice
            ? { notice_visits: String(cls.notice.visits), notice_amount: money(cls.notice.amount) }
            : {};
          const emailVars = { ...base, ...noticeVars, start_date: fmtHoldDateLong(today), end_date: fmtHoldDateLong(until) };
          const smsVars = { ...base, ...noticeVars, start_date: fmtHoldDateShort(today), end_date: fmtHoldDateShort(until) };
          const emailSent = await sendNotification(trig, "email", companyId, client.email, null, emailVars).catch(() => false);
          const smsSent = await sendNotification(trig, "sms", companyId, null, client.phone, smsVars).catch(() => false);
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

    res.status(200).json({
      ok: true,
      suspend_until: until,
      cancelled_jobs: cancelledJobs,
      paused_schedules: pausedSchedules,
      hold_id: holdId,
      kind,
      free_days_used: freeDaysUsed,
      free_days_remaining: Math.max(0, remainingWithGrant - freeDaysUsed),
      notice: kind === "notice" ? cls.notice : null,
    });
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

    // Resuming before the end date is the customer changing their mind, and the
    // agreement is explicit that nothing is charged for it — including when the
    // hold was classified as notice. Close the ledger row 'resumed'; the free
    // days it consumed stay spent, which is correct: they had the pause.
    await closeHoldOnResume(companyId, clientId);

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

    const allowance = await getHoldAllowance(companyId, clientId, todayYmd());
    res.status(200).json({ ok: true, reactivated_schedules: reactivated, allowance });
  } catch (e: any) {
    console.error("[suspension] resume error:", e);
    res.status(500).json({ error: "Failed to resume service", message: e?.message });
  }
});

export default router;
