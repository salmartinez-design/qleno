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
import { and, eq, sql } from "drizzle-orm";
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
  // source → provenance label written to app_audit_log with every persisted
  // change ('boot' | 'cron' | 'office_apply'). The engine used to write
  // silently — a boot-time run re-granted balances the office had just zeroed
  // and nothing recorded why. [leave-log 2026-07-07]
  opts: { dryRun: boolean; preserveUsed?: boolean; source?: string },
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
      employment_type: usersTable.employment_type,
      w2_1099: usersTable.w2_1099,
    })
    .from(usersTable)
    .where(
      and(eq(usersTable.company_id, companyId), eq(usersTable.is_active, true)),
    );

  const out: ReconcilePlanRow[] = [];
  for (const u of users) {
    // [1099-exclusion 2026-07-07] Independent contractors get NO leave grants
    // — PLAWA/PTO are employee benefits (IL PLAWA doesn't cover contractors).
    // Without this skip, the engine's tier-topup/annual-reset would resurrect
    // balances the office deliberately zeroed on 1099s (Rosa, Alma). Existing
    // balance rows are left untouched (the office manages them manually).
    if (u.employment_type === "contractor" || String(u.w2_1099 ?? "").includes("1099")) {
      continue;
    }
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
        let balId = bal?.id ?? null;
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
          const ins = await db.insert(employeeLeaveBalancesTable).values({
            company_id: companyId,
            user_id: u.id,
            leave_type_id: b.id,
            granted_hours: plan.new_granted.toFixed(2),
            used_hours: plan.new_used.toFixed(2),
            last_reset_at: resetAt,
          }).returning({ id: employeeLeaveBalancesTable.id });
          balId = ins[0]?.id ?? null;
        }
        // [leave-log 2026-07-07] Provenance row for every engine write, same
        // target_type as the office's manual leave_balance_set so one query
        // returns the full change history of a balance. performed_by NULL =
        // the system; new_value.source says which trigger (boot/cron/apply).
        try {
          const oldVal = balance
            ? JSON.stringify({ granted_hours: balance.granted_hours, used_hours: balance.used_hours })
            : null;
          const newVal = JSON.stringify({
            user_id: u.id,
            leave_type_id: b.id,
            slug: b.slug,
            granted_hours: plan.new_granted,
            used_hours: plan.new_used,
            engine_action: plan.action,
            source: opts.source ?? "engine",
          });
          await db.execute(sql`
            INSERT INTO app_audit_log
              (company_id, performed_by, action, target_type, target_id,
               old_value, new_value, performed_at)
            VALUES
              (${companyId}, ${null}, ${"leave_grant_engine"}, ${"employee_leave_balance"},
               ${String(balId ?? `${u.id}:${b.id}`)},
               ${oldVal}::jsonb, ${newVal}::jsonb, now())
          `);
        } catch (err) {
          console.error("[leave-reconcile] audit write failed (non-fatal):", err);
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
