// [office-reminders 2026-07-07] Internal reminders/events for the office —
// Maribel: "Do we have the options to set reminders form Qleno?" (e.g. "call
// Daveco Friday", "Lupe out until July 11"). These are NOT customer comms:
// nothing here sends SMS/email, so COMMS_ENABLED is irrelevant. Plain
// company-scoped CRUD over office_reminders (created by the idempotent boot
// migration), surfaced on the office dashboard.
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

const OFFICE = ["owner", "admin", "office"] as const;

// GET /api/office-reminders?include_completed=1&limit=100
// Open reminders ordered overdue → today → upcoming; completed excluded by
// default (pass include_completed=1 for the history view).
router.get("/", requireAuth, requireRole(...OFFICE), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const includeCompleted = String(req.query.include_completed ?? "") === "1";
    const limit = Math.min(parseInt(String(req.query.limit ?? "100")) || 100, 300);
    const r = await db.execute(sql`
      SELECT orr.id, orr.title, orr.notes, orr.due_date::text AS due_date, orr.due_time::text AS due_time,
             orr.completed_at, orr.created_at,
             NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS created_by_name
        FROM office_reminders orr
        LEFT JOIN users u ON u.id = orr.created_by
       WHERE orr.company_id = ${companyId}
         ${includeCompleted ? sql`` : sql`AND orr.completed_at IS NULL`}
       ORDER BY (orr.completed_at IS NOT NULL) ASC, orr.due_date ASC, orr.due_time ASC NULLS LAST, orr.id ASC
       LIMIT ${limit}`);
    return res.json({ reminders: r.rows });
  } catch (err) {
    console.error("[office-reminders] list:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/office-reminders { title, due_date, due_time?, notes? }
router.post("/", requireAuth, requireRole(...OFFICE), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { title, notes, due_date, due_time } = req.body ?? {};
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "Bad Request", message: "title is required" });
    }
    if (!due_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(due_date))) {
      return res.status(400).json({ error: "Bad Request", message: "due_date (YYYY-MM-DD) is required" });
    }
    const time = due_time && /^\d{2}:\d{2}/.test(String(due_time)) ? String(due_time) : null;
    const r = await db.execute(sql`
      INSERT INTO office_reminders (company_id, title, notes, due_date, due_time, created_by)
      VALUES (${companyId}, ${title.trim()}, ${notes ? String(notes) : null}, ${due_date}, ${time}, ${req.auth!.userId})
      RETURNING id, title, notes, due_date::text AS due_date, due_time::text AS due_time, completed_at, created_at`);
    return res.status(201).json({ reminder: r.rows[0] });
  } catch (err) {
    console.error("[office-reminders] create:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// PATCH /api/office-reminders/:id { title?, notes?, due_date?, due_time?, completed? }
router.patch("/:id", requireAuth, requireRole(...OFFICE), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const { title, notes, due_date, due_time, completed } = req.body ?? {};
    const sets: any[] = [];
    if (title !== undefined) sets.push(sql`title = ${String(title).trim()}`);
    if (notes !== undefined) sets.push(sql`notes = ${notes ? String(notes) : null}`);
    if (due_date !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due_date))) return res.status(400).json({ error: "Bad Request", message: "due_date must be YYYY-MM-DD" });
      sets.push(sql`due_date = ${due_date}`);
    }
    if (due_time !== undefined) sets.push(sql`due_time = ${due_time && /^\d{2}:\d{2}/.test(String(due_time)) ? String(due_time) : null}`);
    if (completed !== undefined) {
      sets.push(completed
        ? sql`completed_at = NOW(), completed_by = ${req.auth!.userId}`
        : sql`completed_at = NULL, completed_by = NULL`);
    }
    if (!sets.length) return res.status(400).json({ error: "Bad Request", message: "Nothing to update" });
    const r = await db.execute(sql`
      UPDATE office_reminders SET ${sql.join(sets, sql`, `)}
       WHERE id = ${id} AND company_id = ${companyId}
      RETURNING id, title, notes, due_date::text AS due_date, due_time::text AS due_time, completed_at, created_at`);
    if (!r.rows.length) return res.status(404).json({ error: "Not Found" });
    return res.json({ reminder: r.rows[0] });
  } catch (err) {
    console.error("[office-reminders] update:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE /api/office-reminders/:id
router.delete("/:id", requireAuth, requireRole(...OFFICE), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const r = await db.execute(sql`
      DELETE FROM office_reminders WHERE id = ${id} AND company_id = ${req.auth!.companyId} RETURNING id`);
    if (!r.rows.length) return res.status(404).json({ error: "Not Found" });
    return res.json({ success: true });
  } catch (err) {
    console.error("[office-reminders] delete:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
