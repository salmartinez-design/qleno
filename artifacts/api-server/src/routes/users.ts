import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, scorecardsTable, additionalPayTable, jobsTable, clientsTable, serviceZoneEmployeesTable, serviceZonesTable, employeePayrollHistoryTable } from "@workspace/db/schema";
import { eq, and, sql, avg, count, desc, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const { role, is_active, page = "1", limit = "25", branch_id } = req.query;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    const conditions: any[] = [eq(usersTable.company_id, req.auth!.companyId)];
    if (role) conditions.push(eq(usersTable.role, role as any));
    if (is_active !== undefined) conditions.push(eq(usersTable.is_active, is_active === "true"));
    if (branch_id && branch_id !== "all") conditions.push(eq(usersTable.branch_id, parseInt(branch_id as string)));

    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
        role: usersTable.role,
        pay_rate: usersTable.pay_rate,
        pay_type: usersTable.pay_type,
        is_active: usersTable.is_active,
        hire_date: usersTable.hire_date,
        avatar_url: usersTable.avatar_url,
      })
      .from(usersTable)
      .where(and(...conditions))
      .limit(parseInt(limit as string))
      .offset(offset);

    const totalResult = await db
      .select({ count: count() })
      .from(usersTable)
      .where(and(...conditions));

    return res.json({
      data: users.map(u => ({ ...u, productivity_pct: null })),
      total: totalResult[0].count,
      page: parseInt(page as string),
      limit: parseInt(limit as string),
    });
  } catch (err) {
    console.error("List users error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to list users" });
  }
});

// [AF] GET /api/users/techs-with-status
// Returns field technicians (role in technician/team_lead, is_active=true),
// grouped by current clock-in state for the Add Team Member picker on the
// dispatch drawer. `currently_at` is the client name of the job they're
// clocked into, if any. Excludes users passed via ?exclude=1,2,3 (i.e. the
// primary + already-added team members on the caller's job).
//
// Response shape:
//   [{ id, first_name, last_name, name, role,
//      is_clocked_in: bool, currently_at: string|null }]
router.get("/techs-with-status", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const excludeParam = (req.query.exclude as string | undefined) ?? "";
    const excludeIds = excludeParam.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));

    // Optional branch isolation. The dispatch drawer's inline tech editor
    // passes the job's branch_id so the dropdown only lists techs assignable
    // to that branch. Omit (or pass "all") to get the unfiltered list (the
    // legacy "Add Team Member" picker behavior).
    const branchIdRaw = req.query.branch_id;
    const branchIdNum = (typeof branchIdRaw === "string" && branchIdRaw !== "all" && branchIdRaw !== "")
      ? parseInt(branchIdRaw, 10) : null;

    // Roles are a pg enum, so filter the list after fetch rather than build a
    // complex or() chain. Small set (tens of rows) — no perf concern.
    const rows = await db.execute(sql`
      SELECT u.id, u.first_name, u.last_name, u.role, u.branch_id,
             -- Active clock-in for this user = any timeclock row with NULL
             -- clock_out_at. Today-only filter by clock_in_at::date = CURRENT_DATE
             -- (America/Chicago is handled at ingest; we just compare UTC dates
             -- for the "free/working RIGHT NOW" display).
             (SELECT tc.job_id FROM timeclock tc
               WHERE tc.user_id = u.id
                 AND tc.clock_out_at IS NULL
               ORDER BY tc.clock_in_at DESC LIMIT 1) AS active_job_id
        FROM users u
       WHERE u.company_id = ${companyId}
         AND u.is_active = true
         AND u.role IN ('technician','team_lead')
         ${branchIdNum != null && Number.isFinite(branchIdNum)
           ? sql`AND (u.branch_id = ${branchIdNum} OR u.branch_id IS NULL)`
           : sql``}
       ORDER BY u.first_name, u.last_name
    `);

    // Fetch client names for any active_job_ids (small set — typically < 30 techs).
    const activeJobIds = Array.from(new Set((rows.rows as any[]).map(r => r.active_job_id).filter((v): v is number => typeof v === "number")));
    const clientByJob = new Map<number, string>();
    if (activeJobIds.length > 0) {
      const jobRows = await db
        .select({
          job_id: jobsTable.id,
          first_name: clientsTable.first_name,
          last_name: clientsTable.last_name,
        })
        .from(jobsTable)
        .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
        .where(and(eq(jobsTable.company_id, companyId), sql`${jobsTable.id} = ANY(${activeJobIds})`));
      for (const j of jobRows) {
        clientByJob.set(j.job_id, `${j.first_name ?? ""} ${j.last_name ?? ""}`.trim() || "Unknown");
      }
    }

    const excludeSet = new Set(excludeIds);
    const data = (rows.rows as any[])
      .filter(r => !excludeSet.has(r.id))
      .map(r => ({
        id: r.id,
        first_name: r.first_name,
        last_name: r.last_name,
        name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
        role: r.role,
        branch_id: r.branch_id ?? null,
        is_clocked_in: r.active_job_id !== null,
        currently_at: r.active_job_id ? (clientByJob.get(r.active_job_id) ?? null) : null,
      }));

    return res.json({ data });
  } catch (err) {
    console.error("techs-with-status error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { email, first_name, last_name, role, pay_rate, pay_type, hire_date, phone } = req.body;

    const tempPassword = Math.random().toString(36).slice(-8);
    const password_hash = await bcrypt.hash(tempPassword, 10);

    const newUser = await db
      .insert(usersTable)
      .values({
        company_id: req.auth!.companyId,
        email: email.toLowerCase(),
        password_hash,
        first_name,
        last_name,
        role,
        pay_rate,
        pay_type,
        hire_date,
        phone,
      })
      .returning();

    const { password_hash: _, ...safeUser } = newUser[0];
    logAudit(req, "CREATE_EMPLOYEE", "employee", safeUser.id, null, safeUser);
    return res.status(201).json({ ...safeUser, productivity_pct: null });
  } catch (err) {
    console.error("Create user error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to create user" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const user = await db
      .select()
      .from(usersTable)
      .where(and(
        eq(usersTable.id, userId),
        eq(usersTable.company_id, req.auth!.companyId)
      ))
      .limit(1);

    if (!user[0]) {
      return res.status(404).json({ error: "Not Found", message: "User not found" });
    }

    const recentJobs = await db
      .select({
        id: jobsTable.id,
        service_type: jobsTable.service_type,
        status: jobsTable.status,
        scheduled_date: jobsTable.scheduled_date,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        base_fee: jobsTable.base_fee,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .where(and(
        eq(jobsTable.assigned_user_id, userId),
        eq(jobsTable.company_id, req.auth!.companyId)
      ))
      .orderBy(desc(jobsTable.scheduled_date))
      .limit(10);

    const scoreAvg = await db
      .select({ avg: avg(scorecardsTable.score) })
      .from(scorecardsTable)
      .where(and(
        eq(scorecardsTable.user_id, userId),
        eq(scorecardsTable.company_id, req.auth!.companyId),
        eq(scorecardsTable.excluded, false)
      ));

    const totalJobs = await db
      .select({ count: count() })
      .from(jobsTable)
      .where(and(
        eq(jobsTable.assigned_user_id, userId),
        eq(jobsTable.company_id, req.auth!.companyId)
      ));

    // Look up zone assignment for this employee
    const zoneAssignments = await db
      .select({ zone_id: serviceZonesTable.id, zone_name: serviceZonesTable.name, zone_color: serviceZonesTable.color })
      .from(serviceZoneEmployeesTable)
      .leftJoin(serviceZonesTable, eq(serviceZoneEmployeesTable.zone_id, serviceZonesTable.id))
      .where(and(eq(serviceZoneEmployeesTable.user_id, userId), eq(serviceZoneEmployeesTable.company_id, req.auth!.companyId)));

    const { password_hash: _, ...safeUser } = user[0];
    return res.json({
      ...safeUser,
      skills: safeUser.skills || [],
      productivity_pct: null,
      recent_jobs: recentJobs,
      scorecard_avg: scoreAvg[0].avg ? parseFloat(scoreAvg[0].avg) : null,
      total_jobs: totalJobs[0].count,
      zones: zoneAssignments,
      primary_zone: zoneAssignments[0] || null,
    });
  } catch (err) {
    console.error("Get user error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get user" });
  }
});

router.put("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { first_name, last_name, role, pay_rate, pay_type, is_active, hire_date, phone, skills } = req.body;

    const updated = await db
      .update(usersTable)
      .set({
        ...(first_name && { first_name }),
        ...(last_name && { last_name }),
        ...(role && { role }),
        ...(pay_rate !== undefined && { pay_rate }),
        ...(pay_type && { pay_type }),
        ...(is_active !== undefined && { is_active }),
        ...(hire_date !== undefined && { hire_date }),
        ...(phone !== undefined && { phone }),
        ...(skills !== undefined && { skills }),
      })
      .where(and(
        eq(usersTable.id, userId),
        eq(usersTable.company_id, req.auth!.companyId)
      ))
      .returning();

    if (!updated[0]) {
      return res.status(404).json({ error: "Not Found", message: "User not found" });
    }

    const { password_hash: _, ...safeUser } = updated[0];
    const action = role && role !== req.body._prevRole ? "ROLE_CHANGED" : "UPDATE_EMPLOYEE";
    logAudit(req, action, "employee", userId, null, { role: safeUser.role, is_active: safeUser.is_active });
    return res.json({ ...safeUser, productivity_pct: null });
  } catch (err) {
    console.error("Update user error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to update user" });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    await db
      .update(usersTable)
      .set({ is_active: false })
      .where(and(
        eq(usersTable.id, userId),
        eq(usersTable.company_id, req.auth!.companyId)
      ));
    logAudit(req, "DELETE_EMPLOYEE", "employee", userId, null, { is_active: false });
    return res.json({ success: true, message: "User deactivated" });
  } catch (err) {
    console.error("Delete user error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to delete user" });
  }
});

router.get("/:id/scorecards", requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const scorecards = await db
      .select({
        id: scorecardsTable.id,
        job_id: scorecardsTable.job_id,
        user_id: scorecardsTable.user_id,
        user_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        client_id: scorecardsTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        score: scorecardsTable.score,
        comments: scorecardsTable.comments,
        excluded: scorecardsTable.excluded,
        created_at: scorecardsTable.created_at,
      })
      .from(scorecardsTable)
      .leftJoin(usersTable, eq(scorecardsTable.user_id, usersTable.id))
      .leftJoin(clientsTable, eq(scorecardsTable.client_id, clientsTable.id))
      .where(and(
        eq(scorecardsTable.user_id, userId),
        eq(scorecardsTable.company_id, req.auth!.companyId)
      ))
      .orderBy(desc(scorecardsTable.created_at));

    const avgResult = await db
      .select({ avg: avg(scorecardsTable.score) })
      .from(scorecardsTable)
      .where(and(
        eq(scorecardsTable.user_id, userId),
        eq(scorecardsTable.excluded, false),
        eq(scorecardsTable.company_id, req.auth!.companyId)
      ));

    return res.json({
      data: scorecards,
      total: scorecards.length,
      average_score: avgResult[0].avg ? parseFloat(avgResult[0].avg) : null,
    });
  } catch (err) {
    console.error("Get user scorecards error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get scorecards" });
  }
});

router.get("/:id/additional-pay", requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const records = await db
      .select()
      .from(additionalPayTable)
      .where(and(
        eq(additionalPayTable.user_id, userId),
        eq(additionalPayTable.company_id, req.auth!.companyId)
      ))
      .orderBy(desc(additionalPayTable.created_at));

    return res.json({ data: records, total: records.length });
  } catch (err) {
    console.error("Get additional pay error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get additional pay" });
  }
});

router.post("/:id/additional-pay", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { amount, type, notes, job_id } = req.body;

    const record = await db
      .insert(additionalPayTable)
      .values({
        company_id: req.auth!.companyId,
        user_id: userId,
        amount,
        type,
        notes,
        job_id,
        status: "pending",
      })
      .returning();

    return res.status(201).json(record[0]);
  } catch (err) {
    console.error("Create additional pay error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to create additional pay" });
  }
});

router.patch("/:id/additional-pay/:payId/void", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const payId = parseInt(req.params.payId);

    const updated = await db
      .update(additionalPayTable)
      .set({
        status: "voided",
        voided_at: new Date(),
        voided_by: req.auth!.userId,
      })
      .where(and(
        eq(additionalPayTable.id, payId),
        eq(additionalPayTable.user_id, userId),
        eq(additionalPayTable.company_id, req.auth!.companyId)
      ))
      .returning();

    if (!updated.length) return res.status(404).json({ error: "Not Found" });
    return res.json(updated[0]);
  } catch (err) {
    console.error("Void additional pay error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to void pay entry" });
  }
});

router.delete("/:id/additional-pay/:payId", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const payId = parseInt(req.params.payId);

    const deleted = await db
      .delete(additionalPayTable)
      .where(and(
        eq(additionalPayTable.id, payId),
        eq(additionalPayTable.user_id, userId),
        eq(additionalPayTable.company_id, req.auth!.companyId),
        eq(additionalPayTable.status, "pending")
      ))
      .returning();

    if (!deleted.length) return res.status(404).json({ error: "Not Found or not deletable (must be pending)" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete additional pay error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to delete pay entry" });
  }
});

router.get("/:id/payroll-history", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const employeeId = parseInt(req.params.id);

    const records = await db
      .select()
      .from(employeePayrollHistoryTable)
      .where(and(
        eq(employeePayrollHistoryTable.employee_id, employeeId),
        eq(employeePayrollHistoryTable.company_id, req.auth!.companyId)
      ))
      .orderBy(desc(employeePayrollHistoryTable.period_start));

    return res.json({ data: records });
  } catch (err) {
    console.error("Get payroll history error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get payroll history" });
  }
});

export default router;
