import { Router } from "express";
import { db } from "@workspace/db";
import { recurringSchedulesTable, clientsTable, usersTable, jobsTable } from "@workspace/db/schema";
import { eq, and, isNull, lte, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { requireRole } from "../lib/auth.js";

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

// Generate next N job instances from active schedules
router.post("/generate", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];

    const schedules = await db
      .select()
      .from(recurringSchedulesTable)
      .where(
        and(
          eq(recurringSchedulesTable.company_id, companyId),
          eq(recurringSchedulesTable.is_active, true),
        )
      );

    const dayMap: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
    };
    const freqDays: Record<string, number> = { weekly: 7, biweekly: 14, monthly: 30, custom: 7 };

    let created = 0;
    const errors: string[] = [];

    for (const s of schedules) {
      try {
        // Determine next generation date
        const lastGenDate = s.last_generated_date
          ? new Date(s.last_generated_date + "T00:00")
          : new Date(s.start_date + "T00:00");

        let nextDate = new Date(lastGenDate);
        const intervalDays = freqDays[s.frequency] ?? 7;
        nextDate.setDate(nextDate.getDate() + intervalDays);

        // Snap to correct day_of_week if specified
        if (s.day_of_week && dayMap[s.day_of_week] !== undefined) {
          const targetDay = dayMap[s.day_of_week];
          const diff = (targetDay - nextDate.getDay() + 7) % 7;
          nextDate.setDate(nextDate.getDate() + diff);
        }

        const nextDateStr = nextDate.toISOString().split("T")[0];
        if (nextDateStr < todayStr) continue;
        if (s.end_date && nextDateStr > s.end_date) continue;

        // Check job doesn't already exist for this schedule + date
        const existing = await db.select({ id: jobsTable.id })
          .from(jobsTable)
          .where(
            and(
              eq(jobsTable.company_id, companyId),
              eq(jobsTable.client_id, s.customer_id),
              eq(jobsTable.scheduled_date, nextDateStr),
              sql`${jobsTable.notes} like ${`%recurring:${s.id}%`}`,
            )
          )
          .limit(1);

        if (existing.length > 0) continue;

        await db.insert(jobsTable).values({
          company_id: companyId,
          client_id: s.customer_id,
          assigned_user_id: s.assigned_employee_id || null,
          service_type: (s.service_type as any) || "recurring",
          scheduled_date: nextDateStr,
          scheduled_time: "09:00:00",
          frequency: "recurring" as any,
          base_fee: s.base_fee || null,
          allowed_hours: s.duration_minutes ? String(Number(s.duration_minutes) / 60) : null,
          notes: `${s.notes ? s.notes + " | " : ""}recurring:${s.id}`,
          status: "scheduled",
        });

        await db.update(recurringSchedulesTable)
          .set({ last_generated_date: nextDateStr })
          .where(eq(recurringSchedulesTable.id, s.id));

        created++;
      } catch (e: any) {
        errors.push(`Schedule ${s.id}: ${e.message}`);
      }
    }

    return res.json({ created, errors });
  } catch (err) {
    console.error("[recurring/generate]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
