/**
 * AI.15a commission engine.
 *
 * Two paired exports:
 *
 *   computeJobCommissions(jobId, companyId)
 *     Pure read. Performs the per technician commission math against the
 *     current state of jobs / job_technicians / companies and returns the
 *     breakdown. No database writes. Safe to call from GET endpoints,
 *     hover popovers, anywhere a fresh read is needed.
 *
 *   recalcJobCommissions(jobId, companyId)
 *     Calls computeJobCommissions internally, then stamps
 *     `jobs.last_recalculated_at = now()`. Use this after any mutation
 *     that affects commission inputs. The stamp is what drives the
 *     dispatch poll endpoint (`/api/dispatch?since=<iso>`) to return the
 *     job to the dispatch board within roughly 2 seconds.
 *
 * The math lives in compute. Recalc is a thin wrapper that adds the stamp.
 *
 * Calling rule for recalc: invoke this AFTER any mutation that affects:
 *   * jobs.base_fee or jobs.billed_amount
 *   * jobs.estimated_hours
 *   * jobs.commission_pool_rate
 *   * jobs.assigned_user_id
 *   * job_technicians (insert / delete / pay_override change)
 *   * job_add_ons     (insert / delete / quantity / price change)
 *
 * Replaces the previously internal `calculateTechPay` helper that used to
 * live in routes/jobs.ts. The math is identical (lift and shift relocation).
 *
 * NOTE: neither function persists `final_pay` to job_technicians. That
 * column is currently used only for manual overrides. The existing
 * PUT /:id/technicians/:techId/override route writes both pay_override and
 * final_pay. Calculated pay is computed on read. AI.15b may revisit this
 * once the pricing engine is extracted.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface PerTechPay {
  user_id: number;
  name: string;
  is_primary: boolean;
  est_hours: number;
  /** Calculated pay before any per technician override (poolAmount / numTechs). */
  calc_pay: number;
  /** Final pay shown to the tech (override if set, else calc_pay). */
  final_pay: number;
  /** Manual per technician override, or null if not set. */
  pay_override: number | null;
}

/**
 * Pure read. Compute per technician commission for a job. No DB writes.
 *
 * Use from GET endpoints and any read path.
 */
export async function computeJobCommissions(
  jobId: number,
  companyId: number,
): Promise<PerTechPay[]> {
  const jobRows = await db.execute(sql`
    SELECT id, base_fee, billed_amount, estimated_hours, assigned_user_id, commission_pool_rate
    FROM jobs
    WHERE id = ${jobId} AND company_id = ${companyId}
  `);
  if (!jobRows.rows.length) return [];
  const job = jobRows.rows[0] as any;

  const compRows = await db.execute(sql`
    SELECT res_tech_pay_pct FROM companies WHERE id = ${companyId} LIMIT 1
  `);
  const resPct = parseFloat(String((compRows.rows[0] as any)?.res_tech_pay_pct ?? 0.35));

  const techRows = await db.execute(sql`
    SELECT jt.user_id, jt.is_primary, jt.pay_override, u.first_name, u.last_name
    FROM job_technicians jt
    JOIN users u ON u.id = jt.user_id
    WHERE jt.job_id = ${jobId}
    ORDER BY jt.is_primary DESC, jt.id
  `);

  let techs: any[] = techRows.rows;

  // Backstop: if no junction rows but jobs.assigned_user_id is set, treat the
  // primary tech as the sole assignee. Mirrors prior calculateTechPay logic.
  if (techs.length === 0 && job.assigned_user_id) {
    const userRow = await db.execute(sql`
      SELECT id, first_name, last_name FROM users WHERE id = ${job.assigned_user_id} LIMIT 1
    `);
    if (userRow.rows.length) {
      const u = userRow.rows[0] as any;
      techs = [{
        user_id: u.id,
        first_name: u.first_name,
        last_name: u.last_name,
        is_primary: true,
        pay_override: null,
      }];
    }
  }

  const numTechs = techs.length || 1;
  const jobTotal = parseFloat(String(job.billed_amount || job.base_fee || 0));
  const poolRate = job.commission_pool_rate != null
    ? parseFloat(String(job.commission_pool_rate))
    : resPct;
  const poolAmount = jobTotal * poolRate;
  const estHours = parseFloat(String(job.estimated_hours || 0));
  const estHoursPerTech = numTechs > 0
    ? Math.round((estHours / numTechs) * 10) / 10
    : estHours;

  return techs.map((t: any) => {
    const calcPay = Math.round((poolAmount / numTechs) * 100) / 100;
    const override = t.pay_override != null ? parseFloat(String(t.pay_override)) : null;
    return {
      user_id: t.user_id,
      name: `${t.first_name} ${t.last_name}`,
      is_primary: !!t.is_primary,
      est_hours: estHoursPerTech,
      calc_pay: calcPay,
      final_pay: override != null ? override : calcPay,
      pay_override: override,
    };
  });
}

/**
 * Recompute per technician commission and stamp jobs.last_recalculated_at.
 *
 * Use from any mutation that affects commission inputs. The stamp drives
 * the dispatch poll endpoint to return the job within roughly 2 seconds.
 *
 * The stamp UPDATE runs unconditionally after compute. If the job does not
 * exist the UPDATE affects zero rows, which is a harmless no op. If the job
 * exists but has no technicians the stamp still applies, which is correct:
 * dispatch should still see the change.
 */
export async function recalcJobCommissions(
  jobId: number,
  companyId: number,
): Promise<PerTechPay[]> {
  const result = await computeJobCommissions(jobId, companyId);

  await db.execute(sql`
    UPDATE jobs SET last_recalculated_at = now()
    WHERE id = ${jobId} AND company_id = ${companyId}
  `);

  return result;
}
