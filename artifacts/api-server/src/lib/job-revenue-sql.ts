import { sql, type SQL } from "drizzle-orm";

/**
 * Canonical per-job revenue expression for SQL aggregations, mirroring the
 * dispatch board's live `amount` (routes/dispatch.ts). Commercial work — an
 * account job OR a commercial client — that carries an hourly rate and
 * allowed hours bills `hourly_rate × allowed_hours`, matching how MaidCentral
 * invoices. Everything else uses the caller's existing `fallback` expression,
 * so residential totals are unchanged.
 *
 * The surrounding query must expose the jobs table under `jobsAlias` and a
 * LEFT JOIN clients under `clientsAlias` (commercial detection reads
 * clients.client_type for commercial clients that have no account_id).
 */
export function jobRevenueExpr(fallback: SQL, jobsAlias = "j", clientsAlias = "c"): SQL {
  const j = sql.raw(jobsAlias);
  const c = sql.raw(clientsAlias);
  return sql`CASE
    WHEN ${j}.billed_amount IS NOT NULL AND CAST(${j}.billed_amount AS NUMERIC) > 0
    THEN CAST(${j}.billed_amount AS NUMERIC)
    WHEN (${j}.account_id IS NOT NULL OR ${c}.client_type = 'commercial')
         AND ${j}.hourly_rate IS NOT NULL AND ${j}.allowed_hours IS NOT NULL
         AND CAST(${j}.hourly_rate AS NUMERIC) > 0 AND CAST(${j}.allowed_hours AS NUMERIC) > 0
    THEN CAST(${j}.hourly_rate AS NUMERIC) * CAST(${j}.allowed_hours AS NUMERIC)
    ELSE ${fallback}
  END`;
}
