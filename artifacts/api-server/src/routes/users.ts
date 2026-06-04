import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, scorecardsTable, additionalPayTable, jobsTable, clientsTable, serviceZoneEmployeesTable, serviceZonesTable, employeePayrollHistoryTable, lmsSettingsTable, lmsEnrollmentsTable, userCompaniesTable, companiesTable } from "@workspace/db/schema";
import { eq, and, sql, avg, count, desc, isNull, inArray } from "drizzle-orm";
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
    const companyId = req.auth!.companyId;

    // Tenant scope UNION of home + user_companies — a cross-tenant tech
    // shows up in BOTH businesses' employee lists, so each office can see
    // who's eligible to be scheduled.
    const conditions: any[] = [
      sql`(u.company_id = ${companyId}
            OR EXISTS (SELECT 1 FROM user_companies uc
                        WHERE uc.user_id = u.id AND uc.company_id = ${companyId}))`,
    ];
    if (role) conditions.push(sql`u.role = ${role}::user_role`);
    if (is_active !== undefined) conditions.push(sql`u.is_active = ${is_active === "true"}`);
    // home_branch_id (not branch_id — the column was renamed under cutover 1A).
    // Pass-through when present so the employees list can still filter by
    // home branch within a tenant if one's selected.
    //
    // **NULL fall-through.** Cutover 1A's home_branch_id backfill was
    // reverted, so the column is nullable and most existing Phes techs
    // are NULL. Strict `home_branch_id = X` would hide every untagged
    // tech the moment an operator picks a branch — Sal hit this on
    // 2026-06-01 with all 20 active Phes techs invisible under
    // Oak Lawn. Treat NULL as "shows under any branch" so the filter
    // narrows the explicitly-tagged subset without dropping the
    // unassigned default population. Once techs are individually
    // tagged to a branch they'll start filtering normally.
    if (branch_id && branch_id !== "all") {
      const branchIdNum = parseInt(branch_id as string, 10);
      if (Number.isFinite(branchIdNum)) {
        conditions.push(sql`(u.home_branch_id = ${branchIdNum} OR u.home_branch_id IS NULL)`);
      }
    }

    const whereClause = sql.join(conditions, sql` AND `);

    const usersRows = await db.execute(sql`
      SELECT u.id, u.email, u.first_name, u.last_name, u.role::text AS role,
             u.pay_rate, u.pay_type::text AS pay_type, u.is_active,
             u.hire_date, u.avatar_url
        FROM users u
       WHERE ${whereClause}
       ORDER BY u.first_name, u.last_name
       LIMIT ${parseInt(limit as string)}
       OFFSET ${offset}
    `);

    const totalRow = await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM users u
       WHERE ${whereClause}
    `);

    return res.json({
      data: (usersRows.rows as any[]).map(u => ({ ...u, productivity_pct: null })),
      total: (totalRow.rows[0] as any)?.n ?? 0,
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
    // to that branch. Omit (or pass "all") to get the unfiltered list.
    const branchIdRaw = req.query.branch_id;
    const branchIdNum = (typeof branchIdRaw === "string" && branchIdRaw !== "all" && branchIdRaw !== "")
      ? parseInt(branchIdRaw, 10) : null;

    // Tenant scope is UNION of home + user_companies. A tech whose home is
    // Phes but has a user_companies row in PHES Schaumburg must appear when
    // Schaumburg's office is dispatching. The home_branch_id filter applies
    // only when both sides actually carry it (NULL home_branch is fine —
    // those techs are dispatchable to any branch).
    const rows = await db.execute(sql`
      SELECT u.id, u.first_name, u.last_name, u.role, u.home_branch_id AS branch_id,
             (SELECT tc.job_id FROM timeclock tc
               WHERE tc.user_id = u.id
                 AND tc.clock_out_at IS NULL
               ORDER BY tc.clock_in_at DESC LIMIT 1) AS active_job_id
        FROM users u
       WHERE u.is_active = true
         AND u.role IN ('technician','team_lead')
         AND (
              u.company_id = ${companyId}
           OR EXISTS (SELECT 1 FROM user_companies uc
                       WHERE uc.user_id = u.id AND uc.company_id = ${companyId})
         )
         ${branchIdNum != null && Number.isFinite(branchIdNum)
           ? sql`AND (u.home_branch_id = ${branchIdNum} OR u.home_branch_id IS NULL)`
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
    const callerRole = req.auth!.role;
    const callerId = req.auth!.userId;

    // 2026-05-22 (Sal): "Ensure Francisco and Maribel cannot edit any
    // of their own settings as they are counterparts." Admins are peers
    // to each other — only the owner sits above them in the chain. So:
    //   - admin CANNOT edit themselves
    //   - admin CANNOT edit another admin
    // Owner / super_admin are unrestricted by this rule (the owner sits
    // above all admins; super_admin is the Qleno-side bypass).
    if (callerRole === "admin") {
      if (userId === callerId) {
        return res.status(403).json({
          error: "Forbidden",
          message: "Admins cannot edit their own user record. Ask the owner.",
        });
      }
      const peer = await db
        .select({ role: usersTable.role })
        .from(usersTable)
        .where(and(eq(usersTable.id, userId), eq(usersTable.company_id, req.auth!.companyId)))
        .limit(1);
      if (peer[0]?.role === "admin") {
        return res.status(403).json({
          error: "Forbidden",
          message: "Admins cannot edit another admin's record. Ask the owner.",
        });
      }
    }

    const {
      first_name, last_name, role, pay_rate, pay_type, is_active,
      hire_date, phone, skills, avatar_url,
      // [pay-matrix 2026-04-29] 4-cell pay matrix.
      residential_pay_type, residential_pay_rate,
      commercial_pay_type,  commercial_pay_rate,
    } = req.body;

    // Only the OWNER may change a user's role (grant/revoke admin etc.).
    // Per Sal: admin privileges are owner-controlled — office/admin cannot
    // elevate anyone (or themselves). Same-role passthrough is allowed so
    // non-owners can still edit other fields without tripping this.
    if (role !== undefined && callerRole !== "owner") {
      const cur = await db
        .select({ role: usersTable.role })
        .from(usersTable)
        .where(and(eq(usersTable.id, userId), eq(usersTable.company_id, req.auth!.companyId)))
        .limit(1);
      if (cur[0] && cur[0].role !== role) {
        return res.status(403).json({
          error: "Forbidden",
          message: "Only the owner can change a user's role.",
        });
      }
    }

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
        ...(avatar_url !== undefined && { avatar_url }),
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
    const callerRole = req.auth!.role;

    // 2026-05-22 (Sal): admins cannot deactivate themselves OR another
    // admin (same counterpart rule as PUT / lms-edit). Only the owner
    // can deactivate an admin.
    if (callerRole === "admin") {
      if (userId === req.auth!.userId) {
        return res.status(403).json({
          error: "Forbidden",
          message: "Admins cannot deactivate their own account. Ask the owner.",
        });
      }
      const peer = await db
        .select({ role: usersTable.role })
        .from(usersTable)
        .where(and(eq(usersTable.id, userId), eq(usersTable.company_id, req.auth!.companyId)))
        .limit(1);
      if (peer[0]?.role === "admin") {
        return res.status(403).json({
          error: "Forbidden",
          message: "Admins cannot deactivate another admin. Ask the owner.",
        });
      }
    }

    // [inactive-tech-unassigned 2026-06-04] Release this tech's open (not-yet-
    // completed) jobs so they fall to Unassigned on the dispatch board instead
    // of disappearing with the deactivated user. Completed jobs keep their
    // assignment (payroll/history). The dispatch board also guards defensively,
    // but clearing the source here keeps the data clean (assignment-mirror
    // invariant: jobs.assigned_user_id is the dispatch source of truth).
    const released = await db.execute(sql`
      UPDATE jobs SET assigned_user_id = NULL
      WHERE assigned_user_id = ${userId}
        AND company_id = ${req.auth!.companyId}
        AND status <> 'complete'
    `);
    try {
      await db.execute(sql`
        DELETE FROM job_technicians jt
        USING jobs j
        WHERE jt.job_id = j.id AND jt.user_id = ${userId}
          AND j.company_id = ${req.auth!.companyId} AND j.status <> 'complete'
      `);
    } catch (e) { console.error("[deactivate] job_technicians cleanup skipped:", (e as any)?.message); }

    await db
      .update(usersTable)
      .set({ is_active: false })
      .where(and(
        eq(usersTable.id, userId),
        eq(usersTable.company_id, req.auth!.companyId)
      ));
    logAudit(req, "DELETE_EMPLOYEE", "employee", userId, null, {
      is_active: false, jobs_released_to_unassigned: (released as any)?.rowCount ?? undefined,
    });
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
// Per-employee tenant membership: read / grant / revoke
// ─────────────────────────────────────────────────────────────────────────────
//
// Under the tenant-separated model (Phes Oak Lawn / PHES Schaumburg as
// distinct companies), an employee is "schedulable at" a tenant iff there's
// a user_companies row linking them. user.company_id remains the employee's
// "home tenant" (where their record was created); cross-tenant access is
// granted additively through these endpoints.
//
// Auth model:
//   - Read: any signed-in user can read their own memberships; owner/admin
//     of the CURRENT tenant can read any user's memberships (so they can
//     see what tenants their workforce is already scheduled in).
//   - Grant/Revoke: the caller must be owner/admin of the TARGET company.
//     Sal can grant Phes membership; Ivan (when added) can grant Schaumburg
//     membership. Neither can grant access to the other's tenant.
//
// We always force the target user's "home" company_id membership to exist
// (an employee MUST be a member of their home tenant); revoke refuses to
// remove that anchor row.

function asMembership(row: any) {
  return {
    company_id: row.company_id,
    company_name: row.company_name,
    role: row.role,
    created_at: row.created_at,
  };
}

router.get(
  "/:id/companies",
  requireAuth,
  async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isFinite(targetId) || targetId <= 0) {
        return res.status(400).json({ error: "Bad Request", message: "Invalid user id" });
      }

      const isSelf = req.auth!.userId === targetId;
      const isPrivileged = req.auth!.role === "owner" || req.auth!.role === "admin";
      if (!isSelf && !isPrivileged) {
        return res.status(403).json({ error: "Forbidden", message: "Cannot view other users' tenant memberships" });
      }

      // Confirm the target user exists. We don't require them to share the
      // caller's tenant — an owner viewing a cross-tenant employee needs to
      // see all memberships including the ones they don't control.
      const target = await db
        .select({ id: usersTable.id, home_company_id: usersTable.company_id })
        .from(usersTable)
        .where(eq(usersTable.id, targetId))
        .limit(1);
      if (!target[0]) {
        return res.status(404).json({ error: "Not Found", message: "User not found" });
      }

      const rows = await db
        .select({
          company_id: userCompaniesTable.company_id,
          role: userCompaniesTable.role,
          created_at: userCompaniesTable.created_at,
          company_name: companiesTable.name,
        })
        .from(userCompaniesTable)
        .innerJoin(companiesTable, eq(userCompaniesTable.company_id, companiesTable.id))
        .where(eq(userCompaniesTable.user_id, targetId))
        .orderBy(userCompaniesTable.company_id);

      return res.json({
        data: rows.map(asMembership),
        home_company_id: target[0].home_company_id,
      });
    } catch (err) {
      console.error("Get user companies error:", err);
      return res.status(500).json({ error: "Internal Server Error", message: "Failed to load tenant memberships" });
    }
  },
);

router.post(
  "/:id/companies",
  requireAuth,
  requireRole("owner", "admin"),
  async (req, res) => {
    try {
      const targetUserId = Number(req.params.id);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: "Bad Request", message: "Invalid user id" });
      }
      const companyId = Number(req.body?.company_id);
      if (!Number.isFinite(companyId) || companyId <= 0) {
        return res.status(400).json({ error: "Bad Request", message: "company_id (number) required" });
      }
      const memberRole = typeof req.body?.role === "string" && req.body.role.length > 0
        ? req.body.role : "member";

      // Caller must be an owner/admin OF THE TARGET TENANT. Verified via
      // user_companies — the per-tenant access table is the source of truth.
      const callerMembership = await db
        .select({ role: userCompaniesTable.role })
        .from(userCompaniesTable)
        .where(and(
          eq(userCompaniesTable.user_id, req.auth!.userId),
          eq(userCompaniesTable.company_id, companyId),
        ))
        .limit(1);
      const callerRoleInTarget = callerMembership[0]?.role ?? "";
      const callerCanGrantThere =
        callerRoleInTarget === "owner" || callerRoleInTarget === "admin";
      if (!callerCanGrantThere) {
        return res.status(403).json({
          error: "Forbidden",
          message: "You can only grant access to tenants you administer",
        });
      }

      // Target user must exist.
      const target = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.id, targetUserId))
        .limit(1);
      if (!target[0]) {
        return res.status(404).json({ error: "Not Found", message: "User not found" });
      }

      // Idempotent insert. The (user_id, company_id) unique constraint
      // turns a duplicate into a no-op.
      await db.execute(sql`
        INSERT INTO user_companies (user_id, company_id, role)
        VALUES (${targetUserId}, ${companyId}, ${memberRole})
        ON CONFLICT (user_id, company_id) DO NOTHING
      `);

      await logAudit(req, "user_companies_grant", "user", targetUserId, null, {
        company_id: companyId,
        role: memberRole,
      });

      return res.status(201).json({ ok: true, user_id: targetUserId, company_id: companyId, role: memberRole });
    } catch (err) {
      console.error("Grant user company error:", err);
      return res.status(500).json({ error: "Internal Server Error", message: "Failed to grant tenant access" });
    }
  },
);

router.delete(
  "/:id/companies/:companyId",
  requireAuth,
  requireRole("owner", "admin"),
  async (req, res) => {
    try {
      const targetUserId = Number(req.params.id);
      const companyId = Number(req.params.companyId);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0 || !Number.isFinite(companyId) || companyId <= 0) {
        return res.status(400).json({ error: "Bad Request", message: "Invalid ids" });
      }

      // Caller must administer the target tenant.
      const callerMembership = await db
        .select({ role: userCompaniesTable.role })
        .from(userCompaniesTable)
        .where(and(
          eq(userCompaniesTable.user_id, req.auth!.userId),
          eq(userCompaniesTable.company_id, companyId),
        ))
        .limit(1);
      const callerRoleInTarget = callerMembership[0]?.role ?? "";
      if (callerRoleInTarget !== "owner" && callerRoleInTarget !== "admin") {
        return res.status(403).json({
          error: "Forbidden",
          message: "You can only revoke access to tenants you administer",
        });
      }

      // Refuse to remove the anchor — every employee must be a member of
      // their home tenant. Without this, the employee record orphans from
      // any tenant they can log into and reports break.
      const target = await db
        .select({ home_company_id: usersTable.company_id })
        .from(usersTable)
        .where(eq(usersTable.id, targetUserId))
        .limit(1);
      if (!target[0]) {
        return res.status(404).json({ error: "Not Found", message: "User not found" });
      }
      if (target[0].home_company_id === companyId) {
        return res.status(400).json({
          error: "Bad Request",
          message: "Cannot revoke the employee's home tenant. Change users.company_id first or delete the employee.",
        });
      }

      const deleted = await db
        .delete(userCompaniesTable)
        .where(and(
          eq(userCompaniesTable.user_id, targetUserId),
          eq(userCompaniesTable.company_id, companyId),
        ))
        .returning({ id: userCompaniesTable.user_id });

      await logAudit(req, "user_companies_revoke", "user", targetUserId, null, {
        company_id: companyId,
      });

      return res.json({ ok: true, removed: deleted.length });
    } catch (err) {
      console.error("Revoke user company error:", err);
      return res.status(500).json({ error: "Internal Server Error", message: "Failed to revoke tenant access" });
    }
  },
);

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
      // home_branch_id is OPTIONAL. Under the tenant-separated model (Phes
      // Oak Lawn / PHES Schaumburg as distinct companies), "where can this
      // employee work" is answered by user_companies membership, not by a
      // branch field inside one tenant. The column still exists for any
      // future intra-tenant use and is accepted on input when sent.
      const home_branch_raw = req.body?.home_branch_id;
      const home_branch_id: number | null = typeof home_branch_raw === "number"
        ? home_branch_raw
        : typeof home_branch_raw === "string" && home_branch_raw.length > 0
          ? parseInt(home_branch_raw, 10)
          : null;

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
      // If a home_branch_id was passed in, validate it belongs to this tenant.
      // No value is fine; we don't require it.
      if (home_branch_id !== null && Number.isFinite(home_branch_id)) {
        const branchRow = await db.execute(
          sql`SELECT id FROM branches WHERE id = ${home_branch_id} AND company_id = ${companyId} LIMIT 1`,
        );
        if ((branchRow.rows as any[]).length === 0) {
          return res.status(400).json({
            error: "Bad Request",
            message: "home_branch_id does not belong to this tenant",
          });
        }
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
          home_branch_id: home_branch_id ?? null,
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

      // 2026-05-22 (Sal): admins cannot edit themselves OR another admin
      // (they are counterparts in the chain — only the owner sits above).
      if (callerRole === "admin") {
        if (targetId === req.auth!.userId) {
          return res.status(403).json({
            error: "Forbidden",
            message: "Admins cannot edit their own user record. Ask the owner.",
          });
        }
        if (target[0].role === "admin") {
          return res.status(403).json({
            error: "Forbidden",
            message: "Admins cannot edit another admin's record. Ask the owner.",
          });
        }
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
