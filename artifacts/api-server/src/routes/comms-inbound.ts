import { Router } from "express";
import { handleInboundReply } from "../lib/lead-sync.js";
import { resolveTenantByNumber, recordInboundSms } from "../lib/sms-store.js";
import { isStopKeyword, isStartKeyword, setSmsOptOutByPhone, setEmailOptOutByToken, clearEmailOptOutByToken } from "../lib/opt-out.js";

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

    // Alert office staff (in-app). Internal staff notification — never customer-facing.
    try {
      const { notifyOfficeUsers } = await import("../lib/notify.js");
      const d = from.replace(/\D/g, "").slice(-10);
      const who = match.name || (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : from);
      await notifyOfficeUsers(companyId, {
        type: "new_message",
        title: `New text from ${who}`,
        body: body.slice(0, 160),
        link: "/messages",
        meta: { phone: d, client_id: match.client_id, lead_id: match.lead_id },
      });
    } catch (e) { console.warn("[comms/inbound] notify failed:", e); }

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

    // [comms-opt-out 2026-06-21] Record the SMS opt-out flag on the client(s)
    // (matched by phone, last-10) so EVERY send path honors it — not just the
    // follow-up cadence. STOP/UNSUBSCRIBE/CANCEL/QUIT sets it; START/UNSTOP
    // clears it (a customer can resubscribe by text, as carriers require).
    try {
      if (isStopKeyword(body)) {
        const n = await setSmsOptOutByPhone(companyId, from, true);
        console.log(`[comms/inbound] SMS opt-OUT recorded for ${n} client(s) (company=${companyId})`);
      } else if (isStartKeyword(body)) {
        const n = await setSmsOptOutByPhone(companyId, from, false);
        console.log(`[comms/inbound] SMS opt-IN (resubscribe) for ${n} client(s) (company=${companyId})`);
      }
    } catch (e) { console.warn("[comms/inbound] opt-out flag update failed:", e); }

    return res.type("text/xml").send("<Response/>");
  } catch (err) {
    console.error("[comms/inbound]", err);
    return res.type("text/xml").send("<Response/>");
  }
});

// ── Email unsubscribe (tokenized) ────────────────────────────────────────────
// Replaces the dead phes.io/unsubscribe mockup link. Every outbound customer
// email carries a List-Unsubscribe header + footer link pointing here.
//
//   POST /api/comms/unsubscribe?token=...  — RFC 8058 one-click (mail clients
//        POST here automatically when the user taps the native Unsubscribe). No
//        body needed; always 200.
//   GET  /api/comms/unsubscribe?token=...  — the visible footer link. Sets the
//        opt-out and renders a confirmation page with a one-tap resubscribe (so
//        an accidental / prefetched click is reversible).
//   GET  ...&action=resubscribe            — re-opt-in.
function unsubPage(title: string, message: string, resubscribeUrl?: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;background:#F7F6F3;font-family:'Plus Jakarta Sans',-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1A1917}
.card{max-width:440px;margin:64px auto;background:#fff;border:1px solid #E5E2DC;border-radius:12px;padding:32px;text-align:center}
h1{font-size:20px;margin:0 0 12px}p{font-size:14px;color:#6B6860;line-height:1.6;margin:0 0 20px}
a.btn{display:inline-block;background:#00C9A0;color:#0A0E1A;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px}</style>
</head><body><div class="card"><h1>${title}</h1><p>${message}</p>
${resubscribeUrl ? `<a class="btn" href="${resubscribeUrl}">Resubscribe</a>` : ""}
</div></body></html>`;
}

router.post("/unsubscribe", async (req, res) => {
  const token = String(req.query.token ?? req.body?.token ?? "");
  await setEmailOptOutByToken(token); // idempotent; 200 regardless (one-click never errors back)
  return res.status(200).send("ok");
});

router.get("/unsubscribe", async (req, res) => {
  const token = String(req.query.token ?? "");
  const action = String(req.query.action ?? "");
  if (!token) {
    return res.status(400).type("html").send(unsubPage("Invalid link", "This unsubscribe link is missing its token."));
  }
  if (action === "resubscribe") {
    const c = await clearEmailOptOutByToken(token);
    return res.type("html").send(
      c ? unsubPage("You're resubscribed", "You'll receive Phes emails again. You can unsubscribe any time.")
        : unsubPage("Link not recognized", "We couldn't find this subscription. No action was taken."),
    );
  }
  const c = await setEmailOptOutByToken(token);
  if (!c) {
    return res.status(404).type("html").send(unsubPage("Link not recognized", "We couldn't find this subscription. No action was taken."));
  }
  const resubUrl = `/api/comms/unsubscribe?token=${encodeURIComponent(token)}&action=resubscribe`;
  return res.type("html").send(
    unsubPage("You've been unsubscribed", "You won't receive marketing or reminder emails from Phes anymore. Changed your mind?", resubUrl),
  );
});

export default router;
