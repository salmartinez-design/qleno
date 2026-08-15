// [office-reminders 2026-07-07] Internal reminders/events for the office —
// Maribel: "Do we have the options to set reminders form Qleno?" (e.g. "call
// Daveco Friday", "Lupe out until July 11"). These are NOT customer comms:
// nothing here sends SMS/email, so COMMS_ENABLED is irrelevant. Plain
// company-scoped CRUD over office_reminders (created by the idempotent boot
// migration), surfaced on the office dashboard.
//
// [client-lead-reminders 2026-08-15] A reminder can now be ATTACHED to a client
// or a lead and ASSIGNED to a staff member, so "follow up with client about
// scheduling recurring service" lives on that client's record instead of only
// in a flat dashboard list. Filter with ?client_id= / ?lead_id= to render the
// profile's own pending + completed list. Attachment is optional — an
// unattached reminder behaves exactly as it did before.
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

const OFFICE = ["owner", "admin", "office"] as const;

// Client/lead/assignee columns + the joined display names every response
// returns, so the dashboard list and the profile list render identically.
const SELECT_COLS = sql`
  orr.id, orr.title, orr.notes, orr.due_date::text AS due_date, orr.due_time::text AS due_time,
  orr.completed_at, orr.created_at, orr.client_id, orr.lead_id, orr.assigned_to,
  NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), '') AS created_by_name,
  NULLIF(TRIM(COALESCE(au.first_name,'') || ' ' || COALESCE(au.last_name,'')), '') AS assigned_to_name,
  COALESCE(
    NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''),
    c.company_name,
    NULLIF(TRIM(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')), '')
  ) AS subject_name`;

const JOINS = sql`
  LEFT JOIN users u   ON u.id = orr.created_by
  LEFT JOIN users au  ON au.id = orr.assigned_to
  LEFT JOIN clients c ON c.id = orr.client_id
  LEFT JOIN leads l   ON l.id = orr.lead_id`;

/**
 * Resolve an optional client/lead attachment, proving it belongs to this
 * tenant. Returns null when the id is present but not the caller's — never
 * trust a client_id off the wire. A reminder may attach to at most one.
 */
async function resolveSubject(
  companyId: number | null, clientId: unknown, leadId: unknown,
): Promise<{ client_id: number | null; lead_id: number | null } | null> {
  const cid = clientId == null || clientId === "" ? null : parseInt(String(clientId));
  const lid = leadId == null || leadId === "" ? null : parseInt(String(leadId));
  if (cid != null && isNaN(cid)) return null;
  if (lid != null && isNaN(lid)) return null;
  if (cid != null && lid != null) return null; // one subject, not both
  if (cid != null) {
    const r = await db.execute(sql`SELECT 1 FROM clients WHERE id = ${cid} AND company_id = ${companyId}`);
    if (!r.rows.length) return null;
  }
  if (lid != null) {
    const r = await db.execute(sql`SELECT 1 FROM leads WHERE id = ${lid} AND company_id = ${companyId}`);
    if (!r.rows.length) return null;
  }
  return { client_id: cid, lead_id: lid };
}

/** Same tenant proof for the assignee. */
async function resolveAssignee(companyId: number | null, assignedTo: unknown): Promise<number | null | false> {
  if (assignedTo == null || assignedTo === "") return null;
  const id = parseInt(String(assignedTo));
  if (isNaN(id)) return false;
  // Same tenant scope the /api/users roster uses (home company OR user_companies),
  // so anyone the assignee dropdown offers is actually assignable — a cross-tenant
  // tech appears in both offices' lists and a bare company_id check would 400 them.
  const r = await db.execute(sql`
    SELECT 1 FROM users u
     WHERE u.id = ${id}
       AND (u.company_id = ${companyId}
            OR EXISTS (SELECT 1 FROM user_companies uc
                        WHERE uc.user_id = u.id AND uc.company_id = ${companyId}))`);
  return r.rows.length ? id : false;
}

// GET /api/office-reminders?include_completed=1&limit=100&client_id=&lead_id=
// Open reminders ordered overdue → today → upcoming; completed excluded by
// default (pass include_completed=1 for the history view). Passing client_id or
// lead_id scopes the list to that profile — the profile card asks for both
// pending and completed in one call.
router.get("/", requireAuth, requireRole(...OFFICE), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const includeCompleted = String(req.query.include_completed ?? "") === "1";
    const limit = Math.min(parseInt(String(req.query.limit ?? "100")) || 100, 300);
    const clientId = req.query.client_id ? parseInt(String(req.query.client_id)) : null;
    const leadId = req.query.lead_id ? parseInt(String(req.query.lead_id)) : null;
    if ((clientId != null && isNaN(clientId)) || (leadId != null && isNaN(leadId))) {
      return res.status(400).json({ error: "Bad Request", message: "client_id/lead_id must be numeric" });
    }
    const r = await db.execute(sql`
      SELECT ${SELECT_COLS}
        FROM office_reminders orr
        ${JOINS}
       WHERE orr.company_id = ${companyId}
         ${includeCompleted ? sql`` : sql`AND orr.completed_at IS NULL`}
         ${clientId != null ? sql`AND orr.client_id = ${clientId}` : sql``}
         ${leadId != null ? sql`AND orr.lead_id = ${leadId}` : sql``}
       ORDER BY (orr.completed_at IS NOT NULL) ASC, orr.due_date ASC, orr.due_time ASC NULLS LAST, orr.id ASC
       LIMIT ${limit}`);
    return res.json({ reminders: r.rows });
  } catch (err) {
    console.error("[office-reminders] list:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/office-reminders
//   { title, due_date, due_time?, notes?, client_id?, lead_id?, assigned_to? }
router.post("/", requireAuth, requireRole(...OFFICE), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { title, notes, due_date, due_time, client_id, lead_id, assigned_to } = req.body ?? {};
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "Bad Request", message: "title is required" });
    }
    if (!due_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(due_date))) {
      return res.status(400).json({ error: "Bad Request", message: "due_date (YYYY-MM-DD) is required" });
    }
    const subject = await resolveSubject(companyId, client_id, lead_id);
    if (!subject) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid client_id/lead_id (attach to one, not both)" });
    }
    const assignee = await resolveAssignee(companyId, assigned_to);
    if (assignee === false) {
      return res.status(400).json({ error: "Bad Request", message: "Invalid assigned_to" });
    }
    const time = due_time && /^\d{2}:\d{2}/.test(String(due_time)) ? String(due_time) : null;
    const ins = await db.execute(sql`
      INSERT INTO office_reminders
        (company_id, title, notes, due_date, due_time, created_by, client_id, lead_id, assigned_to)
      VALUES (${companyId}, ${title.trim()}, ${notes ? String(notes) : null}, ${due_date}, ${time},
              ${req.auth!.userId}, ${subject.client_id}, ${subject.lead_id}, ${assignee})
      RETURNING id`);
    const id = (ins.rows[0] as any).id;
    const r = await db.execute(sql`
      SELECT ${SELECT_COLS} FROM office_reminders orr ${JOINS} WHERE orr.id = ${id}`);
    return res.status(201).json({ reminder: r.rows[0] });
  } catch (err) {
    console.error("[office-reminders] create:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// PATCH /api/office-reminders/:id
//   { title?, notes?, due_date?, due_time?, completed?, assigned_to? }
// Rescheduling is due_date/due_time; completing is completed:true. Both are the
// actions the profile card offers on a pending reminder.
router.patch("/:id", requireAuth, requireRole(...OFFICE), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const { title, notes, due_date, due_time, completed, assigned_to } = req.body ?? {};
    const sets: any[] = [];
    if (assigned_to !== undefined) {
      const assignee = await resolveAssignee(companyId, assigned_to);
      if (assignee === false) return res.status(400).json({ error: "Bad Request", message: "Invalid assigned_to" });
      sets.push(sql`assigned_to = ${assignee}`);
    }
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
    const upd = await db.execute(sql`
      UPDATE office_reminders SET ${sql.join(sets, sql`, `)}
       WHERE id = ${id} AND company_id = ${companyId}
      RETURNING id`);
    if (!upd.rows.length) return res.status(404).json({ error: "Not Found" });
    const r = await db.execute(sql`
      SELECT ${SELECT_COLS} FROM office_reminders orr ${JOINS} WHERE orr.id = ${id}`);
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
