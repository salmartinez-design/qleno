import { Router } from "express";
import { db } from "@workspace/db";
import { mileageRequestsTable, additionalPayTable, companiesTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const companyId = user.company_id;
    const { user_id, status } = req.query;

    const conditions: any[] = [eq(mileageRequestsTable.company_id, companyId)];
    if (user_id) conditions.push(eq(mileageRequestsTable.user_id, parseInt(user_id as string)));
    else if (user.role === "technician") conditions.push(eq(mileageRequestsTable.user_id, user.id));
    if (status) conditions.push(eq(mileageRequestsTable.status, status as any));

    const requests = await db
      .select({
        id: mileageRequestsTable.id,
        user_id: mileageRequestsTable.user_id,
        service_date: mileageRequestsTable.service_date,
        from_client_name: mileageRequestsTable.from_client_name,
        to_client_name: mileageRequestsTable.to_client_name,
        miles: mileageRequestsTable.miles,
        rate_per_mile: mileageRequestsTable.rate_per_mile,
        reimbursement_amount: mileageRequestsTable.reimbursement_amount,
        notes: mileageRequestsTable.notes,
        status: mileageRequestsTable.status,
        denial_reason: mileageRequestsTable.denial_reason,
        created_at: mileageRequestsTable.created_at,
        reviewed_at: mileageRequestsTable.reviewed_at,
        employee_name: sql<string>`(select concat(first_name, ' ', last_name) from users where id = ${mileageRequestsTable.user_id})`,
      })
      .from(mileageRequestsTable)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(mileageRequestsTable.created_at);

    return res.json(requests);
  } catch (err) {
    console.error("List mileage requests error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const companyId = user.company_id;
    const {
      service_date, from_client_name, to_client_name,
      from_job_id, to_job_id, miles, notes,
    } = req.body;

    if (!service_date || !from_client_name || !to_client_name || !miles) {
      return res.status(400).json({ error: "service_date, from_client_name, to_client_name, miles required" });
    }

    const [company] = await db
      .select({ mileage_rate: companiesTable.mileage_rate })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId))
      .limit(1);
    const rate = parseFloat(company?.mileage_rate || "0.7000");
    const milesNum = parseFloat(miles);
    const reimbursement = (milesNum * rate).toFixed(2);

    const [request] = await db
      .insert(mileageRequestsTable)
      .values({
        company_id: companyId,
        user_id: user.id,
        service_date,
        from_client_name,
        to_client_name,
        from_job_id: from_job_id || null,
        to_job_id: to_job_id || null,
        miles: String(milesNum),
        rate_per_mile: String(rate),
        reimbursement_amount: reimbursement,
        notes: notes || null,
        status: "pending",
      })
      .returning();

    return res.status(201).json(request);
  } catch (err) {
    console.error("Create mileage request error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/approve", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const user = (req as any).user;
    const companyId = user.company_id;

    const [request] = await db
      .select()
      .from(mileageRequestsTable)
      .where(and(
        eq(mileageRequestsTable.id, parseInt(req.params.id)),
        eq(mileageRequestsTable.company_id, companyId),
      ))
      .limit(1);

    if (!request) return res.status(404).json({ error: "Not found" });
    if (request.status !== "pending") return res.status(409).json({ error: "Already reviewed" });

    const [pay] = await db
      .insert(additionalPayTable)
      .values({
        company_id: companyId,
        user_id: request.user_id,
        amount: request.reimbursement_amount,
        type: "mileage",
        notes: `Mileage reimbursement: ${request.from_client_name} → ${request.to_client_name} (${request.miles} mi @ $${request.rate_per_mile}/mi) on ${request.service_date}`,
      })
      .returning();

    const [updated] = await db
      .update(mileageRequestsTable)
      .set({
        status: "approved",
        reviewed_by: user.id,
        reviewed_at: new Date(),
        additional_pay_id: pay.id,
      })
      .where(eq(mileageRequestsTable.id, request.id))
      .returning();

    return res.json(updated);
  } catch (err) {
    console.error("Approve mileage request error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/deny", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const user = (req as any).user;
    const companyId = user.company_id;
    const { denial_reason } = req.body;

    const [updated] = await db
      .update(mileageRequestsTable)
      .set({
        status: "denied",
        denial_reason: denial_reason || null,
        reviewed_by: user.id,
        reviewed_at: new Date(),
      })
      .where(and(
        eq(mileageRequestsTable.id, parseInt(req.params.id)),
        eq(mileageRequestsTable.company_id, companyId),
      ))
      .returning();

    if (!updated) return res.status(404).json({ error: "Not found" });
    return res.json(updated);
  } catch (err) {
    console.error("Deny mileage request error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
