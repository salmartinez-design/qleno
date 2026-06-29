import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

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

// PATCH /api/comms-status — owner/admin master switch for THIS tenant's outbound
// comms (companies.comms_enabled). This column defaults OFF and had no UI or API
// to flip it, so a tenant could have the global COMMS_ENABLED=true, valid Twilio
// + Resend creds, AND still send nothing — every event send suppresses with
// reason 'company_comms_disabled' and the reminder cron's `co.comms_enabled =
// true` filter drops the whole tenant (no log row at all). This endpoint is the
// missing setter. Owner/admin only — enabling comms is a deliberate go-live act.
router.patch("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const enabled = req.body?.comms_enabled;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "comms_enabled (boolean) required" });
    }
    await db.execute(sql`UPDATE companies SET comms_enabled = ${enabled} WHERE id = ${companyId}`);
    const globalEnabled = process.env.COMMS_ENABLED === "true";
    console.log(`[comms-status] company=${companyId} comms_enabled set to ${enabled} by user=${req.auth!.userId ?? "?"}`);
    return res.json({
      paused: !globalEnabled || !enabled,
      global_enabled: globalEnabled,
      company_comms_enabled: enabled,
    });
  } catch (err) {
    console.error("PATCH /comms-status:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
