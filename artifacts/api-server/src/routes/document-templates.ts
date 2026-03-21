import { Router } from "express";
import { db } from "@workspace/db";
import { documentTemplatesTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const companyId = (req as any).user.company_id;
    const templates = await db
      .select()
      .from(documentTemplatesTable)
      .where(eq(documentTemplatesTable.company_id, companyId))
      .orderBy(documentTemplatesTable.created_at);
    return res.json(templates);
  } catch (err) {
    console.error("List document templates error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = (req as any).user.company_id;
    const userId = (req as any).user.id;
    const { name, category, content, is_required, is_active, requires_signature } = req.body;
    if (!name || !category) return res.status(400).json({ error: "name and category required" });
    const [template] = await db
      .insert(documentTemplatesTable)
      .values({
        company_id: companyId,
        name,
        category,
        content: content || "",
        is_required: !!is_required,
        is_active: is_active !== false,
        requires_signature: !!requires_signature,
        created_by: userId,
      })
      .returning();
    return res.status(201).json(template);
  } catch (err) {
    console.error("Create document template error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const companyId = (req as any).user.company_id;
    const [template] = await db
      .select()
      .from(documentTemplatesTable)
      .where(and(
        eq(documentTemplatesTable.id, parseInt(req.params.id)),
        eq(documentTemplatesTable.company_id, companyId),
      ))
      .limit(1);
    if (!template) return res.status(404).json({ error: "Not found" });
    return res.json(template);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = (req as any).user.company_id;
    const { name, category, content, is_required, is_active, requires_signature } = req.body;
    const [template] = await db
      .update(documentTemplatesTable)
      .set({
        ...(name !== undefined && { name }),
        ...(category !== undefined && { category }),
        ...(content !== undefined && { content }),
        ...(is_required !== undefined && { is_required }),
        ...(is_active !== undefined && { is_active }),
        ...(requires_signature !== undefined && { requires_signature }),
        updated_at: new Date(),
      })
      .where(and(
        eq(documentTemplatesTable.id, parseInt(req.params.id)),
        eq(documentTemplatesTable.company_id, companyId),
      ))
      .returning();
    if (!template) return res.status(404).json({ error: "Not found" });
    return res.json(template);
  } catch (err) {
    console.error("Update document template error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = (req as any).user.company_id;
    await db
      .update(documentTemplatesTable)
      .set({ is_active: false, updated_at: new Date() })
      .where(and(
        eq(documentTemplatesTable.id, parseInt(req.params.id)),
        eq(documentTemplatesTable.company_id, companyId),
      ));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
