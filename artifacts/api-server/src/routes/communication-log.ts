import { Router } from "express";
import { db } from "@workspace/db";
import { communicationLogTable, clientsTable, usersTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

// GET /api/comms?customer_id= OR company-wide
router.get("/", requireAuth, async (req, res) => {
  try {
    const { customer_id, limit = "50" } = req.query;
    const conditions: any[] = [eq(communicationLogTable.company_id, req.auth!.companyId)];
    if (customer_id) conditions.push(eq(communicationLogTable.customer_id, parseInt(customer_id as string)));

    const rows = await db
      .select({
        id: communicationLogTable.id,
        customer_id: communicationLogTable.customer_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        job_id: communicationLogTable.job_id,
        direction: communicationLogTable.direction,
        channel: communicationLogTable.channel,
        summary: communicationLogTable.summary,
        logged_by: communicationLogTable.logged_by,
        logged_by_name: sql<string>`concat(${usersTable.first_name}, ' ', ${usersTable.last_name})`,
        logged_at: communicationLogTable.logged_at,
        tags: communicationLogTable.tags,
      })
      .from(communicationLogTable)
      .leftJoin(clientsTable, eq(clientsTable.id, communicationLogTable.customer_id))
      .leftJoin(usersTable, eq(usersTable.id, communicationLogTable.logged_by))
      .where(and(...conditions))
      .orderBy(desc(communicationLogTable.logged_at))
      .limit(parseInt(limit as string));

    return res.json(rows);
  } catch (err) {
    console.error("[comms GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/comms — log a communication
router.post("/", requireAuth, async (req, res) => {
  try {
    const { customer_id, job_id, direction, channel, summary, tags } = req.body;
    if (!customer_id || !direction || !channel || !summary) {
      return res.status(400).json({ error: "customer_id, direction, channel, summary required" });
    }
    const [row] = await db.insert(communicationLogTable).values({
      company_id: req.auth!.companyId,
      customer_id,
      job_id: job_id || null,
      direction,
      channel,
      summary,
      logged_by: req.auth!.userId,
      tags: tags || null,
    }).returning();
    return res.status(201).json(row);
  } catch (err) {
    console.error("[comms POST]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
