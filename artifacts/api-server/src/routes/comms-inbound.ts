import { Router } from "express";
import { handleInboundReply } from "../lib/lead-sync.js";
import { resolveTenantByNumber, recordInboundSms } from "../lib/sms-store.js";

const router = Router();

const OPT_OUT = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

// POST /api/comms/inbound — Twilio inbound-SMS webhook (PUBLIC, no auth).
// Twilio posts form-encoded { From, To, Body, MessageSid }. The `To` number maps
// to a tenant (company number first — unique — then branch). We:
//   1) persist the inbound message in the unified sms_messages store (matched to
//      a CLIENT or LEAD by the sender's last-10 digits),
//   2) stop the active follow-up cadence for the matching lead AND client
//      (stop-on-reply), flagging opt-out on STOP-words.
// Always responds 200 with empty TwiML.
router.post("/inbound", async (req, res) => {
  try {
    const from = String(req.body?.From ?? "");
    const to = String(req.body?.To ?? "");
    const body = String(req.body?.Body ?? "").trim();
    const sid = String(req.body?.MessageSid ?? req.body?.SmsSid ?? "") || null;
    if (!from || !to) return res.type("text/xml").send("<Response/>");

    const companyId = await resolveTenantByNumber(to);
    if (companyId == null) return res.type("text/xml").send("<Response/>");

    // 1) Persist + match (client or lead).
    const { match } = await recordInboundSms({ companyId, fromRaw: from, toRaw: to, body, providerId: sid });

    // 2) Stop-on-reply + opt-out. Leads via handleInboundReply (matches by phone,
    //    stops cadence, logs activity). Clients via stopEnrollmentsForClient.
    const optOut = OPT_OUT.has(body.toUpperCase());
    await handleInboundReply(companyId, from, optOut);
    if (match.client_id != null) {
      try {
        const { stopEnrollmentsForClient } = await import("../services/followUpService.js");
        await stopEnrollmentsForClient(match.client_id, optOut ? "opted_out" : "replied");
      } catch (e) { console.warn("[comms/inbound] client cadence stop failed:", e); }
    }
    return res.type("text/xml").send("<Response/>");
  } catch (err) {
    console.error("[comms/inbound]", err);
    return res.type("text/xml").send("<Response/>");
  }
});

export default router;
