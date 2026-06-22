/**
 * Daily leave-accrual cron — grant-on-eligibility + work-anniversary reset.
 *
 * Runs the unified reconcile (./leave-reconcile.ts) for every tenant with
 * the leave program enabled. One daily pass covers all three actions,
 * keyed off each employee's hire-anniversary benefit year:
 *   - initial_grant : a new hire crosses the 90-day / 1-year gate
 *   - annual_reset  : first run of a new benefit year (work anniversary)
 *   - tier_topup    : PTO crosses its 2-year tenure tier
 *
 * GATED by LEAVE_ACCRUAL_ENABLED (default OFF) — mirrors the COMMS_ENABLED /
 * recurring-cron-off pattern. Deploying this code does NOT write any
 * balances until the env flag is flipped to "true" in Railway, AFTER Sal
 * signs off on the migration dry-run. Until then the cron is a no-op.
 */
import { db } from "@workspace/db";
import { companyLeavePolicyTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { reconcileCompanyLeaveBalances } from "./leave-reconcile.js";

export const LEAVE_ACCRUAL_ENABLED =
  process.env.LEAVE_ACCRUAL_ENABLED === "true";

export type LeaveAccrualRunSummary = {
  company_id: number;
  initial_grant: number;
  annual_reset: number;
  tier_topup: number;
};

export async function runLeaveAccrualCron(
  asOf: string,
): Promise<LeaveAccrualRunSummary[]> {
  if (!LEAVE_ACCRUAL_ENABLED) {
    console.log(
      "[cron] leave_accrual: LEAVE_ACCRUAL_ENABLED not 'true' — skipping (no balance writes)",
    );
    return [];
  }
  const tenants = await db
    .select({ company_id: companyLeavePolicyTable.company_id })
    .from(companyLeavePolicyTable)
    .where(eq(companyLeavePolicyTable.leave_program_enabled, true));

  const summary: LeaveAccrualRunSummary[] = [];
  for (const t of tenants) {
    try {
      const plan = await reconcileCompanyLeaveBalances(t.company_id, asOf, {
        dryRun: false,
      });
      const row: LeaveAccrualRunSummary = {
        company_id: t.company_id,
        initial_grant: plan.filter((p) => p.plan.action === "initial_grant").length,
        annual_reset: plan.filter((p) => p.plan.action === "annual_reset").length,
        tier_topup: plan.filter((p) => p.plan.action === "tier_topup").length,
      };
      summary.push(row);
      console.log(
        `[cron] leave_accrual co${row.company_id}: ${row.initial_grant} granted, ${row.annual_reset} reset, ${row.tier_topup} tier-topup`,
      );
    } catch (e) {
      console.error(`[cron] leave_accrual co${t.company_id} error:`, e);
    }
  }
  return summary;
}
