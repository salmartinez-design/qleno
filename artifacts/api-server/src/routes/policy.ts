import { Router } from "express";
import { db } from "@workspace/db";
import {
  companyPayPolicyTable,
  companyAttendancePolicyTable,
  companyLeavePolicyTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();
const OWNER_ADMIN = requireRole("owner", "admin");
// [office-admin-parity 2026-06-26] HR pay/attendance/leave policy edits used to
// be OWNER-only. Per Sal, the office/management tier needs full access — "all I
// can." Editing these policies (commission %, mileage/overtime rules, accrual,
// attendance steps) is now owner/admin/office. Reads were already owner/admin
// (office via the requireRole choke point); writes now match.
const MANAGER_TIER = requireRole("owner", "admin", "office");

async function getOrCreatePayPolicy(companyId: number) {
  const rows = await db.select().from(companyPayPolicyTable).where(eq(companyPayPolicyTable.company_id, companyId)).limit(1);
  if (rows.length > 0) return rows[0];
  const inserted = await db.insert(companyPayPolicyTable).values({ company_id: companyId }).returning();
  return inserted[0];
}

async function getOrCreateAttendancePolicy(companyId: number) {
  const rows = await db.select().from(companyAttendancePolicyTable).where(eq(companyAttendancePolicyTable.company_id, companyId)).limit(1);
  if (rows.length > 0) return rows[0];
  const inserted = await db.insert(companyAttendancePolicyTable).values({ company_id: companyId }).returning();
  return inserted[0];
}

async function getOrCreateLeavePolicy(companyId: number) {
  const rows = await db.select().from(companyLeavePolicyTable).where(eq(companyLeavePolicyTable.company_id, companyId)).limit(1);
  if (rows.length > 0) return rows[0];
  const inserted = await db.insert(companyLeavePolicyTable).values({ company_id: companyId }).returning();
  return inserted[0];
}

router.get("/pay", requireAuth, OWNER_ADMIN, async (req, res) => {
  try {
    const policy = await getOrCreatePayPolicy(req.auth!.companyId!);
    return res.json(policy);
  } catch (err) {
    console.error("policy GET pay error:", err);
    return res.status(500).json({ error: "Failed to load pay policy" });
  }
});

router.put("/pay", requireAuth, MANAGER_TIER, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const existing = await getOrCreatePayPolicy(companyId);
    const allowed = [
      "training_period_weeks","training_hourly_rate",
      "job_minimum_hours_enabled","job_minimum_hours",
      "commission_type","commission_rate","commission_condition_label",
      "min_hourly_wage_per_period","min_hourly_wage_per_job",
      "mileage_reimbursement_enabled","mileage_rate_per_mile",
      "mileage_job_to_job_only","mileage_submission_deadline_days",
      "overtime_rule","pay_week_start_day","full_time_hours_threshold",
      "quality_probation_enabled","quality_probation_trigger_count",
      "quality_probation_rolling_days","quality_probation_duration_days",
      "quality_probation_hourly_rate","recovery_tech_rate",
      "return_to_commission_clean_days","re_clean_pay_type","re_clean_reduced_rate",
    ];
    const updates: Record<string, any> = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    const result = await db.update(companyPayPolicyTable).set(updates).where(eq(companyPayPolicyTable.id, existing.id)).returning();
    return res.json(result[0]);
  } catch (err) {
    console.error("policy PUT pay error:", err);
    return res.status(500).json({ error: "Failed to save pay policy" });
  }
});

router.get("/attendance", requireAuth, OWNER_ADMIN, async (req, res) => {
  try {
    const policy = await getOrCreateAttendancePolicy(req.auth!.companyId!);
    return res.json(policy);
  } catch (err) {
    console.error("policy GET attendance error:", err);
    return res.status(500).json({ error: "Failed to load attendance policy" });
  }
});

router.put("/attendance", requireAuth, MANAGER_TIER, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const existing = await getOrCreateAttendancePolicy(companyId);
    const allowed = [
      "benefit_year_basis","grace_period_minutes",
      "tardy_steps","absence_steps",
      "ncns_policy_enabled","ncns_may_terminate_immediately","ncns_custom_note",
      "max_simultaneous_off_enabled","max_simultaneous_off_count",
    ];
    const updates: Record<string, any> = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    const result = await db.update(companyAttendancePolicyTable).set(updates).where(eq(companyAttendancePolicyTable.id, existing.id)).returning();
    return res.json(result[0]);
  } catch (err) {
    console.error("policy PUT attendance error:", err);
    return res.status(500).json({ error: "Failed to save attendance policy" });
  }
});

router.get("/leave", requireAuth, OWNER_ADMIN, async (req, res) => {
  try {
    const policy = await getOrCreateLeavePolicy(req.auth!.companyId!);
    return res.json(policy);
  } catch (err) {
    console.error("policy GET leave error:", err);
    return res.status(500).json({ error: "Failed to load leave policy" });
  }
});

router.put("/leave", requireAuth, MANAGER_TIER, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const existing = await getOrCreateLeavePolicy(companyId);
    const allowed = [
      "leave_program_enabled","leave_program_name","leave_hours_granted",
      "leave_grant_method","accrual_rate_per_hour_worked","eligibility_trigger_days",
      "leave_reset_basis","carryover_enabled","carryover_max_hours",
      "payout_on_separation","documentation_required_after_days",
      "notice_required_foreseeable_days","lactation_breaks_paid",
      "pto_request_deadline_days","holidays","holiday_pay_rate_multiplier",
      "birthday_holiday_enabled","birthday_advance_notice_days",
    ];
    const updates: Record<string, any> = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    const result = await db.update(companyLeavePolicyTable).set(updates).where(eq(companyLeavePolicyTable.id, existing.id)).returning();
    return res.json(result[0]);
  } catch (err) {
    console.error("policy PUT leave error:", err);
    return res.status(500).json({ error: "Failed to save leave policy" });
  }
});

export default router;
