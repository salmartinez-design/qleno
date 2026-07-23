import { sql, type SQL } from "drizzle-orm";

/**
 * [ct-day 2026-07-23] Central-day bucketing for our naive timestamp columns.
 *
 * Every audit stamp in this schema (`jobs.created_at`, `leads.booked_at`,
 * `timeclock.clock_in_at`, …) is `timestamp WITHOUT time zone` holding a UTC
 * instant — Drizzle's `defaultNow()` on a UTC Postgres server. The value
 * carries no offset, so Postgres will happily reinterpret it as any zone you
 * name.
 *
 * That's the trap. `created_at AT TIME ZONE 'America/Chicago'` does NOT convert
 * UTC to Central — it *declares* the naive value to already BE Central and
 * hands back the UTC instant, shifting it +5h. Anything stamped after 7:00 PM
 * UTC (2:00 PM Central) then buckets into tomorrow. That's how the dashboard's
 * "Booked today" tile read 5 at 7:44 AM on a day when nothing had been booked:
 * it was counting five jobs sold between 4:10 and 5:29 PM the previous
 * afternoon.
 *
 * The correct read is a two-step: pin the naive value to UTC, THEN convert.
 * Use `ctDate()` for a stored column and `ctToday()` for the current Central
 * day — `now()` is already `timestamptz`, so it takes the single-step form and
 * must NOT be routed through `ctDate()`.
 *
 * Date columns (`jobs.scheduled_date`) need neither; they're calendar dates
 * with no instant behind them. Compare them to `ctToday()` directly.
 */
export const ctDate = (col: SQL | unknown): SQL =>
  sql`((${col}) AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')::date`;

/** Today's calendar date in Central. `now()` is timestamptz — single step. */
export const ctToday = (): SQL => sql`(now() AT TIME ZONE 'America/Chicago')::date`;

/**
 * The Central calendar date, as `YYYY-MM-DD`, for JS-side window building.
 *
 * `new Date().toISOString().split("T")[0]` is the wrong tool: it yields the UTC
 * date, which rolls over at 7:00 PM Central. A dashboard opened at 8 PM would
 * quietly start reporting tomorrow's board.
 */
export function ctDateStr(at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(at);
}
