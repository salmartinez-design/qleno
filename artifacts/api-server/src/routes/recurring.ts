import { Router } from "express";
import { db } from "@workspace/db";
import { recurringSchedulesTable, clientsTable, usersTable, jobsTable } from "@workspace/db/schema";
import { eq, and, isNull, lte, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { requireRole } from "../lib/auth.js";
import { generateRecurringJobs } from "../lib/recurring-jobs.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: recurringSchedulesTable.id,
        customer_id: recurringSchedulesTable.customer_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        frequency: recurringSchedulesTable.frequency,
        day_of_week: recurringSchedulesTable.day_of_week,
        start_date: recurringSchedulesTable.start_date,
        end_date: recurringSchedulesTable.end_date,
        assigned_employee_id: recurringSchedulesTable.assigned_employee_id,
        employee_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        service_type: recurringSchedulesTable.service_type,
        duration_minutes: recurringSchedulesTable.duration_minutes,
        base_fee: recurringSchedulesTable.base_fee,
        notes: recurringSchedulesTable.notes,
        is_active: recurringSchedulesTable.is_active,
        last_generated_date: recurringSchedulesTable.last_generated_date,
        created_at: recurringSchedulesTable.created_at,
      })
      .from(recurringSchedulesTable)
      .leftJoin(clientsTable, eq(clientsTable.id, recurringSchedulesTable.customer_id))
      .leftJoin(usersTable, eq(usersTable.id, recurringSchedulesTable.assigned_employee_id))
      .where(
        and(
          eq(recurringSchedulesTable.company_id, req.auth!.companyId),
          eq(recurringSchedulesTable.is_active, true),
        )
      );
    return res.json(rows);
  } catch (err) {
    console.error("[recurring GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const { customer_id, frequency, day_of_week, start_date, end_date, assigned_employee_id, service_type, duration_minutes, base_fee, notes } = req.body;
    if (!customer_id || !frequency || !start_date) {
      return res.status(400).json({ error: "customer_id, frequency, start_date required" });
    }
    const [row] = await db.insert(recurringSchedulesTable).values({
      company_id: req.auth!.companyId,
      customer_id,
      frequency,
      day_of_week: day_of_week || null,
      start_date,
      end_date: end_date || null,
      assigned_employee_id: assigned_employee_id || null,
      service_type: service_type || null,
      duration_minutes: duration_minutes || null,
      base_fee: base_fee || null,
      notes: notes || null,
    }).returning();
    return res.status(201).json(row);
  } catch (err) {
    console.error("[recurring POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.put("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { frequency, day_of_week, start_date, end_date, assigned_employee_id, service_type, duration_minutes, base_fee, notes } = req.body;
    const [row] = await db.update(recurringSchedulesTable)
      .set({ frequency, day_of_week, start_date, end_date, assigned_employee_id, service_type, duration_minutes, base_fee, notes })
      .where(and(eq(recurringSchedulesTable.id, id), eq(recurringSchedulesTable.company_id, req.auth!.companyId)))
      .returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json(row);
  } catch (err) {
    console.error("[recurring PUT]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.update(recurringSchedulesTable)
      .set({ is_active: false })
      .where(and(eq(recurringSchedulesTable.id, id), eq(recurringSchedulesTable.company_id, req.auth!.companyId)));
    return res.json({ success: true });
  } catch (err) {
    console.error("[recurring DELETE]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/recurring/trigger — admin-triggered job generation (60-day horizon)
router.post("/trigger", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const daysAhead = typeof req.body?.days_ahead === "number" ? req.body.days_ahead : 60;
    const result = await generateRecurringJobs(companyId, daysAhead);
    return res.json(result);
  } catch (err) {
    console.error("[recurring/trigger]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
