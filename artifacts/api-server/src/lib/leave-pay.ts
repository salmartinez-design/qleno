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
 * only 'voided').
 *
 * [leave-day 2026-08-17] Pay is dated to the DAY OFF, not the day the office
 * clicked Approve. Approval already writes one `employee_leave_usage` row per
 * calendar day of the request, so this pays per usage day and stamps each row's
 * effective_date to that day. Two things this fixes, both of which Sal hit on
 * the payroll screen:
 *   - payroll windows additional_pay by its pay day, so leave approved in one
 *     week for a day off in the next was landing in the wrong pay week
 *     (live example: $100 stamped 2026-07-23 for leave taken 2026-07-28)
 *   - the day-by-day drawer had nothing to date the entry by, so it fell back
 *     to the approval date and showed the money on a day nobody was off
 * A multi-day request now pays per day instead of one lump at the front, so a
 * span crossing a pay week splits into the weeks it actually falls in.
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
  // The marker is written parenthesised — `(leave_req#12)` — and matched that
  // way too. A bare `%leave_req#5%` also matches `leave_req#50`, so request 5
  // would see request 50's row, skip its own insert and never pay; a cancel on
  // 5 would void 50's money. Same class of bug the usage marker's brackets were
  // added to avoid. Every row ever written already carries the parens, so the
  // tighter pattern still matches the history.
  const reqMarker = `(leave_req#${requestId})`;
  const reqLike = `%${reqMarker}%`;

  // A request paid before this change carries one lump row and no usage marker.
  // Leave it alone — re-paying it per day would double-pay the employee.
  const legacy = await db.execute(sql`
    SELECT 1 FROM additional_pay
     WHERE company_id = ${companyId}
       AND notes LIKE ${reqLike}
       AND notes NOT LIKE '%[leave_usage:%'
       AND COALESCE(status,'pending') <> 'voided'
     LIMIT 1`);
  if (legacy.rows.length) return { paid: false, reason: "already paid (pre-per-day row)" };

  // The per-day truth: approval writes one usage row per calendar day, keyed on
  // this stable note prefix. date_used carries the day, hours the day's portion.
  const days = await db.execute(sql`
    SELECT u.id, to_char(u.date_used, 'YYYY-MM-DD') AS date_used, u.hours
      FROM employee_leave_usage u
     WHERE u.company_id = ${companyId}
       AND u.employee_id = ${Number(row.user_id)}
       AND u.notes LIKE ${`leave_request #${requestId} approved%`}
     ORDER BY u.date_used`);

  // No usage rows means the approval route changed shape underneath us. Pay the
  // request as one row rather than dropping it — but date it to the first day
  // off, never to the approval moment.
  const fallbackDay = String(row.start_date).slice(0, 10);
  const span = days.rows.length
    ? (days.rows as any[]).map(d => ({ id: Number(d.id), day: String(d.date_used), hours: Number(d.hours) }))
    : [{ id: null as number | null, day: fallbackDay, hours }];

  for (const d of span) {
    if (!(d.hours > 0)) continue;
    const dayAmount = Math.round(d.hours * rate * 100) / 100;
    const usageMarker = d.id === null ? "" : ` [leave_usage:${d.id}]`;
    const notes = `${row.display_name} leave approved ${reqMarker}${usageMarker} — ${d.hours.toFixed(2)}h × $${rate}/hr, ${d.day}`;
    // Guard on the usage id, because two paths can pay the same day: this one
    // and the office-deduct path (writeUsageLeavePay), which keys on the same
    // id. Without a usage row there is nothing finer to key on, so fall back to
    // the request marker — that branch writes at most one row anyway.
    const guardLike = d.id === null ? reqLike : `%[leave_usage:${d.id}]%`;
    // [pay-day 2026-08-17] effective_date = the day off. That is what this code
    // was always trying to say by back-dating created_at to noon on the leave
    // day — the column it needed didn't exist yet. Now it does, and it's the
    // only thing payroll windows on. created_at keeps the same value so the row
    // is unchanged for anything still reading it. See lib/pay-day.ts.
    await db.execute(sql`
      INSERT INTO additional_pay (company_id, user_id, type, amount, notes, status, created_at, effective_date)
      SELECT ${companyId}, ${Number(row.user_id)}, ${payType}, ${dayAmount.toFixed(2)}, ${notes}, 'pending',
             (${d.day} || ' 12:00:00')::timestamp, ${d.day}::date
       WHERE NOT EXISTS (
         SELECT 1 FROM additional_pay
          WHERE company_id = ${companyId}
            AND notes LIKE ${guardLike}
            AND COALESCE(status,'pending') <> 'voided'
       )`);
  }

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
 *
 * [leave-day 2026-08-17] Now voids every per-day row for the request in one
 * statement — they all carry the same `(leave_req#<id>)` marker. That marker,
 * not the usage id, is deliberately what this matches on: the cancel route
 * DELETEs the usage rows before it calls this, so a usage-keyed lookup would
 * find nothing and leave cancelled leave paid. Parenthesised so request 5
 * cannot void request 50's money.
 */
export async function voidApprovedLeavePay(
  companyId: number,
  requestId: number,
  voidedByUserId?: number | null,
): Promise<void> {
  const marker = `(leave_req#${requestId})`;
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
 *  - effective_date is stamped to the LEAVE DATE (date_used), not today —
 *    payroll windows additional_pay by its pay day, so the pay must land in the
 *    period that contains the day off (including back-dated entries), not the
 *    period it happened to be typed in.
 */
export async function writeUsageLeavePay(
  companyId: number,
  usageId: number,
): Promise<LeavePayResult> {
  const r = await db.execute(sql`
    SELECT u.employee_id, u.hours, u.date_used, u.notes AS usage_notes,
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
  const dateUsed = String(row.date_used).slice(0, 10);
  // [leave-day 2026-08-17] Carry the request marker forward when this usage day
  // came from an approval. The office "edit hours" path voids by usage id and
  // rewrites through here, so without this the rewritten row would lose its link
  // to the request — and a later cancel, which voids by `(leave_req#<id>)`,
  // would leave cancelled leave paid. Both markers now travel together no
  // matter which path last wrote the row.
  const reqId = String(row.usage_notes ?? "").match(/leave_request #(\d+) approved/)?.[1] ?? null;
  const reqSuffix = reqId ? ` (leave_req#${reqId})` : "";
  const notes = `${row.display_name} leave recorded ${marker}${reqSuffix} — ${hours.toFixed(2)}h × $${rate}/hr, ${dateUsed}`;

  // Insert only if no non-voided pay row already exists for this usage row.
  // [pay-day 2026-08-17] effective_date = the leave date, so the pay lands in
  // that day's payroll period regardless of when it was recorded. This used to
  // be done by back-dating created_at, which was the closest thing available
  // before the column existed; created_at still carries the same value.
  await db.execute(sql`
    INSERT INTO additional_pay (company_id, user_id, type, amount, notes, status, created_at, effective_date)
    SELECT ${companyId}, ${Number(row.employee_id)}, ${payType}, ${amount.toFixed(2)}, ${notes}, 'pending',
           (${dateUsed} || ' 12:00:00')::timestamp, ${dateUsed}::date
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
