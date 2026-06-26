import { Router } from "express";
import { db } from "@workspace/db";
import { employeeDisciplineLogTable, usersTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const issuedBy = req.auth!.userId!;
    const { employee_id, discipline_type, custom_label, reason, effective_date } = req.body;
    if (!employee_id || !discipline_type || !effective_date) {
      return res.status(400).json({ error: "employee_id, discipline_type, effective_date required" });
    }
    const [entry] = await db.insert(employeeDisciplineLogTable).values({
      company_id: companyId,
      employee_id,
      discipline_type,
      custom_label,
      reason,
      effective_date,
      issued_by: issuedBy,
      pending_review: false,
    }).returning();
    return res.json(entry);
  } catch (err) {
    console.error("discipline POST error:", err);
    return res.status(500).json({ error: "Failed to create discipline record" });
  }
});

router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { employee_id } = req.query;
    if (!employee_id) return res.status(400).json({ error: "employee_id required" });

    const records = await db
      .select({
        id: employeeDisciplineLogTable.id,
        discipline_type: employeeDisciplineLogTable.discipline_type,
        custom_label: employeeDisciplineLogTable.custom_label,
        reason: employeeDisciplineLogTable.reason,
        effective_date: employeeDisciplineLogTable.effective_date,
        issued_by: employeeDisciplineLogTable.issued_by,
        pending_review: employeeDisciplineLogTable.pending_review,
        dismissed: employeeDisciplineLogTable.dismissed,
        acknowledged: employeeDisciplineLogTable.acknowledged,
        acknowledged_at: employeeDisciplineLogTable.acknowledged_at,
        created_at: employeeDisciplineLogTable.created_at,
        issuer_first_name: sql<string>`(select first_name from users where id = ${employeeDisciplineLogTable.issued_by})`,
        issuer_last_name: sql<string>`(select last_name from users where id = ${employeeDisciplineLogTable.issued_by})`,
      })
      .from(employeeDisciplineLogTable)
      .where(and(
        eq(employeeDisciplineLogTable.company_id, companyId),
        eq(employeeDisciplineLogTable.employee_id, parseInt(employee_id as string)),
      ))
      .orderBy(desc(employeeDisciplineLogTable.effective_date));
    return res.json(records);
  } catch (err) {
    console.error("discipline GET error:", err);
    return res.status(500).json({ error: "Failed to fetch discipline records" });
  }
});

router.put("/:id/acknowledge", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    const result = await db
      .update(employeeDisciplineLogTable)
      .set({ acknowledged: true, acknowledged_at: new Date() })
      .where(and(eq(employeeDisciplineLogTable.id, id), eq(employeeDisciplineLogTable.company_id, companyId)))
      .returning();
    if (!result.length) return res.status(404).json({ error: "Record not found" });
    return res.json(result[0]);
  } catch (err) {
    console.error("discipline acknowledge error:", err);
    return res.status(500).json({ error: "Failed to acknowledge" });
  }
});

// [office-admin-parity 2026-06-26] Office tier confirms/dismisses discipline records (Sal: full HR access).
router.put("/:id/confirm", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    const result = await db
      .update(employeeDisciplineLogTable)
      .set({ pending_review: false })
      .where(and(eq(employeeDisciplineLogTable.id, id), eq(employeeDisciplineLogTable.company_id, companyId)))
      .returning();
    if (!result.length) return res.status(404).json({ error: "Record not found" });
    return res.json(result[0]);
  } catch (err) {
    console.error("discipline confirm error:", err);
    return res.status(500).json({ error: "Failed to confirm record" });
  }
});

router.put("/:id/dismiss", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    const result = await db
      .update(employeeDisciplineLogTable)
      .set({ dismissed: true, pending_review: false })
      .where(and(eq(employeeDisciplineLogTable.id, id), eq(employeeDisciplineLogTable.company_id, companyId)))
      .returning();
    if (!result.length) return res.status(404).json({ error: "Record not found" });
    return res.json(result[0]);
  } catch (err) {
    console.error("discipline dismiss error:", err);
    return res.status(500).json({ error: "Failed to dismiss record" });
  }
});

export default router;
