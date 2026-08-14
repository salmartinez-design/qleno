// [ANY(array) trap] One place to build an IN list, so nobody has to remember
// the rule again.
//
// Drizzle's `sql` template does NOT bind a JS array as a single array
// parameter — it spreads the elements into separate placeholders. So
// `= ANY(${ids}::int[])` emits:
//
//   one element   → ANY(($2)::int[])        malformed array literal: "9099"
//   two elements  → ANY(($2,$3)::int[])     cannot cast type record to integer[]
//   zero elements → ANY(()::int[])          syntax error
//
// It throws at every length. There is no input for which that pattern works.
//
// It has now bitten this codebase eight times: the Add Tech picker (users.ts,
// 6/12), the SMS thread (sms.ts), Heritage's Consolidate button
// (invoice-billing.ts, 8/3), the account communications log, the efficiency
// sweep, push-token cleanup and a cold-start password reset (all 8/12) — and
// worst of all, the final_pay override lookups on both payroll surfaces plus
// the dashboard, where the throw is swallowed by a catch and every hand-set
// pay override is silently dropped from the numbers.
//
// Comments in the files did not stop it recurring. A helper might: the fix and
// the safe pattern are now the same short call.
import { sql, type SQL } from "drizzle-orm";

/**
 * An expanded, parameterized list for `IN (...)`.
 *
 * Returns null for an empty input — an empty `IN ()` is a syntax error, so the
 * caller must decide what "no values" means. Usually that is skipping the
 * query, or substituting FALSE:
 *
 *   const list = inList(ids);
 *   if (!list) return [];                       // nothing to look up
 *   sql`WHERE job_id IN (${list})`
 *
 *   // or, inside a bigger predicate:
 *   const match = list ? sql`job_id IN (${list})` : sql`FALSE`;
 */
export function inList(values: Array<number | string>): SQL | null {
  if (!values.length) return null;
  return sql.join(values.map(v => sql`${v}`), sql`, `);
}

/**
 * Same, coercing to numbers first so nothing but a number can reach the query.
 * Non-finite entries are dropped rather than silently becoming NULL.
 */
export function inIntList(values: Array<number | string>): SQL | null {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return sql.join(nums.map(n => sql`${n}`), sql`, `);
}
