// [tenant-billing 2026-08-05] The billing cutover, per tenant.
//
// A tenant migrating from another system (Phes from MaidCentral) already
// invoiced and collected everything before its go-live date. That work must
// never surface in an uninvoiced queue, never auto-invoice on completion, and
// never count toward revenue here — otherwise the customer gets billed twice
// for the same clean, once by each system.
//
// This lived as `INVOICE_CUTOVER_DATE = "2026-07-01"` in ensure-invoice.ts and
// was imported into eight billing queries. That is one tenant's migration date
// compiled into the product:
//   - a tenant onboarding in 2027 inherits a 2026 floor that means nothing to
//     them (harmless today, arbitrary forever);
//   - a tenant going live BEFORE that date silently loses its own history from
//     every queue, with no error and nothing to grep for;
//   - and nobody can change it without a deploy.
//
// It is now companies.invoice_cutover_date. NULL = no prior system, bill
// everything — the correct default for a clean-slate tenant.
//
// WHY A SQL FRAGMENT, not an async lookup: every consumer is a WHERE clause.
// Reading the column inline keeps the floor atomic with the query it guards
// (no cache to go stale, no await to thread through a query builder) and costs
// a trivially-cached subquery. The JS form exists for the one caller that
// branches in application code.
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/**
 * The floor itself, as a scalar subquery. NULL cutover → year 1, i.e. no floor.
 *
 * `'0001-01-01'` rather than a NULL comparison on purpose: `col >= NULL` is
 * NULL, which is falsy, so a clean-slate tenant would match NOTHING and their
 * whole queue would silently empty. That failure mode reads exactly like
 * "everything is invoiced," which is the worst possible way to be wrong here.
 */
export const cutoverDate = (companyId: number | string) => sql`
  COALESCE(
    (SELECT c.invoice_cutover_date FROM companies c WHERE c.id = ${companyId}),
    '0001-01-01'::date
  )`;

/**
 * `<dateColumn> >= <this tenant's cutover>`. Drop straight into a WHERE.
 *
 *   .where(and(eq(jobsTable.company_id, companyId),
 *              onOrAfterCutover(companyId, jobsTable.scheduled_date)))
 */
export const onOrAfterCutover = (companyId: number | string, dateColumn: any) =>
  sql`${dateColumn} >= ${cutoverDate(companyId)}`;

/**
 * The raw value for application-code branching, as 'YYYY-MM-DD' or null.
 * Prefer the SQL forms — this exists for ensure-invoice, which decides whether
 * to create an invoice at all and is already holding the company row.
 */
export async function getInvoiceCutoverDate(companyId: number): Promise<string | null> {
  const r: any = await db.execute(sql`
    SELECT invoice_cutover_date::text AS d FROM companies WHERE id = ${companyId} LIMIT 1`);
  return r.rows?.[0]?.d ?? null;
}

/**
 * Is this service date before the tenant's cutover (i.e. the prior system's to
 * bill)? A null cutover means no prior system, so nothing is ever before it.
 */
export function isBeforeCutover(serviceDate: string | null, cutover: string | null): boolean {
  if (!serviceDate || !cutover) return false;
  return String(serviceDate).slice(0, 10) < String(cutover).slice(0, 10);
}
