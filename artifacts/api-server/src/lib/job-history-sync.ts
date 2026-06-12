/**
 * [revenue-connect 2026-06-12] job_history live bridge.
 *
 * job_history is the revenue ledger every reporting surface reads (dashboard
 * weekly forecast actuals, business health rate-trend/avg-bill, payroll %
 * KPI denominator, prior-year chart, client last-service/job-history). It
 * was only ever written by the MaidCentral import, so it froze at the MC
 * cutover and every reader showed $0 for post-cutover weeks while the
 * payroll page (live jobs table) showed real numbers.
 *
 * This bridge mirrors COMPLETED jobs from the live jobs table into the
 * ledger, per company, strictly AFTER that company's MC-ledger end date
 * (MAX(job_date) of rows with qleno_job_id IS NULL). The cutoff prevents
 * double-counting the transition window where the same job exists in both
 * the MC ledger and the jobs table, and keeps the known Jan–Mar jobs-table
 * corruption out of trend windows — MC rows stay canonical for their era,
 * live jobs are canonical after it. Companies with no MC rows (fresh Qleno
 * tenants) mirror their full completed history.
 *
 * Revenue uses the canonical jobRevenueExpr (commercial hourly×allowed wins
 * over the stale billed_amount cache, then billed_amount, then base_fee) so
 * ledger revenue matches the dispatch board and mobile cards.
 *
 * Idempotent + self-healing: re-runs insert only unmirrored jobs, update
 * mirrored rows that drifted (rebilled / rescheduled / reassigned), and
 * delete mirrored rows whose job is no longer complete. MC rows
 * (qleno_job_id IS NULL) are never touched.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { jobRevenueExpr } from "./job-revenue-sql.js";

export async function ensureJobHistoryLiveBridgeSchema(): Promise<void> {
  await db.execute(sql.raw(`ALTER TABLE job_history ADD COLUMN IF NOT EXISTS qleno_job_id integer`));
  await db.execute(sql.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_job_history_qleno_job
       ON job_history(qleno_job_id) WHERE qleno_job_id IS NOT NULL`,
  ));
}

export async function syncJobHistoryLiveBridge(): Promise<{ inserted: number; updated: number; removed: number }> {
  const rev = sql`ROUND(COALESCE(${jobRevenueExpr(sql`CAST(j.base_fee AS NUMERIC)`)}, 0), 2)`;
  const techName = sql`NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '')`;

  const ins = await db.execute(sql`
    WITH mc_end AS (
      SELECT company_id, MAX(job_date) AS ledger_end
        FROM job_history
       WHERE qleno_job_id IS NULL
       GROUP BY company_id
    )
    INSERT INTO job_history (company_id, customer_id, job_date, revenue, service_type, technician, qleno_job_id)
    SELECT j.company_id, j.client_id, j.scheduled_date, ${rev}, j.service_type::text, ${techName}, j.id
      FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN users u ON u.id = j.assigned_user_id
      LEFT JOIN mc_end m ON m.company_id = j.company_id
     WHERE j.status = 'complete'
       AND j.scheduled_date IS NOT NULL
       AND (m.ledger_end IS NULL OR j.scheduled_date > m.ledger_end)
       AND NOT EXISTS (SELECT 1 FROM job_history jh WHERE jh.qleno_job_id = j.id)
  `);

  const upd = await db.execute(sql`
    UPDATE job_history jh
       SET customer_id  = src.client_id,
           job_date     = src.scheduled_date,
           revenue      = src.rev,
           service_type = src.service_type,
           technician   = src.tech
      FROM (
        SELECT j.id, j.client_id, j.scheduled_date, ${rev} AS rev,
               j.service_type::text AS service_type, ${techName} AS tech
          FROM jobs j
          LEFT JOIN clients c ON c.id = j.client_id
          LEFT JOIN users u ON u.id = j.assigned_user_id
         WHERE j.status = 'complete' AND j.scheduled_date IS NOT NULL
      ) src
     WHERE jh.qleno_job_id = src.id
       AND (jh.customer_id  IS DISTINCT FROM src.client_id
         OR jh.job_date     IS DISTINCT FROM src.scheduled_date
         OR jh.revenue      IS DISTINCT FROM src.rev
         OR jh.service_type IS DISTINCT FROM src.service_type
         OR jh.technician   IS DISTINCT FROM src.tech)
  `);

  const del = await db.execute(sql`
    DELETE FROM job_history jh
     WHERE jh.qleno_job_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
          WHERE j.id = jh.qleno_job_id
            AND j.status = 'complete'
            AND j.scheduled_date IS NOT NULL
       )
  `);

  return {
    inserted: (ins as any)?.rowCount ?? 0,
    updated: (upd as any)?.rowCount ?? 0,
    removed: (del as any)?.rowCount ?? 0,
  };
}
