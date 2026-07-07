/**
 * DB wrapper around the pure grant/reset engine (./leave-grant-reset.ts).
 *
 * `reconcileCompanyLeaveBalances` loops every active employee × active
 * flat-grant bucket for a company and applies the plan from
 * `planLeaveGrant`:
 *   - dryRun: true  → compute + return the plan, write NOTHING (powers
 *                     the migration diff and a safe cron preview).
 *   - dryRun: false → persist initial_grant / annual_reset / tier_topup.
 *
 * Idempotent: re-running the same day is a no-op once the year's grant
 * has landed (the year guard in planLeaveGrant). Split from the pure math
 * so unit tests can import the math without pulling in the drizzle client.
 */

import { db } from "@workspace/db";
import {
  leaveTypesTable,
  employeeLeaveBalancesTable,
  companyLeavePolicyTable,
  usersTable,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { round2 } from "./leave-balance.js";
import {
  planLeaveGrant,
  type GrantAccrualMode,
  type GrantBalance,
  type GrantPlan,
} from "./leave-grant-reset.js";

export type ReconcilePlanRow = {
  user_id: number;
  first_name: string | null;
  last_name: string | null;
  hire_date: string | null;
  leave_type_id: number;
  slug: string;
  display_name: string;
  prior_granted: number;
  prior_used: number;
  plan: GrantPlan;
  remaining: number; // new_granted - new_used
};

export async function reconcileCompanyLeaveBalances(
  companyId: number,
  asOf: string,
  // preserveUsed → passed to planLeaveGrant: the office migration apply keeps
  // MC-imported used_hours on first-touch grants; the cron omits it (default
  // false) so anniversary resets still zero used. [mc-migration 2026-07-07]
  opts: { dryRun: boolean; preserveUsed?: boolean },
): Promise<ReconcilePlanRow[]> {
  const [policy] = await db
    .select({ ceiling: companyLeavePolicyTable.balance_ceiling_hours })
    .from(companyLeavePolicyTable)
    .where(eq(companyLeavePolicyTable.company_id, companyId))
    .limit(1);
  const ceiling = policy?.ceiling ? Number(policy.ceiling) : 80;

  const buckets = await db
    .select()
    .from(leaveTypesTable)
    .where(
      and(
        eq(leaveTypesTable.company_id, companyId),
        eq(leaveTypesTable.active, true),
        eq(leaveTypesTable.accrual_mode, "flat_grant"),
      ),
    );

  const users = await db
    .select({
      id: usersTable.id,
      first_name: usersTable.first_name,
      last_name: usersTable.last_name,
      hire_date: usersTable.hire_date,
    })
    .from(usersTable)
    .where(
      and(eq(usersTable.company_id, companyId), eq(usersTable.is_active, true)),
    );

  const out: ReconcilePlanRow[] = [];
  for (const u of users) {
    const hireDate = u.hire_date ? String(u.hire_date) : null;
    for (const b of buckets) {
      const balRow = await db
        .select()
        .from(employeeLeaveBalancesTable)
        .where(
          and(
            eq(employeeLeaveBalancesTable.company_id, companyId),
            eq(employeeLeaveBalancesTable.user_id, u.id),
            eq(employeeLeaveBalancesTable.leave_type_id, b.id),
          ),
        )
        .limit(1);
      const bal = balRow[0] ?? null;
      const balance: GrantBalance | null = bal
        ? {
            granted_hours: Number(bal.granted_hours),
            used_hours: Number(bal.used_hours),
            last_reset_at: bal.last_reset_at ? new Date(bal.last_reset_at) : null,
          }
        : null;

      const plan = planLeaveGrant(
        {
          slug: b.slug,
          accrual_mode: b.accrual_mode as GrantAccrualMode,
          annual_cap_hours: Number(b.annual_cap_hours),
          waiting_period_days: b.waiting_period_days,
          carryover_allowed: b.carryover_allowed,
        },
        balance,
        hireDate,
        asOf,
        ceiling,
        { preserveUsed: opts.preserveUsed === true },
      );

      if (plan.action !== "none" && !opts.dryRun) {
        const resetAt = new Date(`${asOf}T12:00:00Z`);
        if (bal) {
          await db
            .update(employeeLeaveBalancesTable)
            .set({
              granted_hours: plan.new_granted.toFixed(2),
              used_hours: plan.new_used.toFixed(2),
              last_reset_at: resetAt,
              updated_at: new Date(),
            })
            .where(eq(employeeLeaveBalancesTable.id, bal.id));
        } else {
          await db.insert(employeeLeaveBalancesTable).values({
            company_id: companyId,
            user_id: u.id,
            leave_type_id: b.id,
            granted_hours: plan.new_granted.toFixed(2),
            used_hours: plan.new_used.toFixed(2),
            last_reset_at: resetAt,
          });
        }
      }

      out.push({
        user_id: u.id,
        first_name: u.first_name,
        last_name: u.last_name,
        hire_date: hireDate,
        leave_type_id: b.id,
        slug: b.slug,
        display_name: b.display_name,
        prior_granted: balance ? round2(balance.granted_hours) : 0,
        prior_used: balance ? round2(balance.used_hours) : 0,
        plan,
        remaining: round2(plan.new_granted - plan.new_used),
      });
    }
  }
  return out;
}
