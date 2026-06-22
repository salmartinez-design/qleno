/**
 * Paid-leave PENDING forecast (read-only office signal).
 *
 * Approved paid leave now AUTO-PAYS at approval (see lib/leave-pay.ts) as a
 * real `additional_pay` line, so it already shows on the payroll summary.
 * To avoid double-counting, this endpoint forecasts only PENDING (not-yet-
 * approved) paid requests in a window — "what payroll would add if these
 * are approved" — at the flat $20/hr leave rate. Read-only; writes nothing.
 *
 * Unpaid Personal is excluded (is_paid = false → no dollars). Holiday is a
 * separate benefit, not a leave_types bucket, so it never appears here.
 */
import { db } from "@workspace/db";
import {
  leaveRequestsTable,
  leaveTypesTable,
  usersTable,
} from "@workspace/db/schema";
import { and, eq, gte, lte } from "drizzle-orm";
import { LEAVE_PAY_RATE } from "./leave-pay.js";

export type LeavePayPreviewRow = {
  user_id: number;
  name: string;
  slug: string;
  bucket: string;
  pending_hours: number;
  hourly_rate: number;
  amount: number;
};

export type LeavePayPreview = {
  rows: LeavePayPreviewRow[];
  total: number;
  rate: number;
  note: string;
};

/** Forecast pending paid-leave dollars for [from, to] (YYYY-MM-DD),
 *  attributed by start_date. Flat $20/hr. */
export async function computeLeavePayPreview(
  companyId: number,
  from: string,
  to: string,
): Promise<LeavePayPreview> {
  const reqs = await db
    .select({
      user_id: leaveRequestsTable.user_id,
      hours: leaveRequestsTable.hours,
      slug: leaveTypesTable.slug,
      bucket: leaveTypesTable.display_name,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
    })
    .from(leaveRequestsTable)
    .innerJoin(
      leaveTypesTable,
      eq(leaveRequestsTable.leave_type_id, leaveTypesTable.id),
    )
    .innerJoin(usersTable, eq(leaveRequestsTable.user_id, usersTable.id))
    .where(
      and(
        eq(leaveRequestsTable.company_id, companyId),
        eq(leaveRequestsTable.status, "pending"),
        eq(leaveTypesTable.is_paid, true),
        gte(leaveRequestsTable.start_date, from),
        lte(leaveRequestsTable.start_date, to),
      ),
    );

  const agg = new Map<
    string,
    { user_id: number; name: string; slug: string; bucket: string; hours: number }
  >();
  for (const r of reqs) {
    const key = `${r.user_id}:${r.slug}`;
    const cur =
      agg.get(key) ??
      {
        user_id: r.user_id,
        name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
        slug: r.slug,
        bucket: r.bucket,
        hours: 0,
      };
    cur.hours += Number(r.hours);
    agg.set(key, cur);
  }

  const rows: LeavePayPreviewRow[] = [];
  for (const a of agg.values()) {
    const hours = Math.round(a.hours * 100) / 100;
    rows.push({
      user_id: a.user_id,
      name: a.name,
      slug: a.slug,
      bucket: a.bucket,
      pending_hours: hours,
      hourly_rate: LEAVE_PAY_RATE,
      amount: Math.round(hours * LEAVE_PAY_RATE * 100) / 100,
    });
  }
  rows.sort((x, y) => x.name.localeCompare(y.name) || x.slug.localeCompare(y.slug));

  const total = rows.reduce((s, r) => s + r.amount, 0);
  return {
    rows,
    total: Math.round(total * 100) / 100,
    rate: LEAVE_PAY_RATE,
    note: `Forecast of PENDING paid-leave requests at $${LEAVE_PAY_RATE}/hr. Approved leave already auto-pays on the payroll summary; this is the not-yet-approved pipeline. Attributed by start_date.`,
  };
}
