import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { handleInboundReply } from "../lib/lead-sync.js";

const router = Router();

const OPT_OUT = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

// POST /api/comms/inbound — Twilio inbound-SMS webhook (PUBLIC, no auth).
// Twilio posts form-encoded { From, To, Body }. The `To` number maps to a
// branch (or company) → tenant; the customer reply stops their active cadence
// (stop-on-reply) and STOP-words flag an opt-out. Responds 200 (empty TwiML).
router.post("/inbound", async (req, res) => {
  try {
    const from = String(req.body?.From ?? "");
    const to = String(req.body?.To ?? "");
    const body = String(req.body?.Body ?? "").trim();
    if (!from || !to) return res.type("text/xml").send("<Response/>");

    // Resolve tenant from the receiving number (branch first, then company).
    let companyId: number | null = null;
    const br = await db.execute(sql`SELECT company_id FROM branches WHERE twilio_from_number = ${to} LIMIT 1`);
    companyId = (br.rows[0] as any)?.company_id ?? null;
    if (companyId == null) {
      const co = await db.execute(sql`SELECT id AS company_id FROM companies WHERE twilio_from_number = ${to} LIMIT 1`);
      companyId = (co.rows[0] as any)?.company_id ?? null;
    }
    if (companyId == null) return res.type("text/xml").send("<Response/>");

    const optOut = OPT_OUT.has(body.toUpperCase());
    await handleInboundReply(companyId, from, optOut);
    return res.type("text/xml").send("<Response/>");
  } catch (err) {
    console.error("[comms/inbound]", err);
    return res.type("text/xml").send("<Response/>");
  }
});

export default router;
