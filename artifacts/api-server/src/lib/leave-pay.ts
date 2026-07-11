/**
 * Auto-pay approved paid leave (Sal 2026-06-20).
 *
 * Approval is the gate: when the office approves a PAID leave request
 * (PLAWA / PTO), the hours cascade into pay automatically as a visible,
 * labeled `additional_pay` line item — no separate manual pay step.
 *
 *   pay = hours × LEAVE_PAY_RATE ($20/hr, the company floor — a FLAT rate
 *   for leave, NOT each tech's commission/blended rate).
 *
 * Type mapping (so the payroll Time-Off group + label render correctly):
 *   sick / PLAWA bucket → additional_pay type 'sick_pay'  → "Sick Pay"
 *   PTO bucket          → additional_pay type 'pto'       → "PTO"
 *   unpaid buckets      → no pay row (is_paid = false)
 *
 * Idempotent: re-approving (e.g. denied→approved override) never
 * double-pays — guarded on a `leave_req#<id>` marker in the notes.
 * status='pending' so it flows into the payroll window (which excludes
 * only 'voided'); created_at = now so it lands in the period of approval.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/** Default flat rate for paid sick + PTO hours when a company hasn't set one. */
export const LEAVE_PAY_RATE = 20;

/**
 * Resolve a company's leave pay rate ($/hr) from the `companies.leave_pay_rate`
 * setting, falling back to LEAVE_PAY_RATE ($20) when unset or the column isn't
 * present yet. A flat per-company rate for paid leave — NOT each tech's
 * commission/blended rate (Sal 2026-07-11). Both the approval and office-deduct
 * pay paths read this so the two agree.
 */
export async function resolveLeavePayRate(companyId: number): Promise<number> {
  try {
    const r = await db.execute(sql`SELECT leave_pay_rate FROM companies WHERE id = ${companyId} LIMIT 1`);
    const v = Number((r.rows[0] as any)?.leave_pay_rate);
    return Number.isFinite(v) && v > 0 ? v : LEAVE_PAY_RATE;
  } catch {
    return LEAVE_PAY_RATE;
  }
}

export type LeavePayResult =
  | { paid: false; reason: string }
  | { paid: true; type: string; hours: number; amount: number };

export async function writeApprovedLeavePay(
  companyId: number,
  requestId: number,
): Promise<LeavePayResult> {
  const r = await db.execute(sql`
    SELECT lr.user_id, lr.hours, lr.start_date, lr.end_date,
           lt.is_paid, lt.slug, lt.display_name
      FROM leave_requests lr
      JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.id = ${requestId} AND lr.company_id = ${companyId}
     LIMIT 1`);
  const row: any = r.rows[0];
  if (!row) return { paid: false, reason: "request not found" };
  if (!row.is_paid) return { paid: false, reason: "unpaid bucket" };

  const slug = String(row.slug);
  const payType =
    slug === "plawa" || slug === "sick" || slug.includes("sick")
      ? "sick_pay"
      : "pto";
  const hours = Number(row.hours);
  if (!(hours > 0)) return { paid: false, reason: "non-positive hours" };
  const rate = await resolveLeavePayRate(companyId);
  const amount = Math.round(hours * rate * 100) / 100;
  const marker = `leave_req#${requestId}`;
  const dates =
    String(row.start_date) === String(row.end_date)
      ? String(row.start_date)
      : `${String(row.start_date)}–${String(row.end_date)}`;
  const notes = `${row.display_name} leave approved (${marker}) — ${hours.toFixed(2)}h × $${rate}/hr, ${dates}`;

  // Insert only if no non-voided pay row already exists for this request.
  await db.execute(sql`
    INSERT INTO additional_pay (company_id, user_id, type, amount, notes, status, created_at)
    SELECT ${companyId}, ${Number(row.user_id)}, ${payType}, ${amount.toFixed(2)}, ${notes}, 'pending', NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM additional_pay
        WHERE company_id = ${companyId}
          AND notes LIKE ${"%" + marker + "%"}
          AND COALESCE(status,'pending') <> 'voided'
     )`);

  return { paid: true, type: payType, hours, amount };
}

/**
 * Reverse the auto-pay for a leave request when its approval is cancelled.
 * Marks any non-voided `additional_pay` row carrying this request's
 * `leave_req#<id>` marker as 'voided' (payroll excludes 'voided'), so the
 * employee is not paid for cancelled leave.
 *
 * Idempotent + symmetric with writeApprovedLeavePay:
 *  - re-cancel: only non-voided rows are touched, so it's a no-op the 2nd time
 *  - re-approve after cancel: the voided row no longer satisfies
 *    writeApprovedLeavePay's NOT EXISTS (status <> 'voided') guard, so a fresh
 *    pending row is inserted — never a double-pay, never a stranded one.
 * Unpaid buckets never created a pay row, so the UPDATE matches nothing.
 */
export async function voidApprovedLeavePay(
  companyId: number,
  requestId: number,
  voidedByUserId?: number | null,
): Promise<void> {
  const marker = `leave_req#${requestId}`;
  await db.execute(sql`
    UPDATE additional_pay
       SET status = 'voided',
           voided_at = NOW(),
           voided_by = ${voidedByUserId ?? null}
     WHERE company_id = ${companyId}
       AND notes LIKE ${"%" + marker + "%"}
       AND COALESCE(status,'pending') <> 'voided'`);
}

/**
 * Auto-pay a paid-leave USAGE row — the office "Update → Deduct hours" path
 * (POST /leave/usage), the sibling of the request-approval path above.
 *
 * The deduct modal records an `employee_leave_usage` row and draws down the
 * balance, but historically wrote no pay line, so PLAWA / PTO taken this way
 * silently paid $0. This closes that gap with the SAME rules as approval:
 *   pay = hours × LEAVE_PAY_RATE ($20/hr flat), type sick_pay (plawa/sick) or
 *   pto, only when the bucket is_paid.
 *
 * Two deliberate differences from the request path:
 *  - Idempotency marker is `[leave_usage:<id>]` (bracketed + colon so a LIKE
 *    on usage 5 can't match usage 50/51…), keyed to the usage-row id.
 *  - created_at is stamped to the LEAVE DATE (date_used), not now — payroll
 *    windows additional_pay by created_at, so the pay must land in the payroll
 *    period that contains the day off (including back-dated entries), not the
 *    period it happened to be typed in.
 */
export async function writeUsageLeavePay(
  companyId: number,
  usageId: number,
): Promise<LeavePayResult> {
  const r = await db.execute(sql`
    SELECT u.employee_id, u.hours, u.date_used,
           lt.is_paid, lt.slug, lt.display_name
      FROM employee_leave_usage u
      JOIN leave_types lt ON lt.id = u.leave_type_id
     WHERE u.id = ${usageId} AND u.company_id = ${companyId}
     LIMIT 1`);
  const row: any = r.rows[0];
  if (!row) return { paid: false, reason: "usage row not found" };
  if (row.leave_type_id === null && !row.slug) return { paid: false, reason: "no bucket" };
  if (!row.is_paid) return { paid: false, reason: "unpaid bucket" };

  const slug = String(row.slug);
  const payType =
    slug === "plawa" || slug === "sick" || slug.includes("sick")
      ? "sick_pay"
      : "pto";
  const hours = Number(row.hours);
  if (!(hours > 0)) return { paid: false, reason: "non-positive hours" };
  const rate = await resolveLeavePayRate(companyId);
  const amount = Math.round(hours * rate * 100) / 100;
  const marker = `[leave_usage:${usageId}]`;
  const dateUsed = String(row.date_used);
  const notes = `${row.display_name} leave recorded ${marker} — ${hours.toFixed(2)}h × $${rate}/hr, ${dateUsed}`;

  // Insert only if no non-voided pay row already exists for this usage row.
  // created_at = noon on the leave date so it lands in that day's payroll
  // period regardless of when it was recorded.
  await db.execute(sql`
    INSERT INTO additional_pay (company_id, user_id, type, amount, notes, status, created_at)
    SELECT ${companyId}, ${Number(row.employee_id)}, ${payType}, ${amount.toFixed(2)}, ${notes}, 'pending',
           (${dateUsed} || ' 12:00:00')::timestamp
     WHERE NOT EXISTS (
       SELECT 1 FROM additional_pay
        WHERE company_id = ${companyId}
          AND notes LIKE ${"%" + marker + "%"}
          AND COALESCE(status,'pending') <> 'voided'
     )`);

  return { paid: true, type: payType, hours, amount };
}

/**
 * Reverse the auto-pay for a leave-usage row when the office removes it
 * (DELETE /leave/usage/:id). Symmetric with writeUsageLeavePay and identical
 * in spirit to voidApprovedLeavePay — voids any non-voided pay row carrying
 * this usage row's `[leave_usage:<id>]` marker so a deleted deduction doesn't
 * leave paid dollars behind. No-op for unpaid buckets (no row was ever made).
 */
export async function voidUsageLeavePay(
  companyId: number,
  usageId: number,
  voidedByUserId?: number | null,
): Promise<void> {
  const marker = `[leave_usage:${usageId}]`;
  await db.execute(sql`
    UPDATE additional_pay
       SET status = 'voided',
           voided_at = NOW(),
           voided_by = ${voidedByUserId ?? null}
     WHERE company_id = ${companyId}
       AND notes LIKE ${"%" + marker + "%"}
       AND COALESCE(status,'pending') <> 'voided'`);
}
