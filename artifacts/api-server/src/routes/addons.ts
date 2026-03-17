import { Router } from "express";
import { db } from "@workspace/db";
import { addOnsTable, jobAddOnsTable } from "@workspace/db/schema";
import { eq, and, desc, count, sum, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const rows = await db.select().from(addOnsTable)
      .where(and(eq(addOnsTable.company_id, req.auth!.companyId), eq(addOnsTable.is_active, true)))
      .orderBy(addOnsTable.category, addOnsTable.name);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { name, price, category } = req.body;
    if (!name || price == null) return res.status(400).json({ error: "name and price required" });
    const [row] = await db.insert(addOnsTable).values({
      company_id: req.auth!.companyId,
      name, price, category: category || "other",
    }).returning();
    return res.status(201).json(row);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

router.put("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const [row] = await db.update(addOnsTable)
      .set({ ...req.body })
      .where(and(eq(addOnsTable.id, parseInt(req.params.id)), eq(addOnsTable.company_id, req.auth!.companyId)))
      .returning();
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    await db.update(addOnsTable).set({ is_active: false })
      .where(and(eq(addOnsTable.id, parseInt(req.params.id)), eq(addOnsTable.company_id, req.auth!.companyId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/addons/report
router.get("/report", requireAuth, async (req, res) => {
  try {
    const rows = await db
      .select({
        add_on_id: jobAddOnsTable.add_on_id,
        name: addOnsTable.name,
        category: addOnsTable.category,
        total_revenue: sum(jobAddOnsTable.subtotal),
        times_added: count(),
      })
      .from(jobAddOnsTable)
      .leftJoin(addOnsTable, eq(addOnsTable.id, jobAddOnsTable.add_on_id))
      .groupBy(jobAddOnsTable.add_on_id, addOnsTable.name, addOnsTable.category)
      .orderBy(desc(sum(jobAddOnsTable.subtotal)));
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
