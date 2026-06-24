/**
 * Pure formatting + date math for leave reset notifications (Sal 2026-06-24).
 *
 * No DB / no notify imports — so the unit tests can exercise the message
 * construction without pulling in the drizzle client (same split as
 * leave-grant-reset.ts vs leave-reconcile.ts). The DB + notify side lives in
 * ./leave-reset-notify.ts, which composes these.
 */
import {
  benefitYearStartDate,
  entitlementHours,
  type GrantBucket,
} from "./leave-grant-reset.js";
import type { ReconcilePlanRow } from "./leave-reconcile.js";

/** Lead time (days before the reset) for the heads-up. Owner-tunable later. */
export const RESET_REMINDER_LEAD_DAYS =
  Number(process.env.LEAVE_RESET_LEAD_DAYS) || 7;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtHours(h: number): string {
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

/** The employee's NEXT work-anniversary reset strictly after `asOf`: the most
 *  recent anniversary on/before asOf, plus one year. Mirrors the engine's
 *  benefitYearStartDate so the reminder lands on the exact reset the cron will
 *  perform. */
export function nextResetDate(hireDate: string, asOf: string): Date {
  const start = benefitYearStartDate(hireDate, asOf);
  return new Date(
    Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()),
  );
}

/** Pure: build the heads-up message for one employee, or null if their next
 *  reset is outside the lead window or no bucket would grant. */
export function buildUpcomingResetMessage(
  user: { id: number; name: string; hire_date: string | null },
  asOf: string,
  buckets: Array<GrantBucket & { display_name: string }>,
  ceiling: number,
  leadDays: number,
): { reset_date: string; days_until: number; title: string; body: string } | null {
  if (!user.hire_date) return null;
  const reset = nextResetDate(user.hire_date, asOf);
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const daysUntil = Math.round((reset.getTime() - asOfMs) / 86400000);
  if (daysUntil < 0 || daysUntil > leadDays) return null;
  const resetYmd = ymd(reset);
  const parts = buckets
    .map((b) => {
      const ent = entitlementHours(b, user.hire_date as string, resetYmd, ceiling);
      return ent > 0 ? `${b.display_name} → ${fmtHours(ent)}` : null;
    })
    .filter(Boolean) as string[];
  if (!parts.length) return null;
  const dayWord =
    daysUntil === 0 ? "today" : daysUntil === 1 ? "in 1 day" : `in ${daysUntil} days`;
  return {
    reset_date: resetYmd,
    days_until: daysUntil,
    title: `${user.name}'s leave resets ${dayWord}`,
    body: `Work anniversary ${resetYmd} — ${parts.join(", ")}.`,
  };
}

/** Pure: collapse reconcile rows whose action changed a balance into one
 *  office message per employee. */
export function buildAppliedResetMessages(
  planRows: ReconcilePlanRow[],
): Array<{ user_id: number; title: string; body: string }> {
  const verb: Record<string, string> = {
    initial_grant: "granted",
    annual_reset: "reset to",
    tier_topup: "topped up to",
  };
  const byUser = new Map<number, { name: string; parts: string[] }>();
  for (const r of planRows) {
    const act = r.plan.action;
    if (act === "none") continue;
    const name =
      `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || `Employee #${r.user_id}`;
    const entry = byUser.get(r.user_id) ?? { name, parts: [] };
    entry.parts.push(
      `${r.display_name} ${verb[act] ?? "set to"} ${fmtHours(r.plan.new_granted)}`,
    );
    byUser.set(r.user_id, entry);
  }
  return [...byUser.entries()].map(([user_id, e]) => ({
    user_id,
    title: `${e.name}'s leave was reset`,
    body: `${e.parts.join(", ")}.`,
  }));
}
