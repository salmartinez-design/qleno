import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [reporting-floor 2026-08-17] Phes ran on MaidCentral until 2026-07-01 and
// only partially entered work in Qleno before that, so Qleno's own tables are
// NOT a record of pre-cutover trading. What is in there is a mixture: Jan–Mar
// 2026 was imported twice (per-job AND as 80 daily rollup rows on the
// "MaidCentral Historical Import" client, which double-counted $155,970), May
// is 98% absent, and June is short ~$17,900 against MaidCentral's own figure.
// Any total drawn across that boundary is wrong in a direction that changes
// with the month, which is worse than being absent.
//
// `companies.invoice_cutover_date` already means exactly this — its own comment
// says work before it "must never surface in an uninvoiced queue, auto-invoice
// on completion, or count toward revenue here." Billing has honored it since
// 2026-08-05; reports never did. Reusing it keeps ONE cutover date per tenant
// rather than a second one that can drift out of step. All four tenants are
// already set to 2026-07-01, so this needs no migration and no data write.
//
// Sal, 2026-08-17: "we did not fully use Qleno until July 1 do not count any
// june revenue from qleno it would be from MC history."
//
// Scope: money and hours totalled over a date range. NOT applied to customer-
// history reports (cancellations, redos, tickets, scorecards, upsell) — a
// client's behavior before July is real and belongs in their history — and not
// to snapshots with no range (receivables, hot sheet, first-time).
//
// [dashboard-parity 2026-08-17] Lifted out of routes/reports.ts so the
// dashboard can apply the SAME rule. It could not before, and the 12-month
// revenue chart read `job_history` instead — a ledger whose MaidCentral half
// stops at 2026-04-25 and whose live half only mirrors COMPLETED jobs. On co1
// that chart was $125,010.77 light across the twelve months it drew (May 2026
// rendered as $1,535 against MaidCentral's $74,236.42), and it feeds the YTD
// figure on the front page. One rule, one set of numbers, both screens.
function parseF(v: any) { return parseFloat(v || "0"); }

const floorCache = new Map<number, { v: string | null; at: number }>();
const FLOOR_TTL_MS = 5 * 60 * 1000;

/** The tenant's `companies.invoice_cutover_date` as YYYY-MM-DD, or null. */
export async function reportingFloor(companyId: number): Promise<string | null> {
  const hit = floorCache.get(companyId);
  if (hit && Date.now() - hit.at < FLOOR_TTL_MS) return hit.v;
  const r = await db.execute(sql`
    SELECT to_char(invoice_cutover_date, 'YYYY-MM-DD') AS d
      FROM companies WHERE id = ${companyId} LIMIT 1`);
  const v = ((r.rows?.[0] as any)?.d as string) ?? null;
  floorCache.set(companyId, { v, at: Date.now() });
  return v;
}

export interface RangeClamp {
  requested_from: string;
  effective_from: string;
  floor: string;
  /** The whole requested window predates the cutover — there is nothing to show. */
  entire_range_before: boolean;
}

// Returns the from-date to actually query, plus a clamp descriptor when the
// caller asked for something earlier. When the ENTIRE window is pre-cutover the
// clamped from lands after `to`, so every BETWEEN returns zero rows on its own —
// the report renders empty with the notice rather than a fabricated total.
export async function clampFrom(companyId: number, fromStr: string, toStr: string):
  Promise<{ fromStr: string; clamp: RangeClamp | null }> {
  const floor = await reportingFloor(companyId);
  if (!floor || fromStr >= floor) return { fromStr, clamp: null };
  return {
    fromStr: floor,
    clamp: { requested_from: fromStr, effective_from: floor, floor, entire_range_before: toStr < floor },
  };
}

// [mc-revenue-history 2026-08-17] The floor above stops Qleno reporting revenue
// it doesn't have. This fills the hole it leaves: MaidCentral's month totals for
// the period before the cutover, so asking for the year returns the year.
//
// Sal, 2026-08-17: "for May and June we have to follow MaidCentral and add the
// revenue into Qleno, we were still using MaidCentral then." MaidCentral is the
// authoritative record for everything before 2026-07-01 — including the months
// where Qleno's own tables happen to hold something, because what they hold is
// partial (May is 98% absent, June is ~$17,900 short).
//
// MONTH TOTALS ONLY. There is no job, client or employee detail behind these
// figures, so they belong to revenue history and nothing else. Job costing,
// client profitability, payroll and commission all stay floored — a margin or a
// commission split cannot be computed from a monthly number, and inventing one
// would be exactly the fabrication the reporting rules forbid.
export interface HistoricalMonth {
  month: string;          // YYYY-MM
  revenue: number;
  source: string;         // 'maidcentral'
}

export interface HistoricalRevenue {
  months: HistoricalMonth[];
  total: number;
  source: string;
  /** Last day this historical series covers — the day before the cutover. */
  through: string;
}

// Months from `fromStr` up to (not including) the cutover, for a company that
// has one. Only 'actual' rows count: MaidCentral's own 'partial' July overlaps
// Qleno's live July, and its 'projected' months were never delivered.
//
// A month is included only when it sits ENTIRELY inside the requested window.
// These are month totals with no day detail, so a half-requested month cannot
// be apportioned; counting it whole would overstate the range the operator
// actually asked for. Real queries start on a month boundary, so this is the
// same answer in practice — it just refuses to guess when they don't.
export async function historicalRevenue(
  companyId: number, fromStr: string, toStr: string, floor: string,
): Promise<HistoricalRevenue | null> {
  const end = toStr < floor ? toStr : floor;   // never past the cutover
  const r = await db.execute(sql`
    SELECT to_char(month, 'YYYY-MM') AS month,
           total_revenue AS revenue,
           source
      FROM mc_revenue_history
     WHERE company_id = ${companyId}
       AND revenue_type = 'actual'
       AND month >= ${fromStr}::date
       AND (month + interval '1 month') <= ${end}::date
     ORDER BY month`);
  const months = (r.rows as any[]).map(m => ({
    month: m.month as string, revenue: parseF(m.revenue), source: m.source as string,
  }));
  if (!months.length) return null;
  return {
    months,
    total: Math.round(months.reduce((s, m) => s + m.revenue, 0) * 100) / 100,
    source: months[0].source,
    through: end,
  };
}

/**
 * Does this tenant have ANY MaidCentral history at all? A fresh tenant has
 * none, and for it the cutover date is meaningless as a revenue boundary —
 * its own jobs table IS the whole record, from day one. Callers use this to
 * decide between "merge MC before the cutover" and "just read live jobs".
 */
export async function hasHistoricalRevenue(companyId: number): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM mc_revenue_history
     WHERE company_id = ${companyId} AND revenue_type = 'actual' LIMIT 1`);
  return (r.rows?.length ?? 0) > 0;
}

/**
 * MaidCentral month totals keyed by YYYY-MM, for the months strictly BEFORE
 * the cutover that fall inside [fromMonth, toMonth] (both YYYY-MM inclusive).
 * A month with no MaidCentral row is simply absent from the map — the caller
 * renders it as unavailable, never as zero.
 *
 * The boundary is the cutover MONTH: the cutover month itself and everything
 * after it comes from live jobs. All four tenants cut over on the 1st, so that
 * is exact. A mid-month cutover would need MaidCentral to be split by day and
 * it cannot be — the caller would be reading part of a month from each side.
 * If one is ever set, split it here deliberately rather than letting this
 * silently attribute the whole month to Qleno.
 */
export async function historicalMonthMap(
  companyId: number, fromMonth: string, toMonth: string, floor: string,
): Promise<Map<string, number>> {
  const floorMonth = floor.slice(0, 7);           // cutover month, exclusive
  const end = toMonth < floorMonth ? toMonth : floorMonth;
  const r = await db.execute(sql`
    SELECT to_char(month, 'YYYY-MM') AS month, total_revenue AS revenue
      FROM mc_revenue_history
     WHERE company_id = ${companyId}
       AND revenue_type = 'actual'
       AND to_char(month, 'YYYY-MM') >= ${fromMonth}
       AND to_char(month, 'YYYY-MM') < ${end}`);
  return new Map((r.rows as any[]).map(m => [m.month as string, parseF(m.revenue)]));
}
