import { Router } from "express";
import { db } from "@workspace/db";
import { branchesTable, companiesTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

// Map branch_id → linked company_id for multi-company branches (e.g. Schaumburg satellite)
const BRANCH_COMPANY_MAP: Record<number, number> = {
  1: 1, // Oak Lawn → PHES (company_id=1)
  2: 4, // Schaumburg → PHES Schaumburg (company_id=4)
};

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    // Active branches only — deactivated branches (e.g. the legacy co1
    // "Schaumburg" satellite, now its own tenant co4) must not appear in the
    // switcher or any branch picker.
    const branches = await db
      .select()
      .from(branchesTable)
      .where(and(eq(branchesTable.company_id, req.auth!.companyId), eq(branchesTable.is_active, true)))
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
    const { name, address, city, state, zip, phone, is_active, comms_enabled, twilio_from_number } = req.body;

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
    if (comms_enabled !== undefined) updates.comms_enabled = comms_enabled;
    if (twilio_from_number !== undefined) updates.twilio_from_number = twilio_from_number;

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

// ── GET /branches/:id/company — returns company record for a branch ────────────
router.get("/:id/company", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const branchId = parseInt(req.params.id);
    const companyId = BRANCH_COMPANY_MAP[branchId];
    if (!companyId) return res.status(404).json({ error: "No linked company for this branch" });

    const rows = await db.execute(sql`SELECT * FROM companies WHERE id = ${companyId} LIMIT 1`);
    const company = ((rows as any).rows ?? [])[0];
    if (!company) return res.status(404).json({ error: "Company not found" });
    return res.json(company);
  } catch (err) {
    console.error("GET /branches/:id/company error:", err);
    return res.status(500).json({ error: "Failed to fetch branch company" });
  }
});

// ── PATCH /branches/:id/company — update contact info for a branch's company ──
router.patch("/:id/company", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const branchId = parseInt(req.params.id);
    const companyId = BRANCH_COMPANY_MAP[branchId];
    if (!companyId) return res.status(404).json({ error: "No linked company for this branch" });

    const { name, phone, email } = req.body;
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No fields to update" });

    await db.execute(sql`
      UPDATE companies SET
        name = COALESCE(${updates.name ?? null}, name),
        phone = COALESCE(${updates.phone ?? null}, phone),
        email = COALESCE(${updates.email ?? null}, email)
      WHERE id = ${companyId}
    `);

    const rows = await db.execute(sql`SELECT * FROM companies WHERE id = ${companyId} LIMIT 1`);
    return res.json(((rows as any).rows ?? [])[0]);
  } catch (err) {
    console.error("PATCH /branches/:id/company error:", err);
    return res.status(500).json({ error: "Failed to update branch company" });
  }
});

export default router;
