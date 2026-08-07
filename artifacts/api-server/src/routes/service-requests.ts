// [portal-request-service 2026-08-07] The OFFICE side of customer service
// requests. Mounted at /api/service-requests. Staff only.
//
// A request is an ask sitting in a queue, not work on the board. This route
// lets the office see what's waiting and close it out — either by pointing at
// the job they created, or by declining with a reason the customer can read.
//
// It deliberately does NOT create jobs. Booking work means pricing, a cleaner,
// a slot and a rate card, and that already lives in the job/quote flow. A
// second, thinner "create a job" here would be a second source of truth for
// what a job is — exactly the pattern that produced the five-way invoice
// combine mess (docs/BATCH_INVOICING_DESIGN.md §5 S-2).
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";

const router = Router();

// GET /api/service-requests?status=pending
// Newest first. Defaults to pending, because the queue is the point — the
// office wants "what needs answering", not a history.
router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const status = ["pending", "scheduled", "declined"].includes(String(req.query.status))
      ? String(req.query.status)
      : "pending";

    const rows = await db.execute(sql`
      SELECT r.id, r.service_description, r.preferred_date, r.notes, r.status,
             r.office_note, r.created_at, r.resulting_job_id,
             a.account_name,
             COALESCE(NULLIF(btrim(p.property_name), ''), p.address) AS building,
             pu.name AS requested_by_name, pu.email AS requested_by_email
        FROM portal_service_requests r
        LEFT JOIN accounts a ON a.id = r.account_id
        LEFT JOIN account_properties p ON p.id = r.account_property_id
        LEFT JOIN portal_users pu ON pu.id = r.requested_by_portal_user_id
       WHERE r.company_id = ${companyId} AND r.status = ${status}::portal_service_request_status
       ORDER BY r.created_at DESC
       LIMIT 200`);

    return res.json((rows.rows as any[]).map((r) => ({
      id: r.id,
      account_name: r.account_name,
      building: r.building ?? null,
      service: r.service_description,
      preferred_date: r.preferred_date ? String(r.preferred_date).slice(0, 10) : null,
      notes: r.notes,
      status: r.status,
      office_note: r.office_note,
      resulting_job_id: r.resulting_job_id,
      requested_by: r.requested_by_name || r.requested_by_email,
      created_at: r.created_at,
    })));
  } catch (err) {
    console.error("Service requests list error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to load service requests" });
  }
});

// GET /api/service-requests/count — pending badge for the office nav.
router.get("/count", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS pending FROM portal_service_requests
       WHERE company_id = ${req.auth!.companyId} AND status = 'pending'`);
    return res.json({ pending: (rows.rows[0] as any)?.pending ?? 0 });
  } catch {
    // A badge is not worth failing a page load over.
    return res.json({ pending: 0 });
  }
});

// PATCH /api/service-requests/:id  { status, job_id?, office_note? }
// Closes a request out. 'scheduled' records WHICH job answered it, so a request
// can be traced to the work it became; 'declined' carries a note the customer
// reads, because a request that just goes quiet is worse than a no.
router.patch("/:id", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const id = parseInt(String(req.params.id));
    const status = String(req.body?.status ?? "");
    if (!["pending", "scheduled", "declined"].includes(status)) {
      return res.status(400).json({ error: "Bad Request", message: "status must be pending, scheduled or declined" });
    }
    const officeNote = req.body?.office_note ? String(req.body.office_note).slice(0, 2000) : null;

    // A job pointed at here must belong to the same tenant — the id comes from
    // the request body, so it cannot be trusted on its own.
    let jobId: number | null = null;
    if (req.body?.job_id) {
      const j = parseInt(String(req.body.job_id));
      const own = await db.execute(sql`SELECT id FROM jobs WHERE id = ${j} AND company_id = ${companyId} LIMIT 1`);
      if (!own.rows[0]) return res.status(400).json({ error: "Bad Request", message: "That job was not found" });
      jobId = j;
    }

    const upd = await db.execute(sql`
      UPDATE portal_service_requests
         SET status = ${status}::portal_service_request_status,
             resulting_job_id = COALESCE(${jobId}, resulting_job_id),
             office_note = COALESCE(${officeNote}, office_note),
             reviewed_by_user_id = ${req.auth!.userId},
             reviewed_at = now()
       WHERE id = ${id} AND company_id = ${companyId}
       RETURNING id, status`);
    if (!upd.rows[0]) return res.status(404).json({ error: "Not Found", message: "Request not found" });

    logAudit(req, "SERVICE_REQUEST_REVIEW", "portal_service_request", id, null, {
      status, job_id: jobId, has_note: !!officeNote,
    });
    return res.json({ ok: true, id, status });
  } catch (err) {
    console.error("Service request update error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to update that request" });
  }
});

export default router;
