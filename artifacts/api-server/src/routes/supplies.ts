import { Router } from "express";
import { db } from "@workspace/db";
import { supplyItemsTable, jobSuppliesTable } from "@workspace/db/schema";
import { eq, and, desc, sum, count, avg, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const rows = await db.select().from(supplyItemsTable)
      .where(and(eq(supplyItemsTable.company_id, req.auth!.companyId), eq(supplyItemsTable.is_active, true)))
      .orderBy(supplyItemsTable.category, supplyItemsTable.name);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { name, unit, unit_cost, category } = req.body;
    if (!name || unit_cost == null) return res.status(400).json({ error: "name and unit_cost required" });
    const [row] = await db.insert(supplyItemsTable).values({
      company_id: req.auth!.companyId,
      name, unit: unit || "each", unit_cost, category: category || "other",
    }).returning();
    return res.status(201).json(row);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

router.put("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const [row] = await db.update(supplyItemsTable).set({ ...req.body })
      .where(and(eq(supplyItemsTable.id, parseInt(req.params.id)), eq(supplyItemsTable.company_id, req.auth!.companyId)))
      .returning();
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    await db.update(supplyItemsTable).set({ is_active: false })
      .where(and(eq(supplyItemsTable.id, parseInt(req.params.id)), eq(supplyItemsTable.company_id, req.auth!.companyId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/supplies/job — log supplies used on a job
router.post("/job", requireAuth, async (req, res) => {
  try {
    const { job_id, items } = req.body; // items: [{ supply_item_id, quantity_used }]
    if (!job_id || !Array.isArray(items)) return res.status(400).json({ error: "job_id and items required" });

    const supplyIds = items.map((i: any) => i.supply_item_id);
    const supplyRows = await db.select().from(supplyItemsTable)
      .where(eq(supplyItemsTable.company_id, req.auth!.companyId));
    const supplyMap = Object.fromEntries(supplyRows.map(s => [s.id, s]));

    const values = items.map((item: any) => {
      const supply = supplyMap[item.supply_item_id];
      const total_cost = supply ? parseFloat(supply.unit_cost) * item.quantity_used : 0;
      return {
        job_id,
        supply_item_id: item.supply_item_id,
        quantity_used: String(item.quantity_used),
        total_cost: String(total_cost.toFixed(2)),
      };
    });

    await db.delete(jobSuppliesTable).where(eq(jobSuppliesTable.job_id, job_id));
    if (values.length > 0) await db.insert(jobSuppliesTable).values(values);

    return res.json({ success: true, logged: values.length });
  } catch (err) {
    console.error("[supplies/job]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/supplies/job/:job_id
router.get("/job/:job_id", requireAuth, async (req, res) => {
  try {
    const rows = await db
      .select({
        supply_item_id: jobSuppliesTable.supply_item_id,
        name: supplyItemsTable.name,
        unit: supplyItemsTable.unit,
        quantity_used: jobSuppliesTable.quantity_used,
        unit_cost: supplyItemsTable.unit_cost,
        total_cost: jobSuppliesTable.total_cost,
      })
      .from(jobSuppliesTable)
      .leftJoin(supplyItemsTable, eq(supplyItemsTable.id, jobSuppliesTable.supply_item_id))
      .where(eq(jobSuppliesTable.job_id, parseInt(req.params.job_id)));
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/supplies/report
router.get("/report", requireAuth, async (req, res) => {
  try {
    const rows = await db
      .select({
        supply_item_id: jobSuppliesTable.supply_item_id,
        name: supplyItemsTable.name,
        category: supplyItemsTable.category,
        total_cost: sum(jobSuppliesTable.total_cost),
        times_used: count(),
        avg_per_job: avg(jobSuppliesTable.total_cost),
      })
      .from(jobSuppliesTable)
      .leftJoin(supplyItemsTable, eq(supplyItemsTable.id, jobSuppliesTable.supply_item_id))
      .groupBy(jobSuppliesTable.supply_item_id, supplyItemsTable.name, supplyItemsTable.category)
      .orderBy(desc(sum(jobSuppliesTable.total_cost)));
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
