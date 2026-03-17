import { Router } from "express";
import { db } from "@workspace/db";
import { incentiveProgramsTable, incentiveEarnedTable, usersTable } from "@workspace/db/schema";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

// GET /api/incentives/programs
router.get("/programs", requireAuth, async (req, res) => {
  try {
    const rows = await db.select().from(incentiveProgramsTable)
      .where(eq(incentiveProgramsTable.company_id, req.auth!.companyId))
      .orderBy(desc(incentiveProgramsTable.created_at));
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/programs", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { name, type, trigger_metric, threshold_value, reward_amount, reward_type, effective_date } = req.body;
    if (!name || !type || !reward_amount || !reward_type) {
      return res.status(400).json({ error: "name, type, reward_amount, reward_type required" });
    }
    const [row] = await db.insert(incentiveProgramsTable).values({
      company_id: req.auth!.companyId,
      name, type, trigger_metric: trigger_metric || null,
      threshold_value: threshold_value || null,
      reward_amount, reward_type,
      effective_date: effective_date || null,
    }).returning();
    return res.status(201).json(row);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

router.put("/programs/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const [row] = await db.update(incentiveProgramsTable)
      .set({ ...req.body })
      .where(and(eq(incentiveProgramsTable.id, parseInt(req.params.id)), eq(incentiveProgramsTable.company_id, req.auth!.companyId)))
      .returning();
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

router.delete("/programs/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    await db.update(incentiveProgramsTable)
      .set({ is_active: false })
      .where(and(eq(incentiveProgramsTable.id, parseInt(req.params.id)), eq(incentiveProgramsTable.company_id, req.auth!.companyId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/incentives/award — manually award
router.post("/award", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { employee_id, program_id, earned_date, amount, notes } = req.body;
    if (!employee_id || !program_id || !earned_date || !amount) {
      return res.status(400).json({ error: "employee_id, program_id, earned_date, amount required" });
    }
    const [row] = await db.insert(incentiveEarnedTable).values({
      company_id: req.auth!.companyId,
      employee_id, program_id, earned_date, amount, notes: notes || null,
    }).returning();
    return res.status(201).json(row);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/incentives/earned?employee_id=
router.get("/earned", requireAuth, async (req, res) => {
  try {
    const { employee_id } = req.query;
    const conditions: any[] = [eq(incentiveEarnedTable.company_id, req.auth!.companyId)];
    if (employee_id) conditions.push(eq(incentiveEarnedTable.employee_id, parseInt(employee_id as string)));

    const rows = await db
      .select({
        id: incentiveEarnedTable.id,
        employee_id: incentiveEarnedTable.employee_id,
        employee_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        program_id: incentiveEarnedTable.program_id,
        program_name: incentiveProgramsTable.name,
        earned_date: incentiveEarnedTable.earned_date,
        amount: incentiveEarnedTable.amount,
        notes: incentiveEarnedTable.notes,
        paid_date: incentiveEarnedTable.paid_date,
      })
      .from(incentiveEarnedTable)
      .leftJoin(usersTable, eq(usersTable.id, incentiveEarnedTable.employee_id))
      .leftJoin(incentiveProgramsTable, eq(incentiveProgramsTable.id, incentiveEarnedTable.program_id))
      .where(and(...conditions))
      .orderBy(desc(incentiveEarnedTable.earned_date));

    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/incentives/unpaid
router.get("/unpaid", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const rows = await db
      .select({
        id: incentiveEarnedTable.id,
        employee_id: incentiveEarnedTable.employee_id,
        employee_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        program_name: incentiveProgramsTable.name,
        earned_date: incentiveEarnedTable.earned_date,
        amount: incentiveEarnedTable.amount,
      })
      .from(incentiveEarnedTable)
      .leftJoin(usersTable, eq(usersTable.id, incentiveEarnedTable.employee_id))
      .leftJoin(incentiveProgramsTable, eq(incentiveProgramsTable.id, incentiveEarnedTable.program_id))
      .where(
        and(
          eq(incentiveEarnedTable.company_id, req.auth!.companyId),
          isNull(incentiveEarnedTable.paid_date),
        )
      );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
