import { Router } from "express";
import { db } from "@workspace/db";
import {
  employeeAttendanceLogTable,
  employeeDisciplineLogTable,
  companyAttendancePolicyTable,
  usersTable,
} from "@workspace/db/schema";
import { eq, and, gte, desc, count, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();
const LOG_ROLES = requireRole("owner", "admin", "office");

router.post("/", requireAuth, LOG_ROLES, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const loggedBy = req.auth!.userId!;
    const { employee_id, log_date, type, protected: isProtected, notes } = req.body;
    if (!employee_id || !log_date || !type) return res.status(400).json({ error: "employee_id, log_date, type required" });

    const [entry] = await db.insert(employeeAttendanceLogTable).values({
      company_id: companyId,
      employee_id,
      log_date,
      type,
      protected: isProtected ?? false,
      notes,
      logged_by: loggedBy,
    }).returning();

    if (!isProtected) {
      await checkThresholds(companyId, employee_id, loggedBy);
    }

    // [90d-composite] A logged tardy/absent/ncns moves the tech's attendance
    // sub-score → recompute the rolling composite. Non-fatal.
    try {
      const { recomputeCompositeScore } = await import("../lib/scorecard-composite.js");
      await recomputeCompositeScore(companyId, employee_id);
    } catch (e: any) {
      console.error("[scorecard-composite] recompute after attendance log failed (non-fatal):", e?.message ?? e);
    }

    return res.json(entry);
  } catch (err) {
    console.error("hr-attendance POST error:", err);
    return res.status(500).json({ error: "Failed to log attendance" });
  }
});

router.get("/today", requireAuth, LOG_ROLES, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const today = new Date().toISOString().slice(0, 10);
    const logs = await db
      .select({
        id: employeeAttendanceLogTable.id,
        employee_id: employeeAttendanceLogTable.employee_id,
        log_date: employeeAttendanceLogTable.log_date,
        type: employeeAttendanceLogTable.type,
        protected: employeeAttendanceLogTable.protected,
        notes: employeeAttendanceLogTable.notes,
        first_name: usersTable.first_name,
        last_name: usersTable.last_name,
      })
      .from(employeeAttendanceLogTable)
      .leftJoin(usersTable, eq(employeeAttendanceLogTable.employee_id, usersTable.id))
      .where(and(
        eq(employeeAttendanceLogTable.company_id, companyId),
        eq(employeeAttendanceLogTable.log_date, today),
      ))
      .orderBy(desc(employeeAttendanceLogTable.created_at));
    return res.json(logs);
  } catch (err) {
    console.error("hr-attendance today error:", err);
    return res.status(500).json({ error: "Failed to fetch today's attendance" });
  }
});

router.get("/", requireAuth, LOG_ROLES, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { employee_id } = req.query;
    if (!employee_id) return res.status(400).json({ error: "employee_id required" });

    const logs = await db
      .select({
        id: employeeAttendanceLogTable.id,
        employee_id: employeeAttendanceLogTable.employee_id,
        log_date: employeeAttendanceLogTable.log_date,
        type: employeeAttendanceLogTable.type,
        protected: employeeAttendanceLogTable.protected,
        notes: employeeAttendanceLogTable.notes,
        logged_by: employeeAttendanceLogTable.logged_by,
        created_at: employeeAttendanceLogTable.created_at,
        logger_first_name: sql<string>`(select first_name from users where id = ${employeeAttendanceLogTable.logged_by})`,
        logger_last_name: sql<string>`(select last_name from users where id = ${employeeAttendanceLogTable.logged_by})`,
      })
      .from(employeeAttendanceLogTable)
      .where(and(
        eq(employeeAttendanceLogTable.company_id, companyId),
        eq(employeeAttendanceLogTable.employee_id, parseInt(employee_id as string)),
      ))
      .orderBy(desc(employeeAttendanceLogTable.log_date));
    return res.json(logs);
  } catch (err) {
    console.error("hr-attendance GET error:", err);
    return res.status(500).json({ error: "Failed to fetch attendance" });
  }
});

router.post("/check-thresholds", requireAuth, LOG_ROLES, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { employee_id } = req.body;
    if (!employee_id) return res.status(400).json({ error: "employee_id required" });
    const result = await checkThresholds(companyId, employee_id, req.auth!.userId!);
    return res.json(result);
  } catch (err) {
    console.error("check-thresholds error:", err);
    return res.status(500).json({ error: "Failed to check thresholds" });
  }
});

async function checkThresholds(companyId: number, employeeId: number, issuedBy: number) {
  const policyRows = await db.select().from(companyAttendancePolicyTable).where(eq(companyAttendancePolicyTable.company_id, companyId)).limit(1);
  if (!policyRows.length) return { checked: false };
  const policy = policyRows[0];

  const yearStart = policy.benefit_year_basis === "hire_date_anniversary"
    ? await getHireDateYearStart(employeeId)
    : `${new Date().getFullYear()}-01-01`;

  const tardyCount = await db.select({ count: count() }).from(employeeAttendanceLogTable).where(and(
    eq(employeeAttendanceLogTable.company_id, companyId),
    eq(employeeAttendanceLogTable.employee_id, employeeId),
    eq(employeeAttendanceLogTable.type, "tardy"),
    eq(employeeAttendanceLogTable.protected, false),
    gte(employeeAttendanceLogTable.log_date, yearStart),
  ));
  const absenceCount = await db.select({ count: count() }).from(employeeAttendanceLogTable).where(and(
    eq(employeeAttendanceLogTable.company_id, companyId),
    eq(employeeAttendanceLogTable.employee_id, employeeId),
    eq(employeeAttendanceLogTable.type, "absent"),
    eq(employeeAttendanceLogTable.protected, false),
    gte(employeeAttendanceLogTable.log_date, yearStart),
  ));

  const tc = tardyCount[0].count;
  const ac = absenceCount[0].count;

  const tardySteps: any[] = (policy.tardy_steps as any[]) || [];
  const absenceSteps: any[] = (policy.absence_steps as any[]) || [];

  const matchedTardy = tardySteps.find((s: any) => s.step === tc);
  const matchedAbsence = absenceSteps.find((s: any) => s.step === ac);

  const created: any[] = [];

  if (matchedTardy && matchedTardy.action !== "record_only") {
    const dt = matchedTardy.action === "termination" ? "termination" : matchedTardy.action === "final_warning" ? "final_warning" : "tardy_warning";
    await db.insert(employeeDisciplineLogTable).values({
      company_id: companyId,
      employee_id: employeeId,
      discipline_type: dt as any,
      reason: `Auto-generated: ${tc} tardiness event(s) this benefit year.`,
      effective_date: new Date().toISOString().slice(0, 10),
      issued_by: issuedBy,
      pending_review: true,
    });
    created.push({ type: "tardy", step: tc, action: matchedTardy.action });
  }

  if (matchedAbsence && matchedAbsence.action !== "record_only") {
    const dt = matchedAbsence.action === "termination" ? "termination" : matchedAbsence.action === "final_warning" ? "final_warning" : "absence_warning";
    await db.insert(employeeDisciplineLogTable).values({
      company_id: companyId,
      employee_id: employeeId,
      discipline_type: dt as any,
      reason: `Auto-generated: ${ac} absence event(s) this benefit year.`,
      effective_date: new Date().toISOString().slice(0, 10),
      issued_by: issuedBy,
      pending_review: true,
    });
    created.push({ type: "absence", step: ac, action: matchedAbsence.action });
  }

  return { checked: true, tardy_count: tc, absence_count: ac, auto_discipline: created };
}

async function getHireDateYearStart(employeeId: number): Promise<string> {
  const rows = await db.select({ hire_date: usersTable.hire_date }).from(usersTable).where(eq(usersTable.id, employeeId)).limit(1);
  if (!rows.length || !rows[0].hire_date) return `${new Date().getFullYear()}-01-01`;
  const hd = new Date(rows[0].hire_date);
  const now = new Date();
  const thisYear = now.getFullYear();
  const ann = new Date(thisYear, hd.getMonth(), hd.getDate());
  const yearStart = ann > now ? new Date(thisYear - 1, hd.getMonth(), hd.getDate()) : ann;
  return yearStart.toISOString().slice(0, 10);
}

export default router;
