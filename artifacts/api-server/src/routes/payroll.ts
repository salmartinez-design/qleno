import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, timeclockTable, additionalPayTable, jobsTable, clientsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, sum, count, sql, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

router.get("/summary", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { pay_period_start, pay_period_end, branch_id } = req.query;
    const branchFilter = branch_id && branch_id !== "all" ? parseInt(branch_id as string) : null;

    if (!pay_period_start || !pay_period_end) {
      return res.status(400).json({ error: "Bad Request", message: "pay_period_start and pay_period_end are required" });
    }

    const empConds: any[] = [eq(usersTable.company_id, req.auth!.companyId), eq(usersTable.is_active, true)];
    if (branchFilter) empConds.push(eq(usersTable.branch_id, branchFilter));
    const employees = await db.select().from(usersTable).where(and(...empConds));

    const timeclockData = await db
      .select({
        user_id: timeclockTable.user_id,
        duration: sql<number>`EXTRACT(EPOCH FROM (${timeclockTable.clock_out_at} - ${timeclockTable.clock_in_at})) / 3600`,
      })
      .from(timeclockTable)
      .where(and(
        eq(timeclockTable.company_id, req.auth!.companyId),
        gte(timeclockTable.clock_in_at, new Date(pay_period_start as string)),
        lte(timeclockTable.clock_in_at, new Date(pay_period_end as string))
      ));

    const jobSumConds: any[] = [
      eq(jobsTable.company_id, req.auth!.companyId),
      eq(jobsTable.status, "complete"),
      gte(jobsTable.scheduled_date, pay_period_start as string),
      lte(jobsTable.scheduled_date, pay_period_end as string),
    ];
    if (branchFilter) jobSumConds.push(eq(jobsTable.branch_id, branchFilter));
    const jobsData = await db
      .select({ user_id: jobsTable.assigned_user_id, cnt: count(), total_fee: sum(jobsTable.base_fee) })
      .from(jobsTable).where(and(...jobSumConds)).groupBy(jobsTable.assigned_user_id);

    const additionalPayData = await db
      .select({
        user_id: additionalPayTable.user_id,
        type: additionalPayTable.type,
        total: sum(additionalPayTable.amount),
      })
      .from(additionalPayTable)
      .where(and(
        eq(additionalPayTable.company_id, req.auth!.companyId),
        gte(additionalPayTable.created_at, new Date(pay_period_start as string)),
        lte(additionalPayTable.created_at, new Date(pay_period_end as string))
      ))
      .groupBy(additionalPayTable.user_id, additionalPayTable.type);

    const hoursMap = new Map<number, number>();
    for (const row of timeclockData) {
      const current = hoursMap.get(row.user_id) || 0;
      hoursMap.set(row.user_id, current + (row.duration || 0));
    }

    const jobsMap = new Map<number, { count: number; total_fee: number }>();
    for (const row of jobsData) {
      if (row.user_id) {
        jobsMap.set(row.user_id, { count: row.cnt, total_fee: parseFloat(row.total_fee || "0") });
      }
    }

    const additionalMap = new Map<number, Record<string, number>>();
    for (const row of additionalPayData) {
      if (!additionalMap.has(row.user_id)) additionalMap.set(row.user_id, {});
      const entry = additionalMap.get(row.user_id)!;
      entry[row.type] = parseFloat(row.total || "0");
    }

    const payrollEmployees = employees.map(emp => {
      const hours = hoursMap.get(emp.id) || 0;
      const jobs = jobsMap.get(emp.id) || { count: 0, total_fee: 0 };
      const additional = additionalMap.get(emp.id) || {};
      const payRate = parseFloat(emp.pay_rate || "0");

      let base_pay = 0;
      if (emp.pay_type === "hourly") {
        base_pay = hours * payRate;
      } else if (emp.pay_type === "per_job") {
        base_pay = jobs.count * payRate;
      } else if (emp.pay_type === "fee_split") {
        const splitPct = parseFloat(emp.fee_split_pct || "0") / 100;
        base_pay = jobs.total_fee * splitPct;
      }

      const tips = additional.tips || 0;
      const bonuses = additional.bonus || 0;
      const sick_pay = additional.sick_pay || 0;
      const holiday_pay = additional.holiday_pay || 0;
      const vacation_pay = additional.vacation_pay || 0;
      const deductions = additional.amount_owed || 0;
      const gross_pay = base_pay + tips + bonuses + sick_pay + holiday_pay + vacation_pay - deductions;

      return {
        user_id: emp.id,
        name: `${emp.first_name} ${emp.last_name}`,
        pay_type: emp.pay_type || "hourly",
        pay_rate: payRate,
        hours_worked: Math.round(hours * 100) / 100,
        jobs_completed: jobs.count,
        base_pay: Math.round(base_pay * 100) / 100,
        tips,
        bonuses,
        sick_pay,
        holiday_pay,
        vacation_pay,
        deductions,
        gross_pay: Math.round(gross_pay * 100) / 100,
      };
    });

    const total_gross = payrollEmployees.reduce((s, e) => s + e.gross_pay, 0);
    const total_hours = payrollEmployees.reduce((s, e) => s + e.hours_worked, 0);
    const total_jobs = payrollEmployees.reduce((s, e) => s + e.jobs_completed, 0);

    return res.json({
      pay_period_start,
      pay_period_end,
      employees: payrollEmployees,
      total_gross: Math.round(total_gross * 100) / 100,
      total_hours: Math.round(total_hours * 100) / 100,
      total_jobs,
    });
  } catch (err) {
    console.error("Payroll summary error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get payroll summary" });
  }
});

// ── Payroll Detail (per-job breakdown) ────────────────────────────────────────

router.get("/detail", requireAuth, async (req, res) => {
  try {
    const { pay_period_start, pay_period_end, user_id } = req.query;
    if (!pay_period_start || !pay_period_end) {
      return res.status(400).json({ error: "pay_period_start and pay_period_end are required" });
    }

    const role = (req as any).auth!.role;
    const myUserId = (req as any).auth!.userId;
    const companyId = (req as any).auth!.companyId;

    // Techs can only see their own data
    const filterUserId = role === "technician" ? myUserId : (user_id ? parseInt(user_id as string) : null);

    // Get company payroll settings (using raw SQL since columns added via ALTER TABLE)
    const compRows = await db.execute(sql`SELECT res_tech_pay_pct, commercial_hourly_rate, commercial_comp_mode FROM companies WHERE id = ${companyId} LIMIT 1`);
    const compSettings = (compRows.rows[0] as any) || { res_tech_pay_pct: 0.35, commercial_hourly_rate: 20.00, commercial_comp_mode: "allowed_hours" };
    const resPct = parseFloat(String(compSettings.res_tech_pay_pct ?? 0.35));

    // Get all techs (to calculate num_techs_on_job approximation)
    const jobConditions: any[] = [
      eq(jobsTable.company_id, companyId),
      eq(jobsTable.status, "complete"),
      gte(jobsTable.scheduled_date, pay_period_start as string),
      lte(jobsTable.scheduled_date, pay_period_end as string),
    ];
    if (filterUserId) jobConditions.push(eq(jobsTable.assigned_user_id, filterUserId));

    const jobs = await db
      .select({
        id: jobsTable.id,
        scheduled_date: jobsTable.scheduled_date,
        service_type: jobsTable.service_type,
        base_fee: jobsTable.base_fee,
        billed_amount: jobsTable.billed_amount,
        allowed_hours: jobsTable.allowed_hours,
        actual_hours: jobsTable.actual_hours,
        assigned_user_id: jobsTable.assigned_user_id,
        client_first: clientsTable.first_name,
        client_last: clientsTable.last_name,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(jobsTable.client_id, clientsTable.id))
      .where(and(...jobConditions))
      .orderBy(jobsTable.scheduled_date);

    // Get additional pay for the period (tips, mileage — period level, not per job)
    const addlPayConditions: any[] = [
      eq(additionalPayTable.company_id, companyId),
      gte(additionalPayTable.created_at, new Date(pay_period_start as string)),
      lte(additionalPayTable.created_at, new Date(pay_period_end as string)),
    ];
    if (filterUserId) addlPayConditions.push(eq(additionalPayTable.user_id, filterUserId));

    const addlPay = await db
      .select({ user_id: additionalPayTable.user_id, type: additionalPayTable.type, amount: additionalPayTable.amount, notes: additionalPayTable.notes })
      .from(additionalPayTable)
      .where(and(...addlPayConditions));

    // Group jobs by user
    const byUser = new Map<number, typeof jobs>();
    for (const job of jobs) {
      const uid = job.assigned_user_id ?? 0;
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid)!.push(job);
    }

    // Get all relevant users
    const userIds = [...new Set(jobs.map(j => j.assigned_user_id).filter(Boolean))];
    const allUsers = userIds.length
      ? await db.select({ id: usersTable.id, first_name: usersTable.first_name, last_name: usersTable.last_name }).from(usersTable).where(inArray(usersTable.id, userIds as number[]))
      : [];

    const userMap = new Map(allUsers.map(u => [u.id, u]));

    const result = [];
    for (const [uid, userJobs] of byUser) {
      const user = userMap.get(uid) || { first_name: "Unknown", last_name: "" };
      const userAddlPay = addlPay.filter(p => p.user_id === uid);

      // Fetch job_technicians final_pay for this user's jobs in the period
    const jobIdList = userJobs.map(j => j.id);
    const jtMap = new Map<number, number>();
    if (jobIdList.length > 0) {
      try {
        const jtRows = await db.execute(
          sql`SELECT job_id, final_pay FROM job_technicians WHERE user_id = ${uid} AND job_id = ANY(${jobIdList}::int[])`
        );
        for (const r of jtRows.rows as any[]) {
          if (r.final_pay != null) jtMap.set(r.job_id, parseFloat(String(r.final_pay)));
        }
      } catch { /* job_technicians may not exist yet; fallback to formula */ }
    }

    const jobRows = userJobs.map(job => {
        const jobTotal = parseFloat(String(job.billed_amount || job.base_fee || 0));
        const calcCommission = Math.round(jobTotal * resPct * 100) / 100;
        const commission = jtMap.has(job.id) ? jtMap.get(job.id)! : calcCommission;
        const allowedHrs = parseFloat(String(job.allowed_hours || 0));
        const workedHrs = parseFloat(String(job.actual_hours || 0));
        const effectiveRate = workedHrs > 0 ? Math.round((commission / workedHrs) * 100) / 100 : null;
        return {
          job_id: job.id,
          date: job.scheduled_date,
          client: `${job.client_first || ""} ${job.client_last || ""}`.trim(),
          scope: job.service_type,
          job_total: jobTotal,
          commission,
          commission_overridden: jtMap.has(job.id),
          hrs_scheduled: allowedHrs,
          hrs_worked: workedHrs,
          effective_rate: effectiveRate,
        };
      });

      // Additional pay by type
      const addlByType: Record<string, number> = {};
      for (const p of userAddlPay) {
        addlByType[p.type] = (addlByType[p.type] || 0) + parseFloat(String(p.amount || 0));
      }

      const totalCommission = jobRows.reduce((s, j) => s + j.commission, 0);
      const totalJobTotal = jobRows.reduce((s, j) => s + j.job_total, 0);
      const totalHrsScheduled = jobRows.reduce((s, j) => s + j.hrs_scheduled, 0);
      const totalHrsWorked = jobRows.reduce((s, j) => s + j.hrs_worked, 0);
      const grandTotal = totalCommission + Object.values(addlByType).reduce((s, v) => s + v, 0);

      result.push({
        user_id: uid,
        name: `${user.first_name} ${user.last_name}`.trim(),
        jobs: jobRows,
        additional_pay: addlByType,
        totals: {
          job_count: jobRows.length,
          job_total: Math.round(totalJobTotal * 100) / 100,
          commission: Math.round(totalCommission * 100) / 100,
          hrs_scheduled: Math.round(totalHrsScheduled * 100) / 100,
          hrs_worked: Math.round(totalHrsWorked * 100) / 100,
          grand_total: Math.round(grandTotal * 100) / 100,
        },
      });
    }

    return res.json({ data: result, res_tech_pay_pct: resPct });
  } catch (err) {
    console.error("Payroll detail error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to get payroll detail" });
  }
});

// ── Pay Templates ─────────────────────────────────────────────────────────────

router.get("/templates", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const rows = await db.execute(
      sql`SELECT * FROM pay_templates WHERE company_id = ${req.auth!.companyId} ORDER BY id`
    );
    return res.json({ data: rows.rows });
  } catch (err) {
    console.error("GET /payroll/templates:", err);
    return res.status(500).json({ error: "Failed to load templates" });
  }
});

router.post("/templates", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { name, type, amount, notes } = req.body;
    if (!name || !type || !amount) return res.status(400).json({ error: "name, type, amount required" });
    const rows = await db.execute(
      sql`INSERT INTO pay_templates (company_id, name, type, amount, notes) VALUES (${req.auth!.companyId}, ${name}, ${type}, ${parseFloat(amount)}, ${notes || null}) RETURNING *`
    );
    return res.json({ data: rows.rows[0] });
  } catch (err) {
    console.error("POST /payroll/templates:", err);
    return res.status(500).json({ error: "Failed to create template" });
  }
});

router.delete("/templates/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    await db.execute(
      sql`DELETE FROM pay_templates WHERE id = ${parseInt(req.params.id)} AND company_id = ${req.auth!.companyId}`
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE /payroll/templates/:id:", err);
    return res.status(500).json({ error: "Failed to delete template" });
  }
});

// ── Bulk Pay ──────────────────────────────────────────────────────────────────

router.post("/bulk-pay", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { employee_ids, type, amount, notes } = req.body;
    if (!Array.isArray(employee_ids) || !employee_ids.length || !type || !amount) {
      return res.status(400).json({ error: "employee_ids (array), type, amount required" });
    }
    const companyId = req.auth!.companyId;
    const parsedAmount = parseFloat(amount);

    // Verify all employees belong to this company
    const emps = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.company_id, companyId), inArray(usersTable.id, employee_ids)));

    if (emps.length !== employee_ids.length) {
      return res.status(403).json({ error: "One or more employees not found in your company" });
    }

    const inserts = emps.map(e => ({
      company_id: companyId,
      user_id: e.id,
      type,
      amount: parsedAmount.toFixed(2),
      notes: notes || null,
      status: "pending" as const,
    }));

    await db.insert(additionalPayTable).values(inserts);
    return res.json({ success: true, count: inserts.length });
  } catch (err) {
    console.error("POST /payroll/bulk-pay:", err);
    return res.status(500).json({ error: "Failed to create bulk pay entries" });
  }
});

export default router;
