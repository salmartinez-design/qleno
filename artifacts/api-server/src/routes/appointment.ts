import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

// [booking-confirmation GAP1] Public, no-login customer appointment view. The
// link the booking confirmation email/SMS carries. Resolves a job by its
// customer_view_token and returns a CUSTOMER-SAFE subset (no pricing, no
// internal notes, no tech contact info) plus the tenant's branding.
function labelService(raw: string | null): string {
  if (!raw) return "Cleaning service";
  return raw.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Friendly customer-facing status. The DB job_status enum is
// scheduled|in_progress|complete|cancelled; map to plain language.
function friendlyStatus(raw: string | null): string {
  switch (raw) {
    case "in_progress": return "in_progress";
    case "complete": return "complete";
    case "cancelled": return "cancelled";
    default: return "scheduled";
  }
}

router.get("/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(404).json({ error: "Not Found" });

    const rows = await db.execute(sql`
      SELECT j.id, j.scheduled_date, j.scheduled_time, j.arrival_window, j.service_type, j.status,
             j.address_street, j.address_city, j.address_state, j.address_zip,
             c.first_name AS client_first,
             u.first_name AS tech_first,
             co.name AS company_name, co.logo_url AS company_logo,
             co.brand_color AS company_brand_color, co.phone AS company_phone, co.email AS company_email
      FROM jobs j
      JOIN companies co ON co.id = j.company_id
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN users u ON u.id = j.assigned_user_id
      WHERE j.customer_view_token = ${token}
      LIMIT 1
    `);
    const j: any = rows.rows[0];
    if (!j) return res.status(404).json({ error: "Not Found" });

    const stateZip = [j.address_state, j.address_zip].filter(Boolean).join(" ");
    const serviceAddress = [j.address_street, j.address_city, stateZip].filter(Boolean).join(", ") || null;

    return res.json({
      client_first: j.client_first || null,
      status: friendlyStatus(j.status),
      scheduled_date: j.scheduled_date || null,
      scheduled_time: j.scheduled_time || null,
      arrival_window: j.arrival_window || null,
      service_type: labelService(j.service_type),
      service_address: serviceAddress,
      tech_first: j.tech_first || null,
      company_name: j.company_name,
      company_logo: j.company_logo,
      company_brand_color: j.company_brand_color,
      company_phone: j.company_phone,
      company_email: j.company_email,
    });
  } catch (err) {
    console.error("Public appointment error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
