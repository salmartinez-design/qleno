import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * P0 payroll engine — idempotent schema setup. Follows the repo's cold-start
 * "ensure" convention (ALTER/CREATE … IF NOT EXISTS), wired into index.ts
 * startup. Safe to re-run. Adds:
 *
 *  1. companies.payroll_hours_basis — per-tenant default paid-hours basis for
 *     hourly techs: 'actual_clocked' | 'allowed_hours' | 'greater_of'.
 *     Default 'greater_of' (confirmed company default). The /detail engine
 *     reads it; absence falls back to greater_of in code, so this is purely
 *     to make the setting tenant-editable.
 *
 *  2. payroll_hours_overrides — office hand-adjusted PAID HOURS for a specific
 *     (tech, job). HOURS only, never dollars (dollar overrides remain on
 *     job_technicians.final_pay). Keyed on (company_id, user_id, job_id) so it
 *     works even for jobs with no job_technicians row (e.g. a tech who clocked
 *     a job they weren't rostered on). This is Sal's "sometimes hourly,
 *     sometimes allowed" lever and how MC's hand-adjusted jobs get matched.
 */
export async function ensurePayrollP0Setup(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS payroll_hours_basis text NOT NULL DEFAULT 'greater_of'`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS payroll_hours_overrides (
        id serial PRIMARY KEY,
        company_id integer NOT NULL,
        user_id integer NOT NULL,
        job_id integer NOT NULL,
        paid_hours numeric(6,2) NOT NULL,
        note text,
        created_by_user_id integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payroll_hours_overrides_uniq UNIQUE (company_id, user_id, job_id)
      )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_payroll_hours_overrides_job ON payroll_hours_overrides (company_id, job_id)`);
    // [cancel-fee-flat 2026-06-17] Optional flat cancellation/lockout fee ($).
    // When > 0 it overrides the percentage, so a tenant can bill a flat rate or
    // a % of job cost. Idempotent boot ensure (matches the company-column
    // convention above).
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_cancel_fee_flat numeric(10,2) NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_lockout_fee_flat numeric(10,2) NOT NULL DEFAULT 0`);
    console.log("[payroll-P0] schema ready (payroll_hours_basis + payroll_hours_overrides + cancel/lockout flat fee)");
  } catch (err) {
    console.error("[payroll-P0] ensure setup error (non-fatal):", err);
  }
}
