import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

// GET /api/comms-status — per-tenant outbound-comms state for the caller's company.
// Drives the "Outbound communications are paused" banner: paused when the global
// master is off OR this tenant's comms_enabled is false. Any authenticated role
// (the banner shows for office/admin/owner alike). Multi-tenant — no hardcoding.
router.get("/", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const r = await db.execute(sql`SELECT comms_enabled FROM companies WHERE id = ${companyId} LIMIT 1`);
    const companyCommsEnabled = !!(r.rows[0] as any)?.comms_enabled;
    const globalEnabled = process.env.COMMS_ENABLED === "true";
    return res.json({
      paused: !globalEnabled || !companyCommsEnabled,
      global_enabled: globalEnabled,
      company_comms_enabled: companyCommsEnabled,
    });
  } catch (err) {
    console.error("GET /comms-status:", err);
    // Fail safe: if we can't tell, assume paused (better to over-warn than imply
    // sends are live when they may not be).
    return res.json({ paused: true, global_enabled: false, company_comms_enabled: false });
  }
});

export default router;
