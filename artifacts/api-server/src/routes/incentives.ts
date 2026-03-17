import { Router } from "express";
import { db } from "@workspace/db";
import { incentiveProgramsTable, incentiveEarnedTable, usersTable } from "@workspace/db/schema";
import { eq, and, isNull, desc, sql, gte, lte } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

// ── GET /api/incentives/programs — with mtd_awarded + budget_remaining ──
router.get("/programs", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const programs = await db.select().from(incentiveProgramsTable)
      .where(and(eq(incentiveProgramsTable.company_id, companyId), eq(incentiveProgramsTable.is_active, true)))
      .orderBy(desc(incentiveProgramsTable.created_at));

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];

    const mtdRows = await db
      .select({
        program_id: incentiveEarnedTable.program_id,
        mtd_awarded: sql<number>`coalesce(sum(${incentiveEarnedTable.amount}),0)::float`,
      })
      .from(incentiveEarnedTable)
      .where(
        and(
          eq(incentiveEarnedTable.company_id, companyId),
          gte(incentiveEarnedTable.earned_date, monthStart),
          lte(incentiveEarnedTable.earned_date, monthEnd),
          sql`${incentiveEarnedTable.status} in ('approved','paid')`,
        )
      )
      .groupBy(incentiveEarnedTable.program_id);

    const mtdMap: Record<number, number> = {};
    for (const r of mtdRows) mtdMap[r.program_id] = r.mtd_awarded;

    const result = programs.map(p => {
      const mtd = mtdMap[p.id] ?? 0;
      const cap = p.monthly_budget_cap ? parseFloat(p.monthly_budget_cap) : null;
      return {
        ...p,
        mtd_awarded: mtd,
        budget_remaining: cap != null ? Math.max(0, cap - mtd) : null,
      };
    });

    return res.json(result);
  } catch (err) {
    console.error("[incentives/programs GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/incentives/programs ──
router.post("/programs", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { name, type, trigger_metric, threshold_value, reward_amount, reward_type, monthly_budget_cap, effective_date } = req.body;
    if (!name || !type || !reward_amount || !reward_type) {
      return res.status(400).json({ error: "name, type, reward_amount, reward_type required" });
    }
    const [row] = await db.insert(incentiveProgramsTable).values({
      company_id: req.auth!.companyId,
      name, type,
      trigger_metric: trigger_metric || null,
      threshold_value: threshold_value || null,
      reward_amount,
      reward_type,
      monthly_budget_cap: monthly_budget_cap || null,
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

// ── POST /api/incentives/award ──
router.post("/award", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { employee_id, program_id, earned_date, amount, notes } = req.body;
    if (!employee_id || !program_id || !earned_date || !amount) {
      return res.status(400).json({ error: "employee_id, program_id, earned_date, amount required" });
    }

    const companyId = req.auth!.companyId;
    const role = req.auth!.role;

    const programs = await db.select().from(incentiveProgramsTable)
      .where(and(eq(incentiveProgramsTable.id, parseInt(program_id)), eq(incentiveProgramsTable.company_id, companyId)))
      .limit(1);
    if (!programs[0]) return res.status(404).json({ error: "Program not found" });

    const program = programs[0];

    if (program.monthly_budget_cap) {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
      const [mtdRow] = await db
        .select({ total: sql<number>`coalesce(sum(${incentiveEarnedTable.amount}),0)::float` })
        .from(incentiveEarnedTable)
        .where(
          and(
            eq(incentiveEarnedTable.company_id, companyId),
            eq(incentiveEarnedTable.program_id, parseInt(program_id)),
            gte(incentiveEarnedTable.earned_date, monthStart),
            lte(incentiveEarnedTable.earned_date, monthEnd),
            sql`${incentiveEarnedTable.status} in ('approved','paid')`,
          )
        );
      const cap = parseFloat(program.monthly_budget_cap);
      if ((mtdRow?.total ?? 0) >= cap) {
        return res.status(400).json({ error: `Monthly budget cap of $${cap.toFixed(2)} has been reached for this program` });
      }
    }

    const status = role === "owner" ? "approved" : "pending_approval";
    const [row] = await db.insert(incentiveEarnedTable).values({
      company_id: companyId,
      employee_id: parseInt(employee_id),
      program_id: parseInt(program_id),
      earned_date,
      amount,
      notes: notes || null,
      status,
      awarded_by: req.auth!.userId,
      approved_by: role === "owner" ? req.auth!.userId : null,
      approved_at: role === "owner" ? new Date() : null,
    }).returning();

    return res.status(201).json({ ...row, message: role === "owner" ? "Incentive awarded." : "Submitted for owner approval." });
  } catch (err) {
    console.error("[incentives/award]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── GET /api/incentives/earned?employee_id= ──
router.get("/earned", requireAuth, async (req, res) => {
  try {
    const { employee_id, status } = req.query;
    const conditions: any[] = [eq(incentiveEarnedTable.company_id, req.auth!.companyId)];
    if (employee_id) conditions.push(eq(incentiveEarnedTable.employee_id, parseInt(employee_id as string)));
    if (status) conditions.push(sql`${incentiveEarnedTable.status} = ${status}`);

    const awarderAlias = usersTable;
    const rows = await db
      .select({
        id: incentiveEarnedTable.id,
        employee_id: incentiveEarnedTable.employee_id,
        employee_name: sql<string>`concat(u.first_name, ' ', u.last_name)`,
        program_id: incentiveEarnedTable.program_id,
        program_name: incentiveProgramsTable.name,
        earned_date: incentiveEarnedTable.earned_date,
        amount: incentiveEarnedTable.amount,
        notes: incentiveEarnedTable.notes,
        status: incentiveEarnedTable.status,
        awarded_by: incentiveEarnedTable.awarded_by,
        awarded_by_name: sql<string>`concat(a.first_name, ' ', a.last_name)`,
        approved_at: incentiveEarnedTable.approved_at,
        rejection_note: incentiveEarnedTable.rejection_note,
        paid_date: incentiveEarnedTable.paid_date,
      })
      .from(incentiveEarnedTable)
      .leftJoin(sql`${usersTable} u`, sql`u.id = ${incentiveEarnedTable.employee_id}`)
      .leftJoin(sql`${usersTable} a`, sql`a.id = ${incentiveEarnedTable.awarded_by}`)
      .leftJoin(incentiveProgramsTable, eq(incentiveProgramsTable.id, incentiveEarnedTable.program_id))
      .where(and(...conditions))
      .orderBy(desc(incentiveEarnedTable.earned_date));

    return res.json(rows);
  } catch (err) {
    console.error("[incentives/earned]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── GET /api/incentives/pending-approval (owner only) ──
router.get("/pending-approval", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const rows = await db
      .select({
        id: incentiveEarnedTable.id,
        employee_id: incentiveEarnedTable.employee_id,
        employee_name: sql<string>`concat(u.first_name, ' ', u.last_name)`,
        program_id: incentiveEarnedTable.program_id,
        program_name: incentiveProgramsTable.name,
        earned_date: incentiveEarnedTable.earned_date,
        amount: incentiveEarnedTable.amount,
        notes: incentiveEarnedTable.notes,
        awarded_by: incentiveEarnedTable.awarded_by,
        awarded_by_name: sql<string>`concat(a.first_name, ' ', a.last_name)`,
        created_at: incentiveEarnedTable.created_at,
      })
      .from(incentiveEarnedTable)
      .leftJoin(sql`${usersTable} u`, sql`u.id = ${incentiveEarnedTable.employee_id}`)
      .leftJoin(sql`${usersTable} a`, sql`a.id = ${incentiveEarnedTable.awarded_by}`)
      .leftJoin(incentiveProgramsTable, eq(incentiveProgramsTable.id, incentiveEarnedTable.program_id))
      .where(
        and(
          eq(incentiveEarnedTable.company_id, req.auth!.companyId),
          sql`${incentiveEarnedTable.status} = 'pending_approval'`,
        )
      )
      .orderBy(desc(incentiveEarnedTable.created_at));

    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/incentives/:id/approve (owner only) ──
router.post("/:id/approve", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const [row] = await db.update(incentiveEarnedTable)
      .set({ status: "approved", approved_by: req.auth!.userId, approved_at: new Date() })
      .where(and(eq(incentiveEarnedTable.id, parseInt(req.params.id)), eq(incentiveEarnedTable.company_id, req.auth!.companyId)))
      .returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/incentives/:id/reject (owner only) ──
router.post("/:id/reject", requireAuth, requireRole("owner"), async (req, res) => {
  try {
    const { rejection_note } = req.body;
    if (!rejection_note) return res.status(400).json({ error: "rejection_note required" });
    const [row] = await db.update(incentiveEarnedTable)
      .set({ status: "rejected", rejection_note })
      .where(and(eq(incentiveEarnedTable.id, parseInt(req.params.id)), eq(incentiveEarnedTable.company_id, req.auth!.companyId)))
      .returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// ── GET /api/incentives/unpaid ──
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
        status: incentiveEarnedTable.status,
      })
      .from(incentiveEarnedTable)
      .leftJoin(usersTable, eq(usersTable.id, incentiveEarnedTable.employee_id))
      .leftJoin(incentiveProgramsTable, eq(incentiveProgramsTable.id, incentiveEarnedTable.program_id))
      .where(
        and(
          eq(incentiveEarnedTable.company_id, req.auth!.companyId),
          isNull(incentiveEarnedTable.paid_date),
          sql`${incentiveEarnedTable.status} = 'approved'`,
        )
      );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
