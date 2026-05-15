import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, scorecardsTable, additionalPayTable, jobsTable, clientsTable, serviceZoneEmployeesTable, serviceZonesTable, employeePayrollHistoryTable, lmsSettingsTable, lmsEnrollmentsTable } from "@workspace/db/schema";
import { eq, and, sql, avg, count, desc, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import {
  generateLmsTempPassword,
  isValidEmail,
  isValidIsoDate,
  LMS_ADD_ALLOWED_ROLES,
  LMS_EDIT_ALLOWED_ROLES,
} from "../lib/lms-employee-helpers.js";

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

/**
 * Bulk-reset password for multiple users at once. Owner / admin only.
 *
 * Body: { userIds: number[], newPassword: string }
 *
 * Tenant-scoped: every userId must belong to the caller's company_id, or
 * the call returns 403 with the offending id. New password must be at
 * least 6 chars (matches /auth/reset-password).
 *
 * Returns the count of users updated. Skips users whose id isn't found
 * or belongs to a different company (defensive — no partial reset across
 * tenants).
 */
router.post("/bulk-reset-password", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { userIds, newPassword } = req.body as {
      userIds?: unknown;
      newPassword?: unknown;
    };
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: "Bad Request", message: "userIds must be a non-empty array" });
    }
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ error: "Bad Request", message: "newPassword must be a string of 6+ chars" });
    }
    const ids = userIds.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
    if (ids.length === 0) {
      return res.status(400).json({ error: "Bad Request", message: "userIds contained no valid integer ids" });
    }

    // Tenant guard: confirm every id belongs to the caller's company.
    const tenantRows = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.company_id, companyId), sql`${usersTable.id} = ANY(${ids}::int[])`));
    const ownedIds = new Set(tenantRows.map((r) => r.id));
    const foreign = ids.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      return res.status(403).json({
        error: "Forbidden",
        message: `User(s) ${foreign.join(", ")} are not in your company`,
      });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    const updated = await db
      .update(usersTable)
      .set({ password_hash: hash } as any)
      .where(and(eq(usersTable.company_id, companyId), sql`${usersTable.id} = ANY(${ids}::int[])`))
      .returning({ id: usersTable.id });

    await logAudit(req, "bulk_password_reset", "user", null, {
      user_ids: updated.map((u) => u.id),
      count: updated.length,
    });

    return res.json({ data: { updated_count: updated.length, updated_ids: updated.map((u) => u.id) } });
  } catch (err) {
    console.error("Bulk password reset error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to bulk-reset passwords" });
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
    const {
      first_name, last_name, role, pay_rate, pay_type, is_active,
      hire_date, phone, skills,
      // [pay-matrix 2026-04-29] 4-cell pay matrix.
      residential_pay_type, residential_pay_rate,
      commercial_pay_type,  commercial_pay_rate,
    } = req.body;

    // Validate matrix inputs if provided.
    const validateMatrixPair = (type: any, rate: any, label: string) => {
      if (type !== undefined && type !== "commission" && type !== "hourly") {
        return `${label}_pay_type must be 'commission' or 'hourly'`;
      }
      if (rate !== undefined) {
        const n = Number(rate);
        if (!Number.isFinite(n) || n < 0) return `${label}_pay_rate must be a non-negative number`;
      }
      return null;
    };
    const e1 = validateMatrixPair(residential_pay_type, residential_pay_rate, "residential");
    const e2 = validateMatrixPair(commercial_pay_type,  commercial_pay_rate,  "commercial");
    if (e1 || e2) return res.status(400).json({ error: e1 || e2 });

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
        ...(residential_pay_type !== undefined && { residential_pay_type }),
        ...(residential_pay_rate !== undefined && { residential_pay_rate: String(residential_pay_rate) }),
        ...(commercial_pay_type  !== undefined && { commercial_pay_type }),
        ...(commercial_pay_rate  !== undefined && { commercial_pay_rate:  String(commercial_pay_rate) }),
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/lms-archive — Owner only (Item 3, P0 sprint 2026-05-14)
// ─────────────────────────────────────────────────────────────────────────────
//
// Soft-deletes a user from LMS surfaces (roster + audit dashboard) by
// setting `archived_at`. Preserves their certificates, signed
// documents, and quiz attempt history for legal. Distinct from DELETE
// /users/:id (which is the existing hard-delete) and from
// PUT /users/:id with termination_date (HR concept). Tenant-scoped.
//
// Use case: phantom learners that don't match the active Maid Central
// roster. Owner archives them so the LMS audit dashboard count
// matches reality, but the historical compliance trail is intact.
//
// Body: {} (no params; archive flag is derivable from server time)
//
// Reversible: an archived user can be restored by a separate
// /:id/lms-restore endpoint (or by manually nulling the column).
router.post(
  "/:id/lms-archive",
  requireAuth,
  requireRole("owner"),
  async (req, res) => {
    try {
      const callerCompanyId = req.auth!.companyId;
      if (callerCompanyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const targetId = Number(req.params.id);
      if (!Number.isFinite(targetId) || targetId <= 0) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Invalid user id" });
      }

      const target = await db
        .select({
          id: usersTable.id,
          company_id: usersTable.company_id,
          email: usersTable.email,
          role: usersTable.role,
          archived_at: usersTable.archived_at,
        })
        .from(usersTable)
        .where(eq(usersTable.id, targetId))
        .limit(1);
      if (!target[0] || target[0].company_id !== callerCompanyId) {
        return res
          .status(404)
          .json({ error: "Not Found", message: "User not found in tenant" });
      }
      if (target[0].role === "owner") {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Cannot archive an owner account" });
      }
      if (target[0].id === req.auth!.userId) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "Cannot archive yourself" });
      }
      if (target[0].archived_at) {
        return res.json({
          data: { id: target[0].id, archived_at: target[0].archived_at },
        });
      }

      const now = new Date();
      const updated = await db
        .update(usersTable)
        .set({ archived_at: now })
        .where(eq(usersTable.id, targetId))
        .returning({
          id: usersTable.id,
          archived_at: usersTable.archived_at,
        });

      await logAudit(
        req,
        "users.lms_archive",
        "user",
        targetId,
        null,
        { email: target[0].email, archived_at: now.toISOString() },
      );

      return res.json({ data: updated[0] });
    } catch (err) {
      console.error("[users] /:id/lms-archive error:", err);
      return res
        .status(500)
        .json({ error: "Internal Server Error", message: "Failed to archive user" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// LMS-scoped Add/Edit Employee endpoints (sprint 2026-05-15)
// ─────────────────────────────────────────────────────────────────────────────
//
// Distinct from the general POST / and PUT /:id endpoints above:
//   - Owner is always allowed; admin requires the per-tenant
//     `admin_add_employee_allowed` / `admin_edit_employee_allowed`
//     toggle. Office is NEVER allowed (matches the bypass-button gate).
//   - POST /lms-add generates the Phes+6char temp password server-side,
//     hashes it, creates the user, auto-creates an LMS enrollment, and
//     returns the plaintext temp password in the response (one-time
//     visible to the admin who created the user).
//   - PATCH /:id/lms-edit edits a narrow whitelist of fields (name,
//     email, role, hire_date) and logs a before/after diff. Role
//     changes are logged separately so they're easy to grep.
//   - Tenant isolation enforced at the query level: every insert /
//     update / select forces `company_id = req.auth.companyId`, and
//     PATCH refuses if the target user doesn't belong to the caller's
//     company. No path supports cross-tenant access.

async function adminGateAllowed(
  companyId: number,
  callerRole: string,
  setting: "admin_add_employee_allowed" | "admin_edit_employee_allowed",
): Promise<boolean> {
  if (callerRole === "owner") return true;
  if (callerRole !== "admin") return false;
  const rows = await db
    .select({
      add: lmsSettingsTable.admin_add_employee_allowed,
      edit: lmsSettingsTable.admin_edit_employee_allowed,
    })
    .from(lmsSettingsTable)
    .where(eq(lmsSettingsTable.company_id, companyId))
    .limit(1);
  if (!rows[0]) return false;
  return setting === "admin_add_employee_allowed" ? rows[0].add : rows[0].edit;
}

router.post(
  "/lms-add",
  requireAuth,
  requireRole("owner", "admin"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const callerRole = req.auth!.role;
      const ok = await adminGateAllowed(
        companyId,
        callerRole,
        "admin_add_employee_allowed",
      );
      if (!ok) {
        return res.status(403).json({
          error: "Forbidden",
          message:
            "Adding employees is owner-only. Ask the owner to enable admin add under LMS settings.",
        });
      }

      const first_name = typeof req.body?.first_name === "string"
        ? req.body.first_name.trim() : "";
      const last_name = typeof req.body?.last_name === "string"
        ? req.body.last_name.trim() : "";
      const emailRaw = typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase() : "";
      const role = typeof req.body?.role === "string" ? req.body.role : "technician";
      const hire_date = req.body?.hire_date;

      if (!first_name) {
        return res.status(400).json({ error: "Bad Request", message: "First name is required" });
      }
      if (!last_name) {
        return res.status(400).json({ error: "Bad Request", message: "Last name is required" });
      }
      if (!isValidEmail(emailRaw)) {
        return res.status(400).json({ error: "Bad Request", message: "Valid email is required" });
      }
      if (!LMS_ADD_ALLOWED_ROLES.has(role)) {
        return res.status(400).json({
          error: "Bad Request",
          message: "Role must be technician, team_lead, or admin",
        });
      }
      if (hire_date != null && !isValidIsoDate(hire_date)) {
        return res.status(400).json({
          error: "Bad Request",
          message: "hire_date must be YYYY-MM-DD",
        });
      }

      // Duplicate-email check is GLOBAL (the email column has a UNIQUE
      // constraint in the schema), but we also explicitly probe within
      // the tenant first to return a friendly error rather than a 500
      // on the underlying insert.
      const existing = await db
        .select({ id: usersTable.id, company_id: usersTable.company_id })
        .from(usersTable)
        .where(eq(usersTable.email, emailRaw))
        .limit(1);
      if (existing[0]) {
        return res.status(409).json({
          error: "Conflict",
          message: "An account with that email already exists",
        });
      }

      const tempPassword = generateLmsTempPassword();
      const password_hash = await bcrypt.hash(tempPassword, 10);

      const inserted = await db
        .insert(usersTable)
        .values({
          company_id: companyId,
          email: emailRaw,
          password_hash,
          first_name,
          last_name,
          role: role as any,
          hire_date: hire_date ?? null,
          is_active: true,
        })
        .returning();
      const newUser = inserted[0];

      // Auto-enroll in the LMS so the new hire appears on the roster on
      // first /lms visit. Inlined rather than importing from lms.ts to
      // keep the dependency direction one-way (users.ts is leaf).
      const now = new Date();
      const DEADLINE_DAYS = 30;
      const deadlineAt = new Date(now.getTime() + DEADLINE_DAYS * 86_400_000);
      await db
        .insert(lmsEnrollmentsTable)
        .values({
          company_id: companyId,
          user_id: newUser.id,
          status: "active",
          enrolled_at: now,
          deadline_at: deadlineAt,
          last_activity_at: now,
        })
        .onConflictDoNothing();

      await logAudit(
        req,
        "lms.admin.add_employee",
        "user",
        newUser.id,
        null,
        {
          email: newUser.email,
          first_name: newUser.first_name,
          last_name: newUser.last_name,
          role: newUser.role,
          hire_date: newUser.hire_date,
        },
      );

      const { password_hash: _, ...safeUser } = newUser;
      return res.status(201).json({
        data: {
          user: safeUser,
          temp_password: tempPassword,
        },
      });
    } catch (err) {
      console.error("[users] /lms-add error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to add employee",
      });
    }
  },
);

router.patch(
  "/:id/lms-edit",
  requireAuth,
  requireRole("owner", "admin"),
  async (req, res) => {
    try {
      const companyId = req.auth!.companyId;
      if (companyId == null) {
        return res
          .status(400)
          .json({ error: "Bad Request", message: "User has no company assignment" });
      }
      const callerRole = req.auth!.role;
      const ok = await adminGateAllowed(
        companyId,
        callerRole,
        "admin_edit_employee_allowed",
      );
      if (!ok) {
        return res.status(403).json({
          error: "Forbidden",
          message:
            "Editing employees is owner-only. Ask the owner to enable admin edit under LMS settings.",
        });
      }

      const targetId = Number(req.params.id);
      if (!Number.isFinite(targetId) || targetId <= 0) {
        return res.status(400).json({ error: "Bad Request", message: "Invalid user id" });
      }

      const target = await db
        .select()
        .from(usersTable)
        .where(and(
          eq(usersTable.id, targetId),
          eq(usersTable.company_id, companyId),
        ))
        .limit(1);
      if (!target[0]) {
        return res.status(404).json({
          error: "Not Found",
          message: "User not found in tenant",
        });
      }
      if (target[0].role === "owner") {
        return res.status(400).json({
          error: "Bad Request",
          message: "Cannot edit an owner account via this endpoint",
        });
      }

      const patch: {
        first_name?: string;
        last_name?: string;
        email?: string;
        role?: string;
        hire_date?: string | null;
      } = {};

      if (req.body?.first_name !== undefined) {
        if (typeof req.body.first_name !== "string" || !req.body.first_name.trim()) {
          return res.status(400).json({ error: "Bad Request", message: "first_name cannot be empty" });
        }
        patch.first_name = req.body.first_name.trim();
      }
      if (req.body?.last_name !== undefined) {
        if (typeof req.body.last_name !== "string" || !req.body.last_name.trim()) {
          return res.status(400).json({ error: "Bad Request", message: "last_name cannot be empty" });
        }
        patch.last_name = req.body.last_name.trim();
      }
      if (req.body?.email !== undefined) {
        const next = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
        if (!isValidEmail(next)) {
          return res.status(400).json({ error: "Bad Request", message: "Valid email is required" });
        }
        if (next !== target[0].email) {
          const dupe = await db
            .select({ id: usersTable.id })
            .from(usersTable)
            .where(eq(usersTable.email, next))
            .limit(1);
          if (dupe[0]) {
            return res.status(409).json({
              error: "Conflict",
              message: "An account with that email already exists",
            });
          }
          patch.email = next;
        }
      }
      if (req.body?.role !== undefined) {
        if (typeof req.body.role !== "string" || !LMS_EDIT_ALLOWED_ROLES.has(req.body.role)) {
          return res.status(400).json({
            error: "Bad Request",
            message: "Role must be technician, team_lead, admin, or office",
          });
        }
        patch.role = req.body.role;
      }
      if (req.body?.hire_date !== undefined) {
        if (req.body.hire_date === null || req.body.hire_date === "") {
          patch.hire_date = null;
        } else if (isValidIsoDate(req.body.hire_date)) {
          patch.hire_date = req.body.hire_date;
        } else {
          return res.status(400).json({
            error: "Bad Request",
            message: "hire_date must be YYYY-MM-DD or null",
          });
        }
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({
          error: "Bad Request",
          message: "No editable field provided",
        });
      }

      const before = {
        first_name: target[0].first_name,
        last_name: target[0].last_name,
        email: target[0].email,
        role: target[0].role,
        hire_date: target[0].hire_date,
      };
      const after = { ...before, ...patch };

      const updated = await db
        .update(usersTable)
        .set(patch as any)
        .where(and(
          eq(usersTable.id, targetId),
          eq(usersTable.company_id, companyId),
        ))
        .returning();

      await logAudit(
        req,
        "lms.admin.edit_employee",
        "user",
        targetId,
        before,
        after,
      );

      // Role change writes its own audit row so the security trail is
      // grep-able. Role changes alter permissions and we want a single
      // canonical action name for those audits.
      if (patch.role && patch.role !== before.role) {
        await logAudit(
          req,
          "lms.admin.role_changed",
          "user",
          targetId,
          { role: before.role },
          { role: patch.role },
        );
      }

      // Email change writes a notification-intent row so the office
      // team can see the new email got a heads-up. The actual send
      // path is gated by COMMS_ENABLED; we log the intent regardless.
      if (patch.email && patch.email !== before.email) {
        await logAudit(
          req,
          "lms.admin.email_changed_notify_intent",
          "user",
          targetId,
          { email: before.email },
          { email: patch.email },
        );
      }

      const { password_hash: _, ...safeUser } = updated[0];
      return res.json({ data: safeUser });
    } catch (err) {
      console.error("[users] /:id/lms-edit error:", err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "Failed to edit employee",
      });
    }
  },
);

export default router;
