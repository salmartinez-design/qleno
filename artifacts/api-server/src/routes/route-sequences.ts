import { Router } from "express";
import { db } from "@workspace/db";
import { routeSequencesTable, jobsTable, clientsTable, usersTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

// Nearest-neighbor zip proximity sort (placeholder until Google Maps)
function sortByZipProximity(jobs: any[]): any[] {
  if (jobs.length <= 1) return jobs;
  const sorted: any[] = [];
  const remaining = [...jobs];
  sorted.push(remaining.splice(0, 1)[0]);
  while (remaining.length > 0) {
    const last = sorted[sorted.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const zipA = parseInt(last.zip || "0");
      const zipB = parseInt(remaining[i].zip || "0");
      const dist = Math.abs(zipA - zipB);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    sorted.push(remaining.splice(bestIdx, 1)[0]);
  }
  return sorted;
}

// POST /api/routes/optimize
router.post("/optimize", requireAuth, async (req, res) => {
  try {
    const { employee_id, date } = req.body;
    if (!employee_id || !date) return res.status(400).json({ error: "employee_id and date required" });
    const companyId = req.auth!.companyId;

    const jobs = await db
      .select({
        id: jobsTable.id,
        client_id: jobsTable.client_id,
        scheduled_time: jobsTable.scheduled_time,
        allowed_hours: jobsTable.allowed_hours,
        zip: clientsTable.zip,
        address: clientsTable.address,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
      })
      .from(jobsTable)
      .leftJoin(clientsTable, eq(clientsTable.id, jobsTable.client_id))
      .where(and(
        eq(jobsTable.company_id, companyId),
        eq(jobsTable.assigned_user_id, parseInt(employee_id)),
        eq(jobsTable.scheduled_date, date),
      ));

    const optimized = sortByZipProximity(jobs);
    const sequence = optimized.map((j, idx) => ({
      job_id: j.id,
      order: idx + 1,
      client_name: j.client_name,
      address: j.address,
      zip: j.zip,
      scheduled_time: j.scheduled_time,
      estimated_travel_min: idx === 0 ? 0 : 15,
    }));

    const totalJobMins = jobs.reduce((acc, j) => acc + parseFloat(j.allowed_hours ?? "1") * 60, 0);
    const totalDriveMins = Math.max(0, (jobs.length - 1)) * 15;

    const [row] = await db.insert(routeSequencesTable).values({
      company_id: companyId,
      employee_id: parseInt(employee_id),
      date,
      sequence,
      total_drive_time_min: totalDriveMins,
      total_job_time_min: Math.round(totalJobMins),
    }).returning();

    return res.json({ ...row, sequence });
  } catch (err) {
    console.error("[routes/optimize]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/routes/:id/reorder
router.put("/:id/reorder", requireAuth, async (req, res) => {
  try {
    const { sequence } = req.body;
    const [row] = await db.update(routeSequencesTable)
      .set({ sequence })
      .where(and(eq(routeSequencesTable.id, parseInt(req.params.id)), eq(routeSequencesTable.company_id, req.auth!.companyId)))
      .returning();
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/routes?date=&employee_id=
router.get("/", requireAuth, async (req, res) => {
  try {
    const { date, employee_id } = req.query;
    const conditions: any[] = [eq(routeSequencesTable.company_id, req.auth!.companyId)];
    if (date) conditions.push(eq(routeSequencesTable.date, date as string));
    if (employee_id) conditions.push(eq(routeSequencesTable.employee_id, parseInt(employee_id as string)));

    const rows = await db
      .select({
        id: routeSequencesTable.id,
        employee_id: routeSequencesTable.employee_id,
        employee_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        date: routeSequencesTable.date,
        sequence: routeSequencesTable.sequence,
        total_drive_time_min: routeSequencesTable.total_drive_time_min,
        total_job_time_min: routeSequencesTable.total_job_time_min,
        created_at: routeSequencesTable.created_at,
      })
      .from(routeSequencesTable)
      .leftJoin(usersTable, eq(usersTable.id, routeSequencesTable.employee_id))
      .where(and(...conditions))
      .orderBy(desc(routeSequencesTable.created_at));
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
