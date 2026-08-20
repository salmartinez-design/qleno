// [service-suspension 2026-07-11] Suspend / resume a client's cleaning service.
// Suspending places the account on a temporary hold (up to 90 days): it cancels
// the client's future not-yet-done jobs, deactivates their recurring schedules,
// stamps the suspension columns, and sends the confirmation email. Resuming
// reverses the schedule pause and clears the hold.
//
// [portal-service-account 2026-08-20] The ACT itself moved to
// lib/service-hold-actions.ts, because the customer portal performs the same act
// from the other side of the glass and two copies would have drifted. What is
// left here is the office ADAPTER: staff authorization, the office's own
// wording, and the office-only override fields. Read that module before
// changing what a hold does; change this file only for what the office sees.
//
// Timed follow-ups (30-days-before-expiry reminder + at-expiry final notice)
// are driven by the daily cron in lib/suspension.ts — not here.

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import {
  classifyHold, resolveHoldPolicy, getActiveHold, setHoldOverride,
  getHoldAllowance, quoteNoticeVisits, isHoldOverrideReason, HOLD_OVERRIDE_REASONS,
} from "../lib/service-hold.js";
import { logAudit } from "../lib/audit.js";
import { placeHold, liftHold, todayYmd, addDays } from "../lib/service-hold-actions.js";

const router = Router();

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
// body: { until?, reason?, notify?, acknowledge_notice?, granted_free_days?, override_reason? }
router.post("/:id/suspend", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId)) { res.status(400).json({ error: "invalid client id" }); return; }

    const result = await placeHold({
      companyId, clientId,
      until: req.body?.until ?? null,
      reason: req.body?.reason ?? null,
      notify: req.body?.notify !== false, // default ON
      // Office override: hand this client extra free days for this hold only,
      // with a reason on the record. Owner/admin/office all reach this route, so
      // the grant is audited rather than gated to a narrower role.
      grantedFreeDays: Number(req.body?.granted_free_days ?? 0) || 0,
      overrideReason: req.body?.override_reason ?? null,
      acknowledgeNotice: req.body?.acknowledge_notice === true,
      actor: { kind: "office", userId: req.auth!.userId as number },
    });

    if (!result.ok) {
      switch (result.refusal) {
        case "client_not_found":
          res.status(404).json({ error: "client not found" }); return;
        case "already_on_hold":
          res.status(409).json({ error: "Client is already suspended" }); return;
        case "date_not_future":
          res.status(400).json({ error: "Resume date must be in the future" }); return;
        case "date_too_far":
          res.status(400).json({ error: `Suspension can't exceed ${result.capDays} days` }); return;
        case "notice_not_acknowledged": {
          const cls = result.classification!;
          const cRes = await db.execute(sql`
            SELECT first_name FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1`);
          const name = (cRes.rows[0] as any)?.first_name ?? "this client";
          res.status(409).json({
            error: "notice_acknowledgement_required",
            message: `This hold is longer than the ${cls.allowance.remaining} free hold day(s) ${name} has left, so it counts as their notice to end service. Confirm to continue.`,
            classification: { ...cls, free_days_used: cls.freeDaysUsed },
          });
          return;
        }
      }
    }

    res.status(200).json({
      ok: true,
      suspend_until: result.until,
      cancelled_jobs: result.cancelledJobs,
      paused_schedules: result.pausedSchedules,
      hold_id: result.holdId,
      kind: result.kind,
      free_days_used: result.freeDaysUsed,
      free_days_remaining: result.freeDaysRemaining,
      notice: result.kind === "notice" ? result.classification.notice : null,
    });
  } catch (e: any) {
    console.error("[suspension] suspend error:", e);
    res.status(500).json({ error: "Failed to suspend service", message: e?.message });
  }
});

// ── POST /api/clients/:id/resume ───────────────────────────────────────────────
router.post("/:id/resume", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId)) { res.status(400).json({ error: "invalid client id" }); return; }

    const result = await liftHold({
      companyId, clientId,
      actor: { kind: "office", userId: req.auth!.userId as number },
    });
    if (!result.ok) {
      if (result.refusal === "client_not_found") { res.status(404).json({ error: "client not found" }); return; }
      res.status(409).json({ error: "Client is not suspended" }); return;
    }

    res.status(200).json({
      ok: true,
      reactivated_schedules: result.reactivatedSchedules,
      allowance: result.allowance,
    });
  } catch (e: any) {
    console.error("[suspension] resume error:", e);
    res.status(500).json({ error: "Failed to resume service", message: e?.message });
  }
});

// ── GET /api/clients/:id/hold ─────────────────────────────────────────────────
// The client's live hold, if any, plus what the office may do to it. The card
// needs this to say "notice charge waived" out loud: an override that is only
// visible in the database is an override nobody trusts, and somebody re-bills
// the customer by hand three weeks later.
router.get("/:id/hold", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId)) { res.status(400).json({ error: "invalid client id" }); return; }

    const hold = await getActiveHold(companyId, clientId);
    const policy = await resolveHoldPolicy(companyId);
    const allowance = await getHoldAllowance(companyId, clientId, todayYmd(), policy);

    // On a notice hold, quote what would come due today if they never resume.
    // A waived hold still reports the number, marked waived — the office should
    // see what was forgiven, not a blank.
    let notice: any = null;
    if (hold && hold.kind === "notice") {
      notice = await quoteNoticeVisits(companyId, clientId, String(hold.end_date), policy.noticeDays);
    }

    res.status(200).json({
      hold, policy, allowance, notice,
      override_reasons: HOLD_OVERRIDE_REASONS,
    });
  } catch (e: any) {
    console.error("[suspension] hold read error:", e);
    res.status(500).json({ error: "Failed to read hold", message: e?.message });
  }
});

// ── POST /api/clients/:id/hold-override ───────────────────────────────────────
// body: { waive_notice_charge?, granted_free_days?, reason_code, reason_note? }
//
// [hold-override 2026-08-20] Waive the end-of-notice bill, or hand this client
// extra free hold days, on the hold they are ON right now. Sal asked for the
// waive "with reason dispositions", so reason_code is required and must be one
// of the fixed list — free text alone would make the forgiveness unanswerable
// later. Audited every time.
//
// This does not end, extend, or resume the hold, and it moves no money by
// itself. A waived notice hold still ends the agreement on its end date; the
// close-out simply raises no invoice when it gets there.
router.post("/:id/hold-override", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId)) { res.status(400).json({ error: "invalid client id" }); return; }

    const reasonCode = req.body?.reason_code;
    if (!isHoldOverrideReason(reasonCode)) {
      res.status(400).json({ error: "A reason is required", reasons: HOLD_OVERRIDE_REASONS });
      return;
    }
    const hasWaive = req.body?.waive_notice_charge !== undefined;
    const hasDays = req.body?.granted_free_days !== undefined;
    if (!hasWaive && !hasDays) {
      res.status(400).json({ error: "Nothing to change" });
      return;
    }

    const before = await getActiveHold(companyId, clientId);

    const result = await setHoldOverride({
      companyId, clientId,
      waiveNoticeCharge: hasWaive ? req.body.waive_notice_charge === true : undefined,
      grantedFreeDays: hasDays ? Number(req.body.granted_free_days) : undefined,
      reasonCode,
      reasonNote: typeof req.body?.reason_note === "string" ? req.body.reason_note.slice(0, 500) : null,
      userId: req.auth!.userId as number,
    });

    if (!result.ok) {
      switch (result.refusal) {
        case "no_active_hold":
          res.status(409).json({ error: "This client is not on hold right now" }); return;
        case "bad_days":
          res.status(400).json({ error: "Extra free days must be a whole number between 0 and 365" }); return;
        case "bad_reason":
          res.status(400).json({ error: "A reason is required", reasons: HOLD_OVERRIDE_REASONS }); return;
      }
    }

    await logAudit(req, "hold_override", "client", clientId,
      before ? {
        waive_notice_charge: before.waive_notice_charge,
        granted_free_days: before.granted_free_days,
        override_reason: before.override_reason,
      } : null,
      {
        hold_id: result.hold?.id ?? null,
        waive_notice_charge: result.hold?.waive_notice_charge,
        granted_free_days: result.hold?.granted_free_days,
        override_reason: result.hold?.override_reason,
      });

    res.status(200).json({ ok: true, hold: result.hold });
  } catch (e: any) {
    console.error("[suspension] hold-override error:", e);
    res.status(500).json({ error: "Failed to save the override", message: e?.message });
  }
});

export default router;
