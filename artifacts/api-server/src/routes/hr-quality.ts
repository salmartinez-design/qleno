import { Router } from "express";
import { db } from "@workspace/db";
import {
  qualityComplaintsTable,
  usersTable,
  companyPayPolicyTable,
} from "@workspace/db/schema";
import { eq, and, gte, count, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();
const LOG_ROLES = requireRole("owner", "admin", "office");

router.post("/complaints", requireAuth, LOG_ROLES, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { employee_id, job_id, complaint_date, description, re_clean_required } = req.body;
    if (!employee_id || !complaint_date) return res.status(400).json({ error: "employee_id, complaint_date required" });

    const [complaint] = await db.insert(qualityComplaintsTable).values({
      company_id: companyId,
      employee_id,
      job_id: job_id ?? null,
      complaint_date,
      description,
      re_clean_required: re_clean_required ?? false,
    }).returning();

    return res.json(complaint);
  } catch (err) {
    console.error("quality complaint POST error:", err);
    return res.status(500).json({ error: "Failed to log complaint" });
  }
});

router.get("/complaints", requireAuth, LOG_ROLES, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { employee_id } = req.query;
    if (!employee_id) return res.status(400).json({ error: "employee_id required" });

    const complaints = await db
      .select({
        id: qualityComplaintsTable.id,
        employee_id: qualityComplaintsTable.employee_id,
        job_id: qualityComplaintsTable.job_id,
        complaint_date: qualityComplaintsTable.complaint_date,
        description: qualityComplaintsTable.description,
        valid: qualityComplaintsTable.valid,
        validated_by: qualityComplaintsTable.validated_by,
        validated_at: qualityComplaintsTable.validated_at,
        re_clean_required: qualityComplaintsTable.re_clean_required,
        recovery_tech_id: qualityComplaintsTable.recovery_tech_id,
        resolved: qualityComplaintsTable.resolved,
        created_at: qualityComplaintsTable.created_at,
        validator_name: sql<string>`(select concat(first_name,' ',last_name) from users where id = ${qualityComplaintsTable.validated_by})`,
      })
      .from(qualityComplaintsTable)
      .where(and(
        eq(qualityComplaintsTable.company_id, companyId),
        eq(qualityComplaintsTable.employee_id, parseInt(employee_id as string)),
      ))
      .orderBy(desc(qualityComplaintsTable.complaint_date));

    return res.json(complaints);
  } catch (err) {
    console.error("quality complaints GET error:", err);
    return res.status(500).json({ error: "Failed to fetch complaints" });
  }
});

router.put("/complaints/:id/validate", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const validatedBy = req.auth!.userId!;
    const id = parseInt(req.params.id);
    const { valid, re_clean_required, recovery_tech_id } = req.body;

    const result = await db
      .update(qualityComplaintsTable)
      .set({
        valid: valid ?? false,
        validated_by: validatedBy,
        validated_at: new Date(),
        re_clean_required: re_clean_required ?? false,
        recovery_tech_id: recovery_tech_id ?? null,
      })
      .where(and(eq(qualityComplaintsTable.id, id), eq(qualityComplaintsTable.company_id, companyId)))
      .returning();

    if (!result.length) return res.status(404).json({ error: "Complaint not found" });

    if (valid) {
      await checkProbationThreshold(companyId, result[0].employee_id);
    }

    // [90d-composite] Validating a complaint (either direction) moves the tech's
    // complaint-free sub-score → recompute the rolling composite. Non-fatal.
    try {
      const { recomputeCompositeScore } = await import("../lib/scorecard-composite.js");
      await recomputeCompositeScore(companyId, result[0].employee_id);
    } catch (e: any) {
      console.error("[scorecard-composite] recompute after complaint validate failed (non-fatal):", e?.message ?? e);
    }

    return res.json(result[0]);
  } catch (err) {
    console.error("quality validate error:", err);
    return res.status(500).json({ error: "Failed to validate complaint" });
  }
});

router.post("/probation/check", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { employee_id } = req.body;
    if (!employee_id) return res.status(400).json({ error: "employee_id required" });
    const result = await checkProbationThreshold(companyId, employee_id);
    return res.json(result);
  } catch (err) {
    console.error("probation check error:", err);
    return res.status(500).json({ error: "Failed to check probation threshold" });
  }
});

// [redo-service 2026-07-10] exported so the Create Redo Service flow can run the
// same 2-in-30 check after it logs a redo's quality complaint, and now fires a
// DEDUPED office alert (the piece that was missing) when a cleaner NEWLY crosses
// into probation — so re-validating old complaints or a 3rd/4th redo doesn't
// re-spam the office.
export async function checkProbationThreshold(companyId: number, employeeId: number) {
  const policyRows = await db.select().from(companyPayPolicyTable).where(eq(companyPayPolicyTable.company_id, companyId)).limit(1);
  if (!policyRows.length || !policyRows[0].quality_probation_enabled) return { threshold_met: false };
  const policy = policyRows[0];

  const rollingDays = policy.quality_probation_rolling_days ?? 30;
  const triggerCount = policy.quality_probation_trigger_count ?? 2;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - rollingDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const validCount = await db.select({ count: count() }).from(qualityComplaintsTable).where(and(
    eq(qualityComplaintsTable.company_id, companyId),
    eq(qualityComplaintsTable.employee_id, employeeId),
    eq(qualityComplaintsTable.valid, true),
    gte(qualityComplaintsTable.complaint_date, cutoffStr),
  ));

  const total = validCount[0].count;
  const thresholdMet = total >= triggerCount;

  if (thresholdMet) {
    // Was the cleaner already flagged? If so, don't re-alert (dedupe).
    const cur = await db.select({ hr_status: usersTable.hr_status, first_name: usersTable.first_name, last_name: usersTable.last_name })
      .from(usersTable).where(and(eq(usersTable.id, employeeId), eq(usersTable.company_id, companyId))).limit(1);
    const alreadyOnProbation = cur[0]?.hr_status === "quality_probation";
    await db.update(usersTable)
      .set({ hr_status: "quality_probation" })
      .where(and(eq(usersTable.id, employeeId), eq(usersTable.company_id, companyId)));
    if (!alreadyOnProbation) {
      try {
        const name = cur[0] ? `${cur[0].first_name ?? ""} ${cur[0].last_name ?? ""}`.trim() : `Employee #${employeeId}`;
        const { notifyOfficeUsers } = await import("../lib/notify.js");
        await notifyOfficeUsers(companyId, {
          type: "quality_probation",
          title: "Quality probation triggered",
          body: `${name} reached ${total} valid quality/redo complaints in ${rollingDays} days. Review for disciplinary action.`,
          link: `/employees/${employeeId}`,
          meta: { employee_id: employeeId, count: total, rolling_days: rollingDays },
        });
      } catch (e) { console.error("[hr-quality] office probation alert failed (non-fatal):", e); }
    }
  }

  return { threshold_met: thresholdMet, valid_complaints_in_window: total };
}

export default router;
