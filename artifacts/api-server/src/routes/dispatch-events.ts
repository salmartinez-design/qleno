// [dispatch-events 2026-07-14] Non-job entries the office drops onto the
// dispatch board via + New → Event. See lib/db/src/schema/dispatch_events.ts
// for the data model. Three kinds, chosen at creation time:
//   tech_block   — a block on ONE tech's row (assigned_user_id required)
//   company_day  — a company-wide day marker (no tech; may be all-day)
//   client_visit — a non-job appointment on a tech's row, tied to a client
//                  (assigned_user_id + client_id required)
// Deliberately NOT a job: no service_type, pricing, commission, invoicing, or
// comms. Office-tier only — same gate as the rest of the dispatch surface, and
// techs have no business reading the whole company's board.

import { Router } from "express";
import { db } from "@workspace/db";
import { dispatchEventsTable, usersTable, clientsTable } from "@workspace/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

const officeGate = requireRole("owner", "admin", "office", "super_admin");

// one_on_one is the board-visible block for an owner 1-on-1 (see
// routes/one-on-ones.ts). It behaves like a tech_block here (sits on a tech's
// row, no client); the private record lives in the one_on_ones table. Office
// staff can create/see the block but never the linked record's content.
const KINDS = new Set(["tech_block", "company_day", "client_visit", "one_on_one"]);

// Normalize a "HH:MM" or "HH:MM:SS" string to "HH:MM:SS" for the time column.
// Returns null for empty/invalid input so all-day / missing times stay null.
function normTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = String(Math.min(23, parseInt(m[1], 10))).padStart(2, "0");
  const mm = String(Math.min(59, parseInt(m[2], 10))).padStart(2, "0");
  const ss = m[3] ? String(Math.min(59, parseInt(m[3], 10))).padStart(2, "0") : "00";
  return `${hh}:${mm}:${ss}`;
}

// GET /api/dispatch-events?date=YYYY-MM-DD&branch_id=123
// Returns the events for one day, company-scoped. Joins the tech + client
// display names so the board can render a chip without a second lookup.
// Branch filter mirrors the board: a branch view shows that branch's events
// PLUS unbranded (branch_id IS NULL) ones; company-day events with no branch
// always show.
router.get("/", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const date = typeof req.query.date === "string" ? req.query.date : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date=YYYY-MM-DD is required" });
    }
    const branchId = req.query.branch_id ? parseInt(String(req.query.branch_id), 10) : null;

    const rows = await db
      .select({
        id: dispatchEventsTable.id,
        kind: dispatchEventsTable.kind,
        title: dispatchEventsTable.title,
        branch_id: dispatchEventsTable.branch_id,
        assigned_user_id: dispatchEventsTable.assigned_user_id,
        assigned_user_name: sql<string | null>`NULLIF(btrim(concat(${usersTable.first_name}, ' ', ${usersTable.last_name})), '')`,
        client_id: dispatchEventsTable.client_id,
        client_name: sql<string | null>`NULLIF(btrim(concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})), '')`,
        event_date: dispatchEventsTable.event_date,
        start_time: dispatchEventsTable.start_time,
        end_time: dispatchEventsTable.end_time,
        all_day: dispatchEventsTable.all_day,
        notes: dispatchEventsTable.notes,
        color: dispatchEventsTable.color,
      })
      .from(dispatchEventsTable)
      .leftJoin(usersTable, eq(usersTable.id, dispatchEventsTable.assigned_user_id))
      .leftJoin(clientsTable, eq(clientsTable.id, dispatchEventsTable.client_id))
      .where(and(
        eq(dispatchEventsTable.company_id, companyId),
        eq(dispatchEventsTable.event_date, date),
        Number.isFinite(branchId as number)
          ? sql`(${dispatchEventsTable.branch_id} IS NULL OR ${dispatchEventsTable.branch_id} = ${branchId})`
          : sql`true`,
      ))
      .orderBy(desc(dispatchEventsTable.all_day), dispatchEventsTable.start_time, dispatchEventsTable.id);

    return res.json(rows);
  } catch (err) {
    console.error("GET /dispatch-events error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST /api/dispatch-events — create one event.
// Body: { kind, title, event_date, assigned_user_id?, client_id?, branch_id?,
//         start_time?, end_time?, all_day?, notes?, color? }
router.post("/", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const b = req.body ?? {};

    const kind = typeof b.kind === "string" && KINDS.has(b.kind) ? b.kind : null;
    if (!kind) return res.status(400).json({ error: "kind must be tech_block, company_day, or client_visit" });

    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!title) return res.status(400).json({ error: "title is required" });

    const eventDate = typeof b.event_date === "string" ? b.event_date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return res.status(400).json({ error: "event_date=YYYY-MM-DD is required" });

    const assignedUserId = Number.isFinite(b.assigned_user_id) ? b.assigned_user_id : null;
    const clientId = Number.isFinite(b.client_id) ? b.client_id : null;

    // Kind-specific requirements — a tech block / client visit has to land on a
    // tech's row; a company-day marker must NOT carry a tech (it's board-wide).
    if ((kind === "tech_block" || kind === "client_visit" || kind === "one_on_one") && !assignedUserId) {
      return res.status(400).json({ error: "assigned_user_id is required for a tech block, client visit, or 1-on-1" });
    }
    if (kind === "client_visit" && !clientId) {
      return res.status(400).json({ error: "client_id is required for a client visit" });
    }
    const finalAssigned = kind === "company_day" ? null : assignedUserId;
    const finalClient = kind === "client_visit" ? clientId : null;

    const allDay = b.all_day === true;
    const startTime = allDay ? null : normTime(b.start_time);
    const endTime = allDay ? null : normTime(b.end_time);

    const [row] = await db
      .insert(dispatchEventsTable)
      .values({
        company_id: companyId,
        branch_id: Number.isFinite(b.branch_id) ? b.branch_id : null,
        kind,
        title,
        assigned_user_id: finalAssigned,
        client_id: finalClient,
        event_date: eventDate,
        start_time: startTime,
        end_time: endTime,
        all_day: allDay,
        notes: typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null,
        color: typeof b.color === "string" && b.color.trim() ? b.color.trim() : null,
        created_by_user_id: req.auth!.userId ?? null,
      })
      .returning();

    return res.status(201).json(row);
  } catch (err) {
    console.error("POST /dispatch-events error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// DELETE /api/dispatch-events/:id — remove one event (company-scoped).
router.delete("/:id", requireAuth, officeGate, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const deleted = await db
      .delete(dispatchEventsTable)
      .where(and(eq(dispatchEventsTable.id, id), eq(dispatchEventsTable.company_id, companyId)))
      .returning({ id: dispatchEventsTable.id });
    if (deleted.length === 0) return res.status(404).json({ error: "not found" });
    return res.json({ ok: true, id });
  } catch (err) {
    console.error("DELETE /dispatch-events error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
