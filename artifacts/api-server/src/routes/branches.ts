import { Router } from "express";
import { db } from "@workspace/db";
import { branchesTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const branches = await db
      .select()
      .from(branchesTable)
      .where(eq(branchesTable.company_id, req.auth!.companyId))
      .orderBy(branchesTable.name);
    res.json(branches);
  } catch (err) {
    console.error("GET /branches error:", err);
    res.status(500).json({ error: "Failed to fetch branches" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { name, address, city, state, zip, phone } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const [branch] = await db.insert(branchesTable).values({
      company_id: req.auth!.companyId,
      name,
      address,
      city,
      state,
      zip,
      phone,
      is_default: false,
      is_active: true,
    }).returning();

    res.status(201).json(branch);
  } catch (err) {
    console.error("POST /branches error:", err);
    res.status(500).json({ error: "Failed to create branch" });
  }
});

router.patch("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const branchId = parseInt(req.params.id);
    const { name, address, city, state, zip, phone, is_active } = req.body;

    const existing = await db
      .select({ id: branchesTable.id })
      .from(branchesTable)
      .where(and(eq(branchesTable.id, branchId), eq(branchesTable.company_id, req.auth!.companyId)))
      .limit(1);

    if (existing.length === 0) return res.status(404).json({ error: "Branch not found" });

    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (address !== undefined) updates.address = address;
    if (city !== undefined) updates.city = city;
    if (state !== undefined) updates.state = state;
    if (zip !== undefined) updates.zip = zip;
    if (phone !== undefined) updates.phone = phone;
    if (is_active !== undefined) updates.is_active = is_active;

    const [updated] = await db
      .update(branchesTable)
      .set(updates)
      .where(and(eq(branchesTable.id, branchId), eq(branchesTable.company_id, req.auth!.companyId)))
      .returning();

    res.json(updated);
  } catch (err) {
    console.error("PATCH /branches/:id error:", err);
    res.status(500).json({ error: "Failed to update branch" });
  }
});

export default router;
