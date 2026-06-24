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

/** Flat company-floor rate for paid sick + PTO hours. */
export const LEAVE_PAY_RATE = 20;

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
  const amount = Math.round(hours * LEAVE_PAY_RATE * 100) / 100;
  const marker = `leave_req#${requestId}`;
  const dates =
    String(row.start_date) === String(row.end_date)
      ? String(row.start_date)
      : `${String(row.start_date)}–${String(row.end_date)}`;
  const notes = `${row.display_name} leave approved (${marker}) — ${hours.toFixed(2)}h × $${LEAVE_PAY_RATE}/hr, ${dates}`;

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
