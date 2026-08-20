// [portal-service-account 2026-08-20] Placing and lifting a service hold, in ONE
// place, callable from either side of the glass.
//
// Why this file exists: the office route (routes/client-suspension.ts) had the
// whole act inline — classify, stamp the client, cancel the future jobs, pause
// the schedules, open the ledger row, notify. The customer portal needs to
// perform exactly the same act. Copying it would have produced two ideas of what
// a hold is, and they would have drifted the first time either one was touched.
// A hold placed by a customer and a hold placed by the office must be the same
// row, consume the same allowance, and cancel the same work.
//
// The ONLY thing that differs by caller is who is recorded as having done it,
// and that is the `actor` argument. Everything else is shared on purpose.
//
// This module returns a RESULT, not an HTTP response. The refusals here are
// business refusals ("already on hold", "that date is in the past"); each route
// maps them onto its own status codes and its own wording, because the office
// and the customer should not read the same sentence.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  MAX_SUSPEND_DAYS, resolveServiceInfo, fmtHoldDateLong, fmtHoldDateShort,
} from "./suspension.js";
import { sendNotification } from "../services/notificationService.js";
import {
  classifyHold, openHold, closeHoldOnResume, getHoldAllowance, resolveHoldPolicy,
  type HoldClassification, type HoldAllowance, type HoldKind,
} from "./service-hold.js";

/**
 * Who is placing the hold. The office acts as a staff user; the customer acts as
 * themselves through the portal. `created_by_user_id` on the ledger only accepts
 * a staff id, so a customer hold records NULL there and names itself in the
 * reason line instead — which is honest, rather than attributing a customer's
 * decision to whichever staff member happened to be logged in.
 */
export type HoldActor =
  | { kind: "office"; userId: number }
  | { kind: "customer"; portalUserId: number; name?: string | null };

export type PlaceHoldRefusal =
  | "client_not_found"
  | "already_on_hold"
  | "date_not_future"
  | "date_too_far"
  | "notice_not_acknowledged";

export type PlaceHoldResult =
  | {
      ok: true;
      until: string;
      kind: HoldKind;
      holdId: number | null;
      cancelledJobs: number;
      pausedSchedules: number;
      freeDaysUsed: number;
      freeDaysRemaining: number;
      classification: HoldClassification;
    }
  | { ok: false; refusal: PlaceHoldRefusal; capDays?: number; classification?: HoldClassification };

export type LiftHoldResult =
  | { ok: true; reactivatedSchedules: number; allowance: HoldAllowance }
  | { ok: false; refusal: "client_not_found" | "not_on_hold" };

export function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function money(n: number): string {
  return `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The longest hold this tenant allows, already floored by the hard ceiling. */
export async function holdCapDays(companyId: number): Promise<number> {
  const policy = await resolveHoldPolicy(companyId);
  return Math.min(policy.maxDays || MAX_SUSPEND_DAYS, MAX_SUSPEND_DAYS);
}

/**
 * Place a hold on a client's service.
 *
 * Order matters and is deliberate: classify BEFORE anything moves, so the answer
 * stored is the answer the caller was shown; mutate inside one transaction, so a
 * half-suspended client is impossible; notify only AFTER commit, so a mail
 * failure can never roll back the hold itself.
 */
export async function placeHold(opts: {
  companyId: number;
  clientId: number;
  /** YYYY-MM-DD. Defaults to the tenant's full allowed window. */
  until?: string | null;
  reason?: string | null;
  notify?: boolean;
  /** Extra free days granted for this hold only. Office path only. */
  grantedFreeDays?: number;
  overrideReason?: string | null;
  /** Must be true to place a hold that ends the agreement and bills the notice. */
  acknowledgeNotice?: boolean;
  actor: HoldActor;
}): Promise<PlaceHoldResult> {
  const { companyId, clientId } = opts;
  const today = todayYmd();
  const capDays = await holdCapDays(companyId);
  const maxDate = addDays(today, capDays);

  const until = typeof opts.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(opts.until)
    ? opts.until
    : maxDate;
  if (until <= today) return { ok: false, refusal: "date_not_future" };
  if (until > maxDate) return { ok: false, refusal: "date_too_far", capDays };

  const reason = typeof opts.reason === "string" ? opts.reason.trim().slice(0, 500) : null;
  const grantedFreeDays = Math.max(0, Math.min(365, Number(opts.grantedFreeDays ?? 0) || 0));
  const overrideReason = typeof opts.overrideReason === "string"
    ? opts.overrideReason.trim().slice(0, 500) : null;
  const userId = opts.actor.kind === "office" ? opts.actor.userId : null;

  const cRes = await db.execute(sql`
    SELECT id, first_name, email, phone, suspended_at
      FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1
  `);
  const client: any = cRes.rows[0];
  if (!client) return { ok: false, refusal: "client_not_found" };
  if (client.suspended_at) return { ok: false, refusal: "already_on_hold" };

  const cls = await classifyHold(companyId, clientId, today, until);
  const remainingWithGrant = cls.allowance.remaining + grantedFreeDays;
  const isFree = cls.days <= remainingWithGrant;
  const kind: HoldKind = isFree ? "free" : "notice";
  const freeDaysUsed = isFree ? cls.days : 0;

  // A notice hold ends the agreement and bills the notice period. Never do that
  // on an unacknowledged call: hand the whole quote back so the caller can show
  // it and ask again.
  if (!isFree && opts.acknowledgeNotice !== true) {
    return {
      ok: false,
      refusal: "notice_not_acknowledged",
      classification: { ...cls, kind, freeDaysUsed },
    };
  }

  let cancelledJobs = 0;
  let pausedSchedules = 0;
  let holdId: number | null = null;

  await db.transaction(async (tx) => {
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

    // Future not-yet-done work only, keyed on the same COALESCE the recurrence
    // engine dedups on. History is never touched.
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

    // Mark what WE paused, so a resume never revives a schedule the office had
    // already cancelled before the hold.
    const paused = await tx.execute(sql`
      UPDATE recurring_schedules
         SET is_active = false, paused_by_suspension = true
       WHERE customer_id = ${clientId}
         AND company_id = ${companyId}
         AND is_active = true
      RETURNING id
    `);
    pausedSchedules = (paused.rows as any[]).length;

    // The ledger row IS the allowance. Without it the next hold has no idea this
    // one happened and the chaining loophole reopens.
    holdId = await openHold(tx, {
      companyId, clientId,
      startDate: today, endDate: until,
      days: cls.days, kind, freeDaysUsed,
      grantedFreeDays,
      reason: opts.actor.kind === "customer"
        ? [reason, "Placed by the customer in their online account."].filter(Boolean).join(" ")
        : reason,
      userId, overrideReason,
    });
  });

  if (opts.notify !== false) {
    void notifyHoldPlaced({
      companyId, clientId, client, kind, today, until, classification: cls,
    });
  }

  return {
    ok: true,
    until, kind, holdId, cancelledJobs, pausedSchedules, freeDaysUsed,
    freeDaysRemaining: Math.max(0, remainingWithGrant - freeDaysUsed),
    classification: { ...cls, kind, freeDaysUsed },
  };
}

/**
 * Fire-and-forget confirmation. Separate from the act so no notify failure can
 * ever reach the transaction. A notice hold gets its OWN template: the standard
 * hold email promises the customer keeps their regular spot, and sending that to
 * someone who has just given notice would be the app lying about a bill it is
 * about to charge.
 */
async function notifyHoldPlaced(a: {
  companyId: number; clientId: number; client: any;
  kind: HoldKind; today: string; until: string; classification: HoldClassification;
}): Promise<void> {
  try {
    const svc = await resolveServiceInfo(a.companyId, a.clientId);
    const base: Record<string, string> = {
      first_name: String(a.client.first_name || "there"),
      service_summary: svc.serviceSummary,
      service_price: svc.servicePrice,
    };
    const isNotice = a.kind === "notice";
    const trig = isNotice ? "service_hold_notice_started" : "service_suspended";
    const noticeVars: Record<string, string> = isNotice && a.classification.notice
      ? {
          notice_visits: String(a.classification.notice.visits),
          notice_amount: money(a.classification.notice.amount),
        }
      : {};
    const emailVars = { ...base, ...noticeVars, start_date: fmtHoldDateLong(a.today), end_date: fmtHoldDateLong(a.until) };
    const smsVars = { ...base, ...noticeVars, start_date: fmtHoldDateShort(a.today), end_date: fmtHoldDateShort(a.until) };
    const emailSent = await sendNotification(trig, "email", a.companyId, a.client.email, null, emailVars).catch(() => false);
    const smsSent = await sendNotification(trig, "sms", a.companyId, null, a.client.phone, smsVars).catch(() => false);
    await db.execute(sql`
      INSERT INTO client_communications
        (company_id, client_id, type, direction, subject, body, from_name, created_at)
      VALUES
        (${a.companyId}, ${a.clientId}, 'suspension', 'outbound', 'Service suspended',
         ${(emailSent || smsSent) ? "Suspension confirmation sent." : "Suspension recorded (message suppressed by comms settings / opt-out)."},
         'System', now())
    `);
  } catch (e) {
    console.error("[service-hold] place notify failed:", e);
  }
}

/**
 * Lift a hold. Resuming before the end date is the customer changing their mind,
 * and the agreement is explicit that nothing is charged for it — including when
 * the hold was classified as notice. The free days it consumed stay spent, which
 * is correct: they had the pause.
 */
export async function liftHold(opts: {
  companyId: number;
  clientId: number;
  actor: HoldActor;
}): Promise<LiftHoldResult> {
  const { companyId, clientId } = opts;

  const cRes = await db.execute(sql`
    SELECT id, suspended_at FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1
  `);
  const client: any = cRes.rows[0];
  if (!client) return { ok: false, refusal: "client_not_found" };
  if (!client.suspended_at) return { ok: false, refusal: "not_on_hold" };

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

  await closeHoldOnResume(companyId, clientId);

  try {
    const who = opts.actor.kind === "customer"
      ? "Customer resumed service from their online account."
      : "Service hold lifted by the office.";
    await db.execute(sql`
      INSERT INTO client_communications
        (company_id, client_id, type, direction, subject, body, from_name, created_at)
      VALUES
        (${companyId}, ${clientId}, 'suspension', 'internal', 'Service resumed',
         ${`${who} ${reactivated} recurring schedule(s) re-activated.`}, 'System', now())
    `);
  } catch (e) {
    console.warn("[service-hold] resume comm-log non-fatal:", e);
  }

  const allowance = await getHoldAllowance(companyId, clientId, todayYmd());
  return { ok: true, reactivatedSchedules: reactivated, allowance };
}
