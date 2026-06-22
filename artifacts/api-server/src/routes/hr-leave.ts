import { Router } from "express";
import { db } from "@workspace/db";
import {
  usersTable,
  employeeLeaveUsageTable,
  companyLeavePolicyTable,
} from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

/**
 * DEPRECATED (time-off-accrual 2026-06-20) — legacy single-bucket leave.
 *
 * Superseded by the 3A engine at /api/leave (per-bucket
 * employee_leave_balances + grant/reset jobs). The single-bucket columns
 * users.{leave,pto,sick}_balance_hours this router reads/writes are NO
 * LONGER the source of truth. The employee-profile Leave Balance tab now
 * reads /api/leave/balances; nothing in the UI calls POST /use anymore.
 *
 * Kept ONLY so the GET /balance `usage` array (employee_leave_usage,
 * which the 3A approval flow still populates) keeps rendering the history
 * list. Do NOT build new features on this router. The deprecated columns
 * and the write endpoints (PUT /balance, POST /use, POST /activate) are
 * slated for removal in a follow-up AFTER the migration sign-off — left
 * in place now to avoid a destructive schema change in this PR.
 */
const router = Router();

router.get("/balance/:employee_id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const employeeId = parseInt(req.params.employee_id);

    const [employee] = await db
      .select({
        id: usersTable.id,
        hire_date: usersTable.hire_date,
        leave_balance_hours: usersTable.leave_balance_hours,
        leave_balance_activated: usersTable.leave_balance_activated,
        benefit_year_start: usersTable.benefit_year_start,
        pto_balance_hours: usersTable.pto_balance_hours,
        sick_balance_hours: usersTable.sick_balance_hours,
      })
      .from(usersTable)
      .where(and(eq(usersTable.id, employeeId), eq(usersTable.company_id, companyId)))
      .limit(1);

    if (!employee) return res.status(404).json({ error: "Employee not found" });

    const [policy] = await db.select().from(companyLeavePolicyTable).where(eq(companyLeavePolicyTable.company_id, companyId)).limit(1);

    const usage = await db
      .select()
      .from(employeeLeaveUsageTable)
      .where(and(
        eq(employeeLeaveUsageTable.company_id, companyId),
        eq(employeeLeaveUsageTable.employee_id, employeeId),
      ))
      .orderBy(desc(employeeLeaveUsageTable.date_used));

    let activationDate: string | null = null;
    if (employee.hire_date && policy?.eligibility_trigger_days) {
      const hd = new Date(employee.hire_date);
      hd.setDate(hd.getDate() + policy.eligibility_trigger_days);
      activationDate = hd.toISOString().slice(0, 10);
    }

    return res.json({
      employee_id: employeeId,
      leave_balance_hours: employee.leave_balance_hours,
      leave_balance_activated: employee.leave_balance_activated,
      pto_balance_hours: employee.pto_balance_hours,
      sick_balance_hours: employee.sick_balance_hours,
      activation_date: activationDate,
      policy: policy ?? null,
      usage,
    });
  } catch (err) {
    console.error("leave balance error:", err);
    return res.status(500).json({ error: "Failed to fetch leave balance" });
  }
});

// Set an employee's PTO and/or Sick balance directly (admin "Update PTO" /
// "Update Sick"). Absolute set, not a delta. Also the load path for the
// reconciliation import of MaidCentral PTO/sick balances.
router.put("/balance/:employee_id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const employeeId = parseInt(req.params.employee_id);
    if (isNaN(employeeId)) return res.status(400).json({ error: "Invalid employee_id" });

    const updates: Record<string, string> = {};
    if (req.body.pto_balance_hours !== undefined) updates.pto_balance_hours = String(parseFloat(req.body.pto_balance_hours) || 0);
    if (req.body.sick_balance_hours !== undefined) updates.sick_balance_hours = String(parseFloat(req.body.sick_balance_hours) || 0);
    if (req.body.leave_balance_hours !== undefined) updates.leave_balance_hours = String(parseFloat(req.body.leave_balance_hours) || 0);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Provide pto_balance_hours, sick_balance_hours, or leave_balance_hours" });
    }

    const [row] = await db
      .update(usersTable)
      .set(updates)
      .where(and(eq(usersTable.id, employeeId), eq(usersTable.company_id, companyId)))
      .returning({
        id: usersTable.id,
        pto_balance_hours: usersTable.pto_balance_hours,
        sick_balance_hours: usersTable.sick_balance_hours,
        leave_balance_hours: usersTable.leave_balance_hours,
      });
    if (!row) return res.status(404).json({ error: "Employee not found" });
    return res.json(row);
  } catch (err) {
    console.error("leave balance update error:", err);
    return res.status(500).json({ error: "Failed to update leave balance" });
  }
});

router.post("/use", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const loggedBy = req.auth!.userId!;
    const { employee_id, date_used, hours, notes } = req.body;
    if (!employee_id || !date_used || !hours) return res.status(400).json({ error: "employee_id, date_used, hours required" });

    const [employee] = await db.select({ leave_balance_hours: usersTable.leave_balance_hours }).from(usersTable)
      .where(and(eq(usersTable.id, employee_id), eq(usersTable.company_id, companyId))).limit(1);
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    const currentBalance = parseFloat(employee.leave_balance_hours ?? "0");
    const deduct = parseFloat(hours);
    const newBalance = Math.max(0, currentBalance - deduct);

    await db.update(usersTable).set({ leave_balance_hours: String(newBalance) }).where(eq(usersTable.id, employee_id));

    const [usage] = await db.insert(employeeLeaveUsageTable).values({
      company_id: companyId,
      employee_id,
      date_used,
      hours: String(deduct),
      notes,
      logged_by: loggedBy,
    }).returning();

    return res.json({ usage, new_balance: newBalance });
  } catch (err) {
    console.error("leave use error:", err);
    return res.status(500).json({ error: "Failed to log leave usage" });
  }
});

router.post("/activate", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const [policy] = await db.select().from(companyLeavePolicyTable).where(eq(companyLeavePolicyTable.company_id, companyId)).limit(1);
    if (!policy || !policy.leave_program_enabled) return res.json({ activated: 0 });

    const today = new Date();
    const employees = await db.select({
      id: usersTable.id,
      hire_date: usersTable.hire_date,
      leave_balance_activated: usersTable.leave_balance_activated,
    }).from(usersTable).where(and(eq(usersTable.company_id, companyId), eq(usersTable.is_active, true)));

    let activated = 0;
    for (const emp of employees) {
      if (emp.leave_balance_activated || !emp.hire_date) continue;
      const hd = new Date(emp.hire_date);
      const triggerDate = new Date(hd);
      triggerDate.setDate(triggerDate.getDate() + (policy.eligibility_trigger_days ?? 0));
      if (today >= triggerDate) {
        const initialBalance = policy.leave_grant_method === "front_loaded"
          ? parseFloat(policy.leave_hours_granted ?? "0")
          : 0;
        await db.update(usersTable).set({
          leave_balance_activated: true,
          leave_balance_hours: String(initialBalance),
        }).where(eq(usersTable.id, emp.id));
        activated++;
      }
    }
    return res.json({ activated });
  } catch (err) {
    console.error("leave activate error:", err);
    return res.status(500).json({ error: "Failed to run leave activation" });
  }
});

export default router;
