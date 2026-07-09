/**
 * Leave reset notifications (Sal 2026-06-24) — the gap from the leave-engine
 * audit. Two office/owner alerts, both fired from the daily leave-accrual cron
 * (so both are already gated by LEAVE_ACCRUAL_ENABLED):
 *
 *   1. HEADS-UP  (notifyUpcomingResets): a configurable lead time (default 7d)
 *      before each active employee's next work-anniversary reset —
 *      "Norma Puga's leave resets in 7 days … PTO → 80h, PLAWA → 40h."
 *      Deduped per (employee, reset_date) via leave_reset_reminders so it fires
 *      once per upcoming reset even if the cron runs many times / restarts.
 *
 *   2. ON-RESET (notifyResetsApplied): when initial_grant / annual_reset /
 *      tier_topup actually fires in the reconcile — "Norma Puga's PTO reset to
 *      80h." Naturally deduped: the reconcile is idempotent (action != 'none'
 *      only on the reset day, once per benefit year), so it's sent once.
 *
 * Channel: notifyOfficeUsers → the in-app/bell (+ web push) for every
 * owner/admin/office user. The notification `type`s here are intentionally NOT
 * in TYPE_TO_CATEGORY, so they deliver IN-APP ONLY — no email/SMS — honoring
 * "show in the bell now, wire email/text when comms flips" (flip = add a
 * category mapping + opt-in later). Best-effort: never throws into the cron.
 *
 * Pure date math + message construction live in ./leave-reset-format.ts (no DB)
 * so they're unit-testable; this module is the thin DB + notify wrapper.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { notifyOfficeUsers } from "./notify.js";
import { type GrantBucket } from "./leave-grant-reset.js";
import type { ReconcilePlanRow } from "./leave-reconcile.js";
import {
  RESET_REMINDER_LEAD_DAYS,
  buildUpcomingResetMessage,
  buildAppliedResetMessages,
} from "./leave-reset-format.js";

export { RESET_REMINDER_LEAD_DAYS } from "./leave-reset-format.js";

/** Dedupe marker so the heads-up fires once per upcoming reset, not daily. */
async function ensureReminderTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS leave_reset_reminders (
      id serial PRIMARY KEY,
      company_id integer NOT NULL,
      user_id integer NOT NULL,
      reset_date date NOT NULL,
      notified_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, user_id, reset_date)
    )`);
}

type ActiveUser = { id: number; name: string; hire_date: string | null };

async function loadActiveUsers(companyId: number): Promise<ActiveUser[]> {
  const r = await db.execute(sql`
    SELECT id, COALESCE(NULLIF(TRIM(first_name||' '||last_name), ''), 'Employee #'||id) AS name, hire_date
      FROM users WHERE company_id = ${companyId} AND is_active = true`);
  return (r.rows as any[]).map((u) => ({
    id: Number(u.id),
    name: String(u.name),
    hire_date: u.hire_date ? String(u.hire_date).slice(0, 10) : null,
  }));
}

async function loadFlatGrantBuckets(
  companyId: number,
): Promise<Array<GrantBucket & { display_name: string }>> {
  const r = await db.execute(sql`
    SELECT slug, display_name, annual_cap_hours, waiting_period_days, carryover_allowed
      FROM leave_types
     WHERE company_id = ${companyId} AND active = true AND accrual_mode = 'flat_grant'`);
  return (r.rows as any[]).map((b) => ({
    slug: String(b.slug),
    display_name: String(b.display_name),
    accrual_mode: "flat_grant" as const,
    annual_cap_hours: Number(b.annual_cap_hours),
    waiting_period_days: Number(b.waiting_period_days),
    carryover_allowed: !!b.carryover_allowed,
  }));
}

async function loadCeiling(companyId: number): Promise<number> {
  const r = await db.execute(sql`
    SELECT balance_ceiling_hours FROM company_leave_policy WHERE company_id = ${companyId} LIMIT 1`);
  const c = (r.rows[0] as any)?.balance_ceiling_hours;
  return c != null ? Number(c) : 80;
}

/**
 * Heads-up: notify the office about each active employee whose next
 * work-anniversary reset is within `leadDays`. Returns how many alerts fired.
 */
export async function notifyUpcomingResets(
  companyId: number,
  asOf: string,
  leadDays: number = RESET_REMINDER_LEAD_DAYS,
): Promise<number> {
  await ensureReminderTable();
  const [users, buckets, ceiling] = await Promise.all([
    loadActiveUsers(companyId),
    loadFlatGrantBuckets(companyId),
    loadCeiling(companyId),
  ]);
  let fired = 0;

  for (const u of users) {
    const msg = buildUpcomingResetMessage(u, asOf, buckets, ceiling, leadDays);
    if (!msg) continue;

    // Dedupe: claim this (employee, reset_date) atomically; only the first
    // claimant sends. ON CONFLICT DO NOTHING → 0 rows means already notified.
    const claim = await db.execute(sql`
      INSERT INTO leave_reset_reminders (company_id, user_id, reset_date)
      VALUES (${companyId}, ${u.id}, ${msg.reset_date})
      ON CONFLICT (company_id, user_id, reset_date) DO NOTHING
      RETURNING id`);
    if (!claim.rows.length) continue;

    await notifyOfficeUsers(companyId, {
      type: "leave_reset_upcoming",
      title: msg.title,
      body: msg.body,
      link: `/employees/${u.id}`,
      meta: { user_id: u.id, reset_date: msg.reset_date, days_until: msg.days_until },
    });
    fired++;
  }
  return fired;
}

/**
 * On-reset: notify the office about grants/resets that JUST fired this run.
 * `planRows` is the reconcile output (post-write); reports only rows whose
 * action actually changed a balance. One alert per employee.
 */
export async function notifyResetsApplied(
  companyId: number,
  planRows: ReconcilePlanRow[],
): Promise<number> {
  const messages = buildAppliedResetMessages(planRows);
  for (const m of messages) {
    await notifyOfficeUsers(companyId, {
      type: "leave_reset_applied",
      title: m.title,
      body: m.body,
      link: `/employees/${m.user_id}`,
      meta: { user_id: m.user_id },
    });
  }
  return messages.length;
}
