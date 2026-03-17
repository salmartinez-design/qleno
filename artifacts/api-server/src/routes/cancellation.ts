import { Router } from "express";
import { db } from "@workspace/db";
import { cancellationLogTable, jobsTable, clientsTable, usersTable } from "@workspace/db/schema";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

// GET /api/cancellations — list with filters
router.get("/", requireAuth, async (req, res) => {
  try {
    const { date_from, date_to, customer_id, employee_id } = req.query;
    const conditions: any[] = [eq(cancellationLogTable.company_id, req.auth!.companyId)];
    if (date_from) conditions.push(sql`${cancellationLogTable.cancelled_at} >= ${date_from as string}`);
    if (date_to) conditions.push(sql`${cancellationLogTable.cancelled_at} <= ${date_to as string}`);
    if (customer_id) conditions.push(eq(cancellationLogTable.customer_id, parseInt(customer_id as string)));

    const rows = await db
      .select({
        id: cancellationLogTable.id,
        job_id: cancellationLogTable.job_id,
        customer_id: cancellationLogTable.customer_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        cancelled_by: cancellationLogTable.cancelled_by,
        cancel_reason: cancellationLogTable.cancel_reason,
        cancelled_at: cancellationLogTable.cancelled_at,
        rescheduled_to_job_id: cancellationLogTable.rescheduled_to_job_id,
        notes: cancellationLogTable.notes,
        refund_issued: cancellationLogTable.refund_issued,
      })
      .from(cancellationLogTable)
      .leftJoin(clientsTable, eq(clientsTable.id, cancellationLogTable.customer_id))
      .where(and(...conditions))
      .orderBy(desc(cancellationLogTable.cancelled_at));

    return res.json(rows);
  } catch (err) {
    console.error("[cancellations GET]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
