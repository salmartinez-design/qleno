// [hold-allowance 2026-08-20] The software half of the service-hold rules the
// residential Section 9 / commercial Section 5 agreement text now promises.
//
// The problem this closes: before today a hold was an unlimited, free, repeatable
// pause. A client could chain 90-day holds forever and keep their slot off the
// board at no cost, and nothing in the system ever counted how much pause they
// had taken. The agreement now says three things, and this module is what makes
// each of them true:
//
//   1. A client gets companies.agr_hold_notice_free_days FREE hold days in any
//      rolling 12 months, taken at once or split across several holds.
//   2. A hold that does NOT fit inside the days they have left serves as their
//      termination notice. Resume before it ends and nothing is charged.
//   3. If they do not resume by the day a notice hold ends, the agreement ends
//      that day and the visits their OWN schedule would have had in the last
//      companies.agr_termination_notice_days days of the hold are billed at
//      their per-visit rate, charged to the card on file the same day.
//
// Rule 3 is why this cannot be a flat "one final visit". Sal, 2026-08-19:
// "for a client where we're going out every week we're still gonna bill them
// about four additional services." And then: "shouldnt it depend on the month
// and year they quit." It does — we replay the client's real cadence through
// generateCadenceDates() over the real calendar window, so a weekly client who
// quits across a five-Tuesday stretch owes five, not four.
//
// This module owns the ledger (service_holds), the allowance math, the
// classification a hold gets at booking time, and the at-expiry close-out. The
// suspend/resume ACTIONS stay in routes/client-suspension.ts and the daily sweep
// stays in lib/suspension.ts; both call in here.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { generateCadenceDates, describeCadence, type CadenceInput } from "./recurring-cadences.js";
import { getNextInvoiceNumber } from "./invoice-number.js";
import { chargeInvoice } from "./charge-invoice.js";

// Fallbacks only. The live numbers are per-tenant on companies.
export const DEFAULT_HOLD_MAX_DAYS = 90;
export const DEFAULT_FREE_HOLD_DAYS = 30;
export const DEFAULT_NOTICE_DAYS = 30;

export type HoldKind = "free" | "notice";
export type HoldStatus = "active" | "resumed" | "ended" | "cancelled";

export type HoldPolicy = {
  maxDays: number;
  freeDays: number;
  noticeDays: number;
};

export type HoldAllowance = {
  /** Free hold days the tenant grants per rolling 12 months. */
  allowed: number;
  /** Days already spent inside the window (plus office grants credited back). */
  used: number;
  /** allowed - used, floored at 0. */
  remaining: number;
  /** First day of the rolling window (inclusive), YYYY-MM-DD. */
  windowStart: string;
};

export type NoticeQuote = {
  /** Visits the client's own schedule(s) had in the notice window. */
  visits: number;
  /** Dollars owed for those visits. */
  amount: number;
  /** The dates themselves, so the office can see what it is billing for. */
  dates: string[];
  windowStart: string;
  windowEnd: string;
  /** Plain English for the schedule(s) that produced these visits. */
  cadence: string;
  /** Per-schedule detail; a client can carry more than one recurring schedule. */
  lines: Array<{ schedule_id: number; date: string; rate: number }>;
};

// [cadence-label 2026-08-20] "4 visits" is not a reviewable number on its own.
// The office has to see WHICH schedule produced it, because the whole point of
// the rule is that the count follows the client's own cadence. A weekly Friday
// client billing 4 is right; a monthly client billing 4 is a bug, and nobody
// can tell those apart from the number alone.

export type HoldClassification = {
  startDate: string;
  endDate: string;
  /** Inclusive day count, so start === end is one day. */
  days: number;
  kind: HoldKind;
  allowance: HoldAllowance;
  /** Free days this hold would consume (0 for a notice hold). */
  freeDaysUsed: number;
  policy: HoldPolicy;
  /** The client's schedule in plain English. Shown for a free hold too, so the
   *  office is always looking at the same description of what it is pausing. */
  cadence: string;
  /** Only populated for a notice hold — what it would cost if they never resume. */
  notice: NoticeQuote | null;
};

// ── date helpers ─────────────────────────────────────────────────────────────
// All hold dates are bare YYYY-MM-DD calendar days. Anchor at local noon before
// touching a Date so no US-Central boundary can shift the day.

export function ymdToDate(ymd: string): Date {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
export function dateToYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export function shiftYmd(ymd: string, days: number): string {
  const d = ymdToDate(ymd);
  d.setDate(d.getDate() + days);
  return dateToYmd(d);
}
// [notice-window-boundary 2026-08-20] Window bounds for a cadence replay are
// NOT noon-anchored. generateCadenceDates emits local-midnight Dates and
// compares them with plain >= / <=, so a noon-anchored `from` silently drops a
// visit that lands exactly on the first day of the notice window. That is a
// whole visit of undercharge on any weekly client whose window happens to open
// on their service day. Bound the window at the real edges of the day instead.
export function ymdToDayStart(ymd: string): Date {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
export function ymdToDayEnd(ymd: string): Date {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

/** Inclusive day count: 2026-09-01 .. 2026-09-01 is 1 day. */
export function inclusiveDays(startYmd: string, endYmd: string): number {
  const ms = ymdToDate(endYmd).getTime() - ymdToDate(startYmd).getTime();
  return Math.round(ms / 86400000) + 1;
}

function money(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return isFinite(n) && n > 0 ? n : 0;
}

// ── migration ────────────────────────────────────────────────────────────────
// Idempotent, boot-path safe. Mirrors runSuspensionMigration()'s shape.
export async function runServiceHoldMigration(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS service_holds (
        id serial PRIMARY KEY,
        company_id integer NOT NULL,
        client_id integer NOT NULL,
        start_date date NOT NULL,
        end_date date NOT NULL,
        days integer NOT NULL,
        kind text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        free_days_used integer NOT NULL DEFAULT 0,
        reason text,
        created_by_user_id integer,
        created_at timestamp NOT NULL DEFAULT now(),
        resumed_at timestamp,
        ended_at timestamp,
        notice_visits integer,
        notice_amount numeric(10,2),
        notice_dates jsonb,
        notice_invoice_id integer,
        charge_outcome text,
        charge_message text,
        granted_free_days integer NOT NULL DEFAULT 0,
        waive_notice_charge boolean NOT NULL DEFAULT false,
        override_reason text,
        override_by_user_id integer,
        override_at timestamp
      )
    `);
    // Additive, for any environment that already created the table above
    // before overrides could be applied after the fact.
    await db.execute(sql`
      ALTER TABLE service_holds ADD COLUMN IF NOT EXISTS override_at timestamp
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS service_holds_client_idx
        ON service_holds (company_id, client_id, start_date DESC)
    `);
    // One live hold per client. A partial unique index is the only thing that
    // can actually stop a double-suspend racing through two requests.
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS service_holds_one_active_idx
        ON service_holds (company_id, client_id) WHERE status = 'active'
    `);
    console.log("[service-hold] migration ok");
  } catch (err) {
    console.error("[service-hold] migration error (non-fatal):", err);
  }
}

// ── policy + allowance ───────────────────────────────────────────────────────

export async function resolveHoldPolicy(companyId: number): Promise<HoldPolicy> {
  try {
    const r = await db.execute(sql`
      SELECT agr_hold_max_days, agr_hold_notice_free_days, agr_termination_notice_days
        FROM companies WHERE id = ${companyId} LIMIT 1
    `);
    const co: any = r.rows[0] || {};
    return {
      maxDays: Number(co.agr_hold_max_days ?? DEFAULT_HOLD_MAX_DAYS) || DEFAULT_HOLD_MAX_DAYS,
      freeDays: Number(co.agr_hold_notice_free_days ?? DEFAULT_FREE_HOLD_DAYS),
      noticeDays: Number(co.agr_termination_notice_days ?? DEFAULT_NOTICE_DAYS) || DEFAULT_NOTICE_DAYS,
    };
  } catch {
    return { maxDays: DEFAULT_HOLD_MAX_DAYS, freeDays: DEFAULT_FREE_HOLD_DAYS, noticeDays: DEFAULT_NOTICE_DAYS };
  }
}

// Free days spent in the 12 months ending on asOf. The window is anchored on the
// hold's START date: a hold is counted where it began, so a client cannot reset
// their allowance by letting one straddle the anniversary.
//
// granted_free_days is the office override — extra days handed to this client for
// this hold, added to the ceiling rather than subtracted from the spend, so the
// audit trail shows both the standard allowance and what was granted on top.
export async function getHoldAllowance(
  companyId: number,
  clientId: number,
  asOfYmd: string,
  policy?: HoldPolicy,
): Promise<HoldAllowance> {
  const p = policy ?? (await resolveHoldPolicy(companyId));
  const windowStart = shiftYmd(asOfYmd, -364);
  let used = 0;
  let granted = 0;
  try {
    const r = await db.execute(sql`
      SELECT COALESCE(SUM(free_days_used), 0)   AS used,
             COALESCE(SUM(granted_free_days), 0) AS granted
        FROM service_holds
       WHERE company_id = ${companyId}
         AND client_id = ${clientId}
         AND status <> 'cancelled'
         AND start_date >= ${windowStart}::date
         AND start_date <= ${asOfYmd}::date
    `);
    used = Number((r.rows[0] as any)?.used ?? 0) || 0;
    granted = Number((r.rows[0] as any)?.granted ?? 0) || 0;
  } catch (e) {
    // Table not migrated yet: report the full allowance rather than blocking
    // the office from placing a hold at all.
    console.warn("[service-hold] allowance lookup non-fatal:", e);
  }
  const allowed = Math.max(0, p.freeDays + granted);
  return { allowed, used, remaining: Math.max(0, allowed - used), windowStart };
}

// ── the notice quote ─────────────────────────────────────────────────────────

type ScheduleRow = CadenceInput & { id: number; base_fee: unknown; monthly_charge_amount: unknown };

// Every schedule the hold froze, plus any still live. During a hold the rows sit
// at is_active=false / paused_by_suspension=true, so filtering on is_active alone
// would count zero visits and bill $0 — the same shape of bug as the commercial
// no-budget $0 pay regression.
async function loadHeldSchedules(companyId: number, clientId: number): Promise<ScheduleRow[]> {
  const r = await db.execute(sql`
    SELECT id, frequency, day_of_week, days_of_week, days_of_month,
           custom_frequency_weeks, week_of_month, month_interval,
           start_date::text AS start_date, end_date::text AS end_date,
           base_fee, monthly_charge_amount
      FROM recurring_schedules
     WHERE customer_id = ${clientId}
       AND company_id = ${companyId}
       AND (is_active = true OR paused_by_suspension = true)
     ORDER BY id
  `);
  return (r.rows as any[]).map((s) => ({ ...s, id: Number(s.id) }));
}

/** Every live schedule for this client, in plain English, joined for display. */
function describeSchedules(schedules: ScheduleRow[]): string {
  const parts = schedules
    .map((s) => describeCadence(s as unknown as CadenceInput))
    .filter((x, i, a) => x && a.indexOf(x) === i);
  return parts.join(" and ");
}

// The per-visit rate for a schedule. base_fee is the carrier; a commercial
// monthly-batch schedule prices the whole month instead, so divide it by the
// visits that month actually produced rather than guessing a divisor.
function perVisitRate(s: ScheduleRow, visitsInMonth: number): number {
  const fee = money(s.base_fee);
  if (fee > 0) return fee;
  const monthly = money(s.monthly_charge_amount);
  if (monthly > 0 && visitsInMonth > 0) return Math.round((monthly / visitsInMonth) * 100) / 100;
  return 0;
}

/**
 * What the client's real schedule would have delivered in the last `noticeDays`
 * days of a hold ending on `holdEndYmd` — the amount Section 9 makes due when a
 * notice hold runs out without a resume.
 *
 * The window is inclusive on both ends: a 30-day notice ending 2026-09-30 covers
 * 2026-09-01 through 2026-09-30.
 */
export async function quoteNoticeVisits(
  companyId: number,
  clientId: number,
  holdEndYmd: string,
  noticeDays: number,
): Promise<NoticeQuote> {
  const windowEnd = holdEndYmd.slice(0, 10);
  const windowStart = shiftYmd(windowEnd, -(Math.max(1, noticeDays) - 1));
  const from = ymdToDayStart(windowStart);
  const to = ymdToDayEnd(windowEnd);

  const lines: NoticeQuote["lines"] = [];
  let amount = 0;
  const schedules = await loadHeldSchedules(companyId, clientId);
  for (const s of schedules) {
    let dates: Date[] = [];
    try {
      dates = generateCadenceDates(s, from, to);
    } catch (e) {
      console.warn(`[service-hold] cadence replay failed for schedule ${s.id}:`, e);
      continue;
    }
    if (dates.length === 0) continue;
    const rate = perVisitRate(s, dates.length);
    for (const d of dates) {
      const ymd = dateToYmd(d);
      lines.push({ schedule_id: s.id, date: ymd, rate });
      amount += rate;
    }
  }
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    visits: lines.length,
    amount: Math.round(amount * 100) / 100,
    dates: lines.map((l) => l.date),
    windowStart,
    windowEnd,
    cadence: describeSchedules(schedules),
    lines,
  };
}

// ── classification ───────────────────────────────────────────────────────────

/**
 * Decide, before anything is saved, whether a requested hold is free or is the
 * client's notice — and if it is notice, what it would cost. The office sees
 * this on the confirm screen, so nobody signs a customer up for a $1,040 bill
 * without being told.
 */
export async function classifyHold(
  companyId: number,
  clientId: number,
  startYmd: string,
  endYmd: string,
): Promise<HoldClassification> {
  const policy = await resolveHoldPolicy(companyId);
  const allowance = await getHoldAllowance(companyId, clientId, startYmd, policy);
  const days = inclusiveDays(startYmd, endYmd);
  const fits = days <= allowance.remaining;
  const kind: HoldKind = fits ? "free" : "notice";
  const cadence = describeSchedules(await loadHeldSchedules(companyId, clientId));
  return {
    startDate: startYmd,
    endDate: endYmd,
    days,
    kind,
    allowance,
    // A notice hold consumes no allowance: it is not a pause the client gets
    // back, it is the end of the agreement. Charging it against the free bank
    // too would be billing the same days twice.
    freeDaysUsed: fits ? days : 0,
    policy,
    cadence,
    notice: fits ? null : await quoteNoticeVisits(companyId, clientId, endYmd, policy.noticeDays),
  };
}

// ── ledger writes ────────────────────────────────────────────────────────────

/** Open the ledger row for a hold. Call inside the suspend transaction. */
export async function openHold(
  tx: any,
  args: {
    companyId: number;
    clientId: number;
    startDate: string;
    endDate: string;
    days: number;
    kind: HoldKind;
    freeDaysUsed: number;
    grantedFreeDays?: number;
    reason?: string | null;
    userId?: number | null;
    overrideReason?: string | null;
  },
): Promise<number | null> {
  try {
    const r = await tx.execute(sql`
      INSERT INTO service_holds
        (company_id, client_id, start_date, end_date, days, kind, status,
         free_days_used, granted_free_days, reason, created_by_user_id, override_reason,
         override_by_user_id)
      VALUES
        (${args.companyId}, ${args.clientId}, ${args.startDate}::date, ${args.endDate}::date,
         ${args.days}, ${args.kind}, 'active', ${args.freeDaysUsed}, ${args.grantedFreeDays ?? 0},
         ${args.reason ?? null}, ${args.userId ?? null}, ${args.overrideReason ?? null},
         ${args.overrideReason ? (args.userId ?? null) : null})
      RETURNING id
    `);
    return Number((r.rows as any[])[0]?.id) || null;
  } catch (e) {
    // Never let the ledger stop the office from placing a hold — the hold is the
    // operational act, the ledger is the accounting of it.
    console.error("[service-hold] openHold failed (non-fatal):", e);
    return null;
  }
}

/** Close the live hold when the client resumes. Nothing is charged. */
export async function closeHoldOnResume(companyId: number, clientId: number): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE service_holds
         SET status = 'resumed', resumed_at = now()
       WHERE company_id = ${companyId} AND client_id = ${clientId} AND status = 'active'
    `);
  } catch (e) {
    console.warn("[service-hold] closeHoldOnResume non-fatal:", e);
  }
}

// ── at-expiry close-out ──────────────────────────────────────────────────────

export type HoldCloseoutResult = {
  holdId: number;
  clientId: number;
  ended: boolean;
  visits: number;
  amount: number;
  invoiceId: number | null;
  chargeOutcome: string | null;
  message: string;
};

/**
 * A NOTICE hold reached its end date and the client never resumed. Section 9:
 * "this Agreement ends that day and the visits that would have taken place
 * during the last {{termination_notice_days}} days of that hold are due."
 *
 * This is a deliberate, narrow reversal of the 2026-07-11 rule in lib/suspension.ts
 * that an expiring hold only ever FLAGS for office. That rule still governs FREE
 * holds — those just wait for a person. It cannot govern a notice hold, because a
 * notice hold is the customer's own written termination and the agreement fixes
 * what happens on the day it runs out.
 *
 * Money still fails safe: a decline leaves the invoice sent-and-unpaid and tells
 * the office. The agreement ends either way, because the ending is what the
 * customer asked for, not a consequence of the card working.
 */
export async function endExpiredNoticeHold(hold: {
  id: number;
  company_id: number;
  client_id: number;
  end_date: string;
  waive_notice_charge?: boolean;
}): Promise<HoldCloseoutResult> {
  const companyId = Number(hold.company_id);
  const clientId = Number(hold.client_id);
  const endYmd = String(hold.end_date).slice(0, 10);
  const policy = await resolveHoldPolicy(companyId);

  // Quote BEFORE we end the schedules — ending stamps an end_date on them, and
  // generateCadenceDates clamps at a schedule's end_date, which would silently
  // zero out the very visits we are billing for.
  const quote = hold.waive_notice_charge
    ? { visits: 0, amount: 0, dates: [], windowStart: endYmd, windowEnd: endYmd, cadence: "", lines: [] as NoticeQuote["lines"] }
    : await quoteNoticeVisits(companyId, clientId, endYmd, policy.noticeDays);

  // End the recurring agreement. paused_by_suspension is cleared on the way out
  // so a later Resume can never revive a schedule the customer terminated.
  await db.transaction(async (tx: any) => {
    await tx.execute(sql`
      UPDATE recurring_schedules
         SET is_active = false,
             paused_by_suspension = false,
             end_date = COALESCE(end_date, ${endYmd}::date)
       WHERE customer_id = ${clientId}
         AND company_id = ${companyId}
         AND (is_active = true OR paused_by_suspension = true)
    `);
    // Belt and braces: any future job that survived the original suspend.
    await tx.execute(sql`
      UPDATE jobs
         SET status = 'cancelled'::job_status
       WHERE client_id = ${clientId}
         AND company_id = ${companyId}
         AND status::text IN ('scheduled','in_progress')
         AND COALESCE(occurrence_date, scheduled_date) >= ${endYmd}::date
    `);
    // The hold is over and the client is no longer on hold — they are a former
    // recurring customer. Leaving suspend_until set would keep them showing as
    // paused forever.
    await tx.execute(sql`
      UPDATE clients
         SET suspended_at = NULL, suspend_until = NULL,
             suspended_by_user_id = NULL,
             suspend_resume_reminder_sent_at = NULL
       WHERE id = ${clientId} AND company_id = ${companyId}
    `);
  });

  let invoiceId: number | null = null;
  let charge: { outcome: string; message: string } | null = null;

  if (quote.amount > 0) {
    invoiceId = await raiseNoticeInvoice(companyId, clientId, endYmd, quote);
    if (invoiceId) {
      try {
        const r = await chargeInvoice(companyId, invoiceId, null);
        charge = { outcome: r.outcome, message: r.message };
      } catch (e: any) {
        charge = { outcome: "failed", message: e?.message || "charge threw" };
      }
    }
  }

  try {
    await db.execute(sql`
      UPDATE service_holds
         SET status = 'ended', ended_at = now(),
             notice_visits = ${quote.visits},
             notice_amount = ${quote.amount.toFixed(2)},
             notice_dates = ${JSON.stringify(quote.dates)}::jsonb,
             notice_invoice_id = ${invoiceId},
             charge_outcome = ${charge?.outcome ?? null},
             charge_message = ${charge?.message ?? null}
       WHERE id = ${hold.id}
    `);
  } catch (e) {
    console.error("[service-hold] closeout ledger update failed:", e);
  }

  return {
    holdId: Number(hold.id),
    clientId,
    ended: true,
    visits: quote.visits,
    amount: quote.amount,
    invoiceId,
    chargeOutcome: charge?.outcome ?? null,
    message: charge?.message ?? (quote.amount > 0 ? "invoice raised" : "no notice amount due"),
  };
}

// Raise the notice invoice as an issued (status 'sent') invoice — chargeInvoice
// refuses a draft, and this amount is contractually due the day the hold ends,
// not whenever someone gets round to issuing it. sent_at stays NULL so every
// surface labels it ISSUED rather than claiming we emailed it.
async function raiseNoticeInvoice(
  companyId: number,
  clientId: number,
  endYmd: string,
  quote: NoticeQuote,
): Promise<number | null> {
  const fmt = (ymd: string) =>
    ymdToDate(ymd).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  // Customer-facing copy: plain words, no dashes.
  const lineItems = quote.lines.map((l) => ({
    description: `Notice period visit (${fmt(l.date)})`,
    quantity: 1,
    unit_price: l.rate,
    total: l.rate,
  }));
  try {
    return await db.transaction(async (tx: any) => {
      const ins: any = await tx.execute(sql`
        INSERT INTO invoices
          (company_id, client_id, status, line_items, subtotal, tips, total,
           due_date, service_date, payment_terms, created_by)
        VALUES
          (${companyId}, ${clientId}, 'sent', ${JSON.stringify(lineItems)}::jsonb,
           ${quote.amount.toFixed(2)}, '0', ${quote.amount.toFixed(2)},
           ${endYmd}::date, ${endYmd}::date, 'due_on_receipt', NULL)
        RETURNING id
      `);
      const invoiceId = Number(ins.rows[0].id);
      const number = await getNextInvoiceNumber(companyId, invoiceId);
      await tx.execute(sql`UPDATE invoices SET invoice_number = ${number} WHERE id = ${invoiceId}`);
      return invoiceId;
    });
  } catch (e) {
    console.error("[service-hold] notice invoice insert failed:", e);
    return null;
  }
}

/** The live hold for a client, or null. Used by the suspend/resume routes. */
export async function getActiveHold(companyId: number, clientId: number): Promise<any | null> {
  try {
    const r = await db.execute(sql`
      SELECT id, company_id, client_id, start_date::text AS start_date,
             end_date::text AS end_date, days, kind, status, free_days_used,
             granted_free_days, waive_notice_charge, reason,
             override_reason, override_by_user_id, override_at
        FROM service_holds
       WHERE company_id = ${companyId} AND client_id = ${clientId} AND status = 'active'
       ORDER BY id DESC LIMIT 1
    `);
    return (r.rows as any[])[0] ?? null;
  } catch {
    return null;
  }
}

// ── Office overrides ─────────────────────────────────────────────────────────
// [hold-override 2026-08-20] Sal, asked whether the office should be able to
// waive the final bill on a notice hold: "yes with reason dispositions."
//
// So the waive is a real button, not a database edit, and it never happens
// anonymously. A fixed list rather than a free-text box is the whole point: a
// year from now "why did we forgive $1,040?" has to be answerable by counting,
// and free text cannot be counted. Both the server and the UI read this list, so
// a reason that exists on the screen always exists in the validation.
export const HOLD_OVERRIDE_REASONS = [
  { code: "medical",       label: "Medical or family emergency" },
  { code: "military",      label: "Military deployment" },
  { code: "service_issue", label: "Making up for a service problem" },
  { code: "long_standing", label: "Long standing customer, goodwill" },
  { code: "our_error",     label: "Our scheduling or billing error" },
  { code: "owner_decision",label: "Owner decision" },
] as const;

export type HoldOverrideReasonCode = typeof HOLD_OVERRIDE_REASONS[number]["code"];

export function isHoldOverrideReason(code: unknown): code is HoldOverrideReasonCode {
  return HOLD_OVERRIDE_REASONS.some((r) => r.code === String(code));
}

/** The stored `override_reason` string: the code, plus the note if one was left. */
export function composeOverrideReason(code: HoldOverrideReasonCode, note?: string | null): string {
  const label = HOLD_OVERRIDE_REASONS.find((r) => r.code === code)?.label ?? code;
  const n = (note ?? "").trim();
  return n ? `${label}: ${n}` : label;
}

export type HoldOverrideInput = {
  companyId: number;
  clientId: number;
  /** Skip the end-of-notice bill entirely. Service still ends on the end date. */
  waiveNoticeCharge?: boolean;
  /** Extra free hold days for THIS hold, on top of the tenant allowance. */
  grantedFreeDays?: number;
  reasonCode: HoldOverrideReasonCode;
  reasonNote?: string | null;
  userId: number;
};

export type HoldOverrideResult =
  | { ok: false; refusal: "no_active_hold" | "bad_reason" | "bad_days" }
  | { ok: true; hold: any };

/**
 * Change the office-only override fields on a client's ACTIVE hold.
 *
 * Deliberately separate from placing the hold. The waive is usually decided
 * AFTER the fact: the customer calls three weeks into a notice hold and explains
 * themselves, and by then the suspend screen is long gone. Before this existed
 * the three override columns could only ever be set in the same breath as the
 * suspension, which is to say almost never.
 *
 * What it does NOT do: end the hold, resume service, or move any money. A waived
 * notice hold still ends the agreement on its end date; endExpiredNoticeHold
 * simply raises no invoice when it gets there.
 */
export async function setHoldOverride(input: HoldOverrideInput): Promise<HoldOverrideResult> {
  const { companyId, clientId, userId } = input;
  if (!isHoldOverrideReason(input.reasonCode)) return { ok: false, refusal: "bad_reason" };

  const granted = input.grantedFreeDays === undefined ? null : Math.trunc(Number(input.grantedFreeDays));
  if (granted !== null && (!Number.isFinite(granted) || granted < 0 || granted > 365)) {
    return { ok: false, refusal: "bad_days" };
  }

  const active = await getActiveHold(companyId, clientId);
  if (!active) return { ok: false, refusal: "no_active_hold" };

  const waive = input.waiveNoticeCharge === undefined ? null : !!input.waiveNoticeCharge;
  const reason = composeOverrideReason(input.reasonCode, input.reasonNote);

  await db.execute(sql`
    UPDATE service_holds
       SET waive_notice_charge = COALESCE(${waive}::boolean, waive_notice_charge),
           granted_free_days   = COALESCE(${granted}::integer, granted_free_days),
           override_reason     = ${reason},
           override_by_user_id = ${userId},
           override_at         = NOW()
     WHERE id = ${active.id} AND company_id = ${companyId}
  `);

  const hold = await getActiveHold(companyId, clientId);
  return { ok: true, hold };
}
