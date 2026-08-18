import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { additionalPayTable } from "@workspace/db/schema";
import { DEFAULT_TZ, companyDateStr } from "./company-tz.js";

// ─────────────────────────────────────────────────────────────────────────────
// [pay-day 2026-08-17] Which day a money row belongs to.
//
// THE BUG
//
// `additional_pay` — tips, mileage, sick pay, PTO, cancellation pay, bonuses —
// had exactly one date on it: `created_at`, a `timestamp without time zone`
// defaulted to now() on a server whose clock is UTC. Every payroll and report
// window filtered on `created_at::date`, which reads that UTC wall clock as if
// it were a local calendar day.
//
// Central is UTC−5 (−6 in winter). So anything the office recorded after 7pm
// filed itself on TOMORROW. Record a $40 tip at 8pm Friday and it lands in next
// week's payroll. Nobody would ever catch it: the amount is right, the person
// is right, the week is wrong, and the two weeks net out.
//
// WHY THE OBVIOUS FIX IS WRONG
//
// The instinct is to convert on read — `created_at AT TIME ZONE 'UTC' AT TIME
// ZONE 'America/Chicago'` at every window (see lib/ct-day.ts, which is exactly
// right for genuine timestamps). Applied here it makes things WORSE. 82 of the
// 86 rows it would move are MaidCentral import rows stamped at literal
// midnight, where midnight IS the intended calendar date. Converting those
// shifts them a day BACKWARD. The fix would correct 4 rows and break 82.
//
// The reason is that `created_at` was carrying two different meanings — "the
// instant this row was typed" for live rows, "the day this money is for" for
// imported ones — and no single conversion is correct for both.
//
// THE FIX
//
// Split the meanings. `created_at` keeps meaning when the row was written.
// `effective_date` means the day the money belongs to, and it is the ONLY thing
// payroll windows on. Live inserts stamp it from the tenant's own calendar via
// companyDateStr(). Rows recorded after the fact — leave pay approved on
// Tuesday for a Friday off, a tip the office logs on Monday for the weekend —
// stamp the real day instead of today.
//
// Read through payDay()/payDayBetween() rather than the column directly. They
// COALESCE to `created_at::date`, so an insert path that has not been updated
// yet degrades to exactly today's behavior instead of silently dropping its
// money out of every window. That fallback is a safety net, not a licence — any
// new insert into additional_pay must stamp effective_date.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The pay day of an `additional_pay` row, as a SQL date.
 *
 * `alias` is the table alias in the surrounding raw-SQL statement ("ap", "a", …).
 * For Drizzle query-builder callers use payDayBetween() instead, which resolves
 * the columns itself.
 */
export function payDaySql(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`COALESCE(${a}.effective_date, (${a}.created_at)::date)`;
}

/**
 * `WHERE` fragment for a Drizzle query over additionalPayTable: the row's pay
 * day falls inside [from, to] inclusive. Both bounds are YYYY-MM-DD strings.
 *
 * This replaces the old `gte(created_at, new Date(from + "T00:00:00Z"))` /
 * `lte(created_at, new Date(to + "T23:59:59Z"))` pair, which had two faults at
 * once: it compared against UTC instants (the bug above) and its end bound
 * silently dropped anything in the final second of the day.
 */
export function payDayBetween(from: string, to: string): SQL {
  return sql`COALESCE(${additionalPayTable.effective_date}, (${additionalPayTable.created_at})::date) BETWEEN ${from} AND ${to}`;
}

/** Same thing, one day: the row pays out on `day`. */
export function payDayOn(day: string): SQL {
  return sql`COALESCE(${additionalPayTable.effective_date}, (${additionalPayTable.created_at})::date) = ${day}`;
}

/** …on or before `day`. Used by close-day, which sweeps everything up to today. */
export function payDayOnOrBefore(day: string): SQL {
  return sql`COALESCE(${additionalPayTable.effective_date}, (${additionalPayTable.created_at})::date) <= ${day}`;
}

/**
 * The pay day to stamp on a row being written right now: today on the tenant's
 * own wall clock, as YYYY-MM-DD.
 *
 * Use this wherever the old code let `created_at` default to now(). It is the
 * SAME day the office sees on their screen when they type the entry — which is
 * the whole fix, since now() on a UTC server is already tomorrow after 7pm
 * Central.
 *
 * Where the row is genuinely FOR another day — a leave day, a job's service
 * date, an entry the office is backdating — stamp that day instead. Only reach
 * for this when "today" is the honest answer.
 */
export function payDayNow(companyId: number, at: Date = new Date()): string {
  return companyDateStr(companyId, at);
}

/**
 * Add the column. Idempotent, safe to re-run, runs in every environment —
 * schema shape, not data.
 */
export async function ensurePayDayColumn(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE additional_pay ADD COLUMN IF NOT EXISTS effective_date date`);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS idx_additional_pay_effective_day ON additional_pay (company_id, effective_date)`,
    );
  } catch (err) {
    console.error("[pay-day] ensure column failed:", err);
    throw err;
  }
}

/**
 * Fill effective_date on rows written before the column existed.
 *
 * Deliberately narrow, and it only ever touches rows where effective_date IS
 * NULL — so it converges after one run and can never re-process a row the
 * office has since corrected. It cannot resurrect anything either: it writes
 * one column on rows that already exist and inserts nothing.
 *
 * Three cases, and getting them apart is the whole point:
 *
 *   a leave row — sick_pay / pto written by lib/leave-pay.ts, whose note ends in
 *     the day off ("… 8.00h × $20/hr, 2026-08-03"). That trailing date IS the
 *     pay day; it is what new rows now stamp, so the history should agree. Only
 *     taken when the note ends in a real YYYY-MM-DD, otherwise fall through.
 *
 *   created_at at exactly 00:00:00 — a MaidCentral import row. Midnight is not
 *     a real clock reading, it is a date with no time. Take the date as-is.
 *
 *   anything else — a live row, a real UTC instant. Convert it to the tenant's
 *     own calendar day (pin to UTC first, then convert; declaring it Central
 *     directly shifts it the wrong way — see lib/ct-day.ts).
 *
 * All three are subordinate to the published-week lock below: a week the office
 * has already paid never gets rewritten, whatever the other rules say.
 *
 * Dry-run against Phes production, 2026-08-17: 175 rows, of which 2 change day
 * — both voided June cancellation rows worth $0 in payroll. Not one live row
 * moves out of the week it was paid in.
 */
export async function backfillPayDay(): Promise<void> {
  // A week that has been published is a week that has been PAID — the office
  // typed those numbers into ADP. Correcting a row's day inside one of those
  // weeks would move money the employee has already received into a week that
  // still looks owed. So a published week is locked: the row keeps the day it
  // was filed under, right or wrong, and the correction only applies going
  // forward. (Live example this guard exists for: a $100 PLAWA row filed
  // 2026-07-23 for a day off on 07-28, published and paid in the 07-19..07-25
  // check on 07-31.)
  const locked = (await db.execute(sql`SELECT to_regclass('public.payroll_period_snapshots') IS NOT NULL AS ok`))
    .rows[0] as any;
  const notPublished = locked?.ok
    ? sql`AND NOT EXISTS (
            SELECT 1 FROM payroll_period_snapshots s
             WHERE s.company_id = additional_pay.company_id
               AND s.user_id = additional_pay.user_id
               AND (additional_pay.created_at)::date BETWEEN s.pay_period_start AND s.pay_period_end)`
    : sql``;

  // The leave pass runs first and on its own, so a single unparseable note can
  // never take the general pass down with it. The regex only accepts a real
  // calendar shape; to_date on top of that is the belt to its braces, and any
  // row that still fails simply falls through to the general pass below.
  try {
    const r = await db.execute(sql`
      UPDATE additional_pay
         SET effective_date = to_date(right(notes, 10), 'YYYY-MM-DD')
       WHERE effective_date IS NULL
         AND type IN ('sick_pay', 'pto')
         AND notes ~ '[, ][0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
         ${notPublished}`);
    const n = (r as any).rowCount ?? 0;
    if (n > 0) console.log(`[pay-day] backfilled ${n} leave row(s) to the day off`);
  } catch (err) {
    console.error("[pay-day] leave-date backfill failed (non-fatal):", err);
  }

  try {
    const r = await db.execute(sql`
      UPDATE additional_pay
         SET effective_date = CASE
               WHEN (additional_pay.created_at)::time = TIME '00:00:00'
                 THEN (additional_pay.created_at)::date
               ELSE ((additional_pay.created_at) AT TIME ZONE 'UTC'
                       AT TIME ZONE COALESCE(c.timezone, ${DEFAULT_TZ}))::date
             END
        FROM companies c
       WHERE c.id = additional_pay.company_id
         AND additional_pay.effective_date IS NULL
         ${notPublished}`);
    const n = (r as any).rowCount ?? 0;
    if (n > 0) console.log(`[pay-day] backfilled effective_date on ${n} additional_pay row(s)`);
  } catch (err) {
    // Non-fatal: the read helpers COALESCE, so an unbackfilled row keeps its
    // previous behavior rather than falling out of payroll.
    console.error("[pay-day] backfill failed (non-fatal):", err);
  }

  // Anything left is a row inside a published week. Write the day it was
  // actually filed under — byte-identical to what payroll has always read for
  // it — so the column is complete and nothing depends on the COALESCE to keep
  // a paid row in its paid week.
  try {
    const r = await db.execute(sql`
      UPDATE additional_pay SET effective_date = (created_at)::date WHERE effective_date IS NULL`);
    const n = (r as any).rowCount ?? 0;
    if (n > 0) console.log(`[pay-day] pinned ${n} already-published row(s) to their filed day`);
  } catch (err) {
    console.error("[pay-day] published-row pin failed (non-fatal):", err);
  }
}
