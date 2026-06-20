/**
 * Paid-leave payroll PREVIEW — review-gated, never auto-paid.
 *
 * Mirrors the mileage/OT philosophy in CLAUDE.md: "No money moves
 * automatically — the banner surfaces the estimate; the office pays it via
 * the normal additional-pay flow." This computes, for a pay window, the
 * dollar value of APPROVED paid leave (PLAWA / PTO — buckets with
 * leave_types.is_paid = true) as hours × hourly rate, and returns it as a
 * non-binding preview. It does NOT write additional_pay, does NOT touch
 * grand_total, and is read-only.
 *
 * Rate resolution (centralized — no inline literals, per the
 * "never hardcode the rate" rule):
 *   1. employee_pay_rates — the dated canonical hourly rate in effect for
 *      the window (latest effective_date <= window end, not yet ended).
 *   2. companies.commercial_hourly_rate — the only other concrete hourly
 *      figure on file (default $20), used as a documented fallback.
 *   3. none — no rate on file; amount is null and the office must set one.
 * The chosen source is returned as `rate_source` so the office sees
 * exactly where each number came from. (Which rate Phes pays leave at is a
 * Sal sign-off question — see the design doc.)
 *
 * Unpaid Personal leave is excluded (is_paid = false → no dollars).
 * Holiday is a separate benefit, not a leave_types bucket, so it never
 * appears here.
 */
import { db } from "@workspace/db";
import {
  leaveRequestsTable,
  leaveTypesTable,
  usersTable,
  employeePayRatesTable,
} from "@workspace/db/schema";
import { and, eq, gte, lte, desc, sql } from "drizzle-orm";

export type LeavePayPreviewRow = {
  user_id: number;
  name: string;
  slug: string;
  bucket: string;
  approved_hours: number;
  hourly_rate: number | null;
  rate_source: "employee_pay_rates" | "company_default" | "none";
  amount: number | null;
};

export type LeavePayPreview = {
  rows: LeavePayPreviewRow[];
  total: number;
  note: string;
};

async function resolveCompanyDefaultHourly(
  companyId: number,
): Promise<number | null> {
  try {
    const r = await db.execute(
      sql`SELECT commercial_hourly_rate FROM companies WHERE id = ${companyId} LIMIT 1`,
    );
    const v = (r.rows[0] as any)?.commercial_hourly_rate;
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}

async function resolveEmployeeHourly(
  companyId: number,
  userId: number,
  asOf: string,
): Promise<number | null> {
  const rows = await db
    .select({ rate: employeePayRatesTable.hourly_rate })
    .from(employeePayRatesTable)
    .where(
      and(
        eq(employeePayRatesTable.company_id, companyId),
        eq(employeePayRatesTable.user_id, userId),
        lte(employeePayRatesTable.effective_date, asOf),
      ),
    )
    .orderBy(desc(employeePayRatesTable.effective_date))
    .limit(1);
  return rows[0]?.rate != null ? Number(rows[0].rate) : null;
}

/** Compute the paid-leave preview for [from, to] (YYYY-MM-DD). Requests
 *  are attributed by start_date falling in the window — a request that
 *  straddles two pay periods lands wholly in the period of its start
 *  (flagged in `note`; refine if Sal wants day-level splitting). */
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
        eq(leaveRequestsTable.status, "approved"),
        eq(leaveTypesTable.is_paid, true),
        gte(leaveRequestsTable.start_date, from),
        lte(leaveRequestsTable.start_date, to),
      ),
    );

  // Aggregate hours per (user, bucket).
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

  const companyDefault = await resolveCompanyDefaultHourly(companyId);
  const rateCache = new Map<number, number | null>();

  const rows: LeavePayPreviewRow[] = [];
  for (const a of agg.values()) {
    let rate = rateCache.get(a.user_id);
    if (rate === undefined) {
      rate = await resolveEmployeeHourly(companyId, a.user_id, to);
      rateCache.set(a.user_id, rate);
    }
    let hourly: number | null;
    let source: LeavePayPreviewRow["rate_source"];
    if (rate != null) {
      hourly = rate;
      source = "employee_pay_rates";
    } else if (companyDefault != null) {
      hourly = companyDefault;
      source = "company_default";
    } else {
      hourly = null;
      source = "none";
    }
    const hours = Math.round(a.hours * 100) / 100;
    rows.push({
      user_id: a.user_id,
      name: a.name,
      slug: a.slug,
      bucket: a.bucket,
      approved_hours: hours,
      hourly_rate: hourly,
      rate_source: source,
      amount: hourly != null ? Math.round(hours * hourly * 100) / 100 : null,
    });
  }
  rows.sort((x, y) => x.name.localeCompare(y.name) || x.slug.localeCompare(y.slug));

  const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  return {
    rows,
    total: Math.round(total * 100) / 100,
    note: "Preview only — review-gated. Not added to gross pay; the office pays approved leave via the normal additional-pay flow. Requests attributed by start_date.",
  };
}
