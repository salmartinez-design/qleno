import { Router } from "express";
import { handleInboundReply } from "../lib/lead-sync.js";
import { resolveTenantByNumber, recordInboundSms } from "../lib/sms-store.js";
import { isStopKeyword, isStartKeyword, setSmsOptOutByPhone, setEmailOptOutByToken, clearEmailOptOutByToken } from "../lib/opt-out.js";

const router = Router();

const OPT_OUT = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

// TwiML is XML. The only interpolated value is a customer's own first name out
// of our DB, but an "O'Brien & Sons" is enough to produce a malformed body that
// Twilio rejects — and a silently dropped reply is the exact failure we're here
// to fix.
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// POST /api/comms/inbound — Twilio inbound-SMS/MMS webhook (PUBLIC, no auth).
// Twilio posts form-encoded { From, To, Body, MessageSid, NumMedia, MediaUrl0... }.
// The `To` number maps to a tenant. We:
//   1) download any MMS media from Twilio, upload to R2, store keys in media_urls,
//   2) persist the inbound message in the unified sms_messages store (matched to
//      a CLIENT or LEAD by the sender's last-10 digits),
//   3) stop the active follow-up cadence for the matching lead AND client
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

    // MMS: Twilio sends NumMedia + MediaUrl0..N + MediaContentType0..N
    const numMedia = parseInt(String(req.body?.NumMedia ?? "0"), 10) || 0;
    const mediaUrls: string[] = [];
    if (numMedia > 0) {
      try {
        const { r2Configured, r2Upload } = await import("../lib/r2.js");
        // Need Twilio creds to download the media
        const { db } = await import("@workspace/db");
        const { sql } = await import("drizzle-orm");
        const cr = await db.execute(sql`SELECT twilio_account_sid, twilio_auth_token FROM companies WHERE id = ${companyId} LIMIT 1`);
        const creds: any = cr.rows[0] ?? {};
        const basicAuth = (creds.twilio_account_sid && creds.twilio_auth_token)
          ? "Basic " + Buffer.from(`${creds.twilio_account_sid}:${creds.twilio_auth_token}`).toString("base64")
          : null;
        for (let i = 0; i < numMedia; i++) {
          const mediaUrl = String(req.body?.[`MediaUrl${i}`] ?? "");
          const contentType = String(req.body?.[`MediaContentType${i}`] ?? "image/jpeg");
          if (!mediaUrl) continue;
          try {
            const fetchHeaders: Record<string, string> = {};
            if (basicAuth) fetchHeaders["Authorization"] = basicAuth;
            const mediaResp = await fetch(mediaUrl, { headers: fetchHeaders });
            if (!mediaResp.ok) { console.warn(`[comms/inbound] MMS media fetch failed: ${mediaResp.status}`); continue; }
            const buf = Buffer.from(await mediaResp.arrayBuffer());
            const ext = (contentType.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
            const { randomBytes } = await import("node:crypto");
            const rand = randomBytes(12).toString("hex");
            const key = `sms-media/${companyId}/${rand}.${ext}`;
            if (r2Configured()) {
              await r2Upload(key, buf, contentType);
              mediaUrls.push(key);
            }
          } catch (e) { console.warn(`[comms/inbound] MMS media[${i}] error:`, e); }
        }
      } catch (e) { console.warn("[comms/inbound] MMS media import error:", e); }
    }

    // 1) Persist + match (client or lead).
    const { match } = await recordInboundSms({ companyId, fromRaw: from, toRaw: to, body, providerId: sid, mediaUrls: mediaUrls.length > 0 ? mediaUrls : null });

    // Alert office staff (in-app). Internal staff notification — never customer-facing.
    try {
      const { notifyOfficeUsers } = await import("../lib/notify.js");
      const d = from.replace(/\D/g, "").slice(-10);
      const who = match.name || (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : from);
      const notifyBody = mediaUrls.length > 0 && !body
        ? `[${mediaUrls.length} image${mediaUrls.length > 1 ? "s" : ""}]`
        : mediaUrls.length > 0 ? `${body.slice(0, 120)} [+${mediaUrls.length} image${mediaUrls.length > 1 ? "s" : ""}]`
        : body.slice(0, 160);
      await notifyOfficeUsers(companyId, {
        type: "new_message",
        title: `New text from ${who}`,
        body: notifyBody,
        link: "/messages",
        meta: { phone: d, client_id: match.client_id, lead_id: match.lead_id },
      });
    } catch (e) { console.warn("[comms/inbound] notify failed:", e); }

    // 2) Stop-on-reply + opt-out. Leads via handleInboundReply (matches by phone,
    //    stops cadence, logs activity). Clients via stopEnrollmentsForClient.
    //
    // [stop-is-sms-only 2026-08-20] These stops fire on a REPLY, not on a STOP.
    // A reply means a person is in the conversation and the office takes over,
    // so the whole cadence ends. STOP is narrower: it is the text-message word
    // for "quit texting me". It is not an email unsubscribe -- that is the
    // footer link, and it sets email_opt_out_at. Ending the enrollment on STOP
    // killed the email steps as well, which is how the Pious Projects estimate
    // lost its Friday follow-up email when the contact texted STOP at the
    // Thursday reminder, having never unsubscribed from email.
    //
    // Nothing extra is needed to silence the texts. setSmsOptOutByPhone below
    // records the opt-out, and the cadence runner checks isSmsOptedOut before
    // every SMS step: that touch is logged 'blocked' and the enrollment advances
    // to the next step. SMS goes quiet, email carries on.
    const optOut = OPT_OUT.has(body.toUpperCase());
    await handleInboundReply(companyId, from, optOut);
    if (!optOut) {
      if (match.client_id != null) {
        try {
          const { stopEnrollmentsForClient } = await import("../services/followUpService.js");
          await stopEnrollmentsForClient(match.client_id, "replied");
        } catch (e) { console.warn("[comms/inbound] client cadence stop failed:", e); }
      }
      // [estimate-drip-phase3] Stop estimate drips when the property manager texts
      // back (matched on the estimate's contact_phone), independent of client match.
      try {
        const { stopEstimateEnrollmentsByPhone } = await import("../services/followUpService.js");
        await stopEstimateEnrollmentsByPhone(companyId, from, "replied");
      } catch (e) { console.warn("[comms/inbound] estimate cadence stop failed:", e); }
    }

    // [comms-opt-out 2026-06-21] Record the SMS opt-out flag on the client(s)
    // (matched by phone, last-10) so EVERY send path honors it — not just the
    // follow-up cadence. STOP/UNSUBSCRIBE/CANCEL/QUIT sets it; START/UNSTOP
    // clears it (a customer can resubscribe by text, as carriers require).
    try {
      if (isStopKeyword(body)) {
        const n = await setSmsOptOutByPhone(companyId, from, true);
        console.log(`[comms/inbound] SMS opt-OUT recorded for ${n} client(s) (company=${companyId})`);
        // [opt-out-confirmation 2026-08-02] Send the confirmation again.
        //
        // The 2026-07-12 change removed this call, reasoning that Twilio's
        // carrier opt-out blocks the number the instant STOP arrives (error
        // 21610, seen in prod on Leen Subei) so the confirmation "MUST come from
        // Twilio's Advanced Opt-Out". That holds only when Twilio's opt-out
        // management is actually ACTIVE on the number. When it isn't, Twilio
        // neither blocks nor confirms — and with our call removed, nobody
        // confirmed at all. The customer texts STOP and hears nothing back,
        // which is what Sal is seeing.
        //
        // Restoring the call is safe in both worlds, which is exactly what
        // sendSmsOptOutConfirmation was built for:
        //   • Twilio handles opt-out  -> our send is rejected 21610, caught and
        //     logged inside, never fatal. The opt-out already stuck.
        //   • Twilio does NOT handle it -> our confirmation is the only one the
        //     customer gets, and it lands.
        // It also logs into sms_messages, so the office can SEE the confirmation
        // in the thread instead of guessing (a Twilio-generated one never passes
        // through this app and is invisible here — the reason this looked broken
        // from the inbox either way).
        //
        // Legality: the opt-out confirmation is the one message permitted after
        // a STOP under CTIA guidelines, and `from` is the number they texted.
        try {
          const { sendSmsOptOutConfirmation } = await import("../lib/opt-out.js");
          const sent = await sendSmsOptOutConfirmation(companyId, from, to);
          console.log(`[comms/inbound] opt-out confirmation ${sent ? "sent" : "not delivered (Twilio likely answered it)"} to ${from}`);
        } catch (e) { console.warn("[comms/inbound] opt-out confirmation failed:", (e as any)?.message ?? e); }
      } else if (isStartKeyword(body)) {
        const n = await setSmsOptOutByPhone(companyId, from, false);
        console.log(`[comms/inbound] SMS opt-IN (resubscribe) for ${n} client(s) (company=${companyId})`);
      }
    } catch (e) { console.warn("[comms/inbound] opt-out flag update failed:", e); }

    // [survey-sms-reply 2026-08-15] A bare "4" back from a customer with an open
    // satisfaction survey IS their answer — record it. This lives here, in the
    // live webhook, because the rating parser that already existed in
    // routes/sms-inbound.ts resolves the tenant by `companies.twilio_from_number`
    // and Phes keeps its numbers on the BRANCHES, so it has never run once in
    // production (zero rows in `scorecards` from it).
    //
    // handleSurveySmsReply returns null unless the sender has an OPEN survey AND
    // the message is nothing but a digit — so a customer asking a question gets
    // silence from the bot and a human from the office, which is the point. The
    // acknowledgement is mirrored into sms_messages: Twilio sends TwiML replies
    // itself, so without this the office would see a one-sided thread.
    let surveyAck: string | null = null;
    try {
      const { handleSurveySmsReply } = await import("../lib/survey-sms-reply.js");
      surveyAck = await handleSurveySmsReply(companyId, match.client_id ?? null, body, match.name ?? null);
      // The SCORE is a database write and always lands. The courtesy text back
      // is a customer-facing send, so it respects COMMS_ENABLED and the
      // per-company/branch gate like everything else — a muted tenant records
      // the rating silently rather than quietly bypassing the gate.
      if (surveyAck) {
        const { resolveSender } = await import("../lib/comms-sender.js");
        const sender = await resolveSender(companyId);
        if (sender.reason) {
          console.log(`[comms/inbound] survey ack suppressed (${sender.reason}); rating still recorded`);
          surveyAck = null;
        }
      }
      if (surveyAck) {
        const { recordOutboundSms } = await import("../lib/sms-store.js");
        await recordOutboundSms({
          companyId, toRaw: from, fromNumber: to, body: surveyAck, clientId: match.client_id ?? null,
        }).catch(() => {});
      }
    } catch (e) { console.warn("[comms/inbound] survey reply handling failed:", e); }

    if (surveyAck) {
      return res.type("text/xml").send(`<Response><Message>${escapeXml(surveyAck)}</Message></Response>`);
    }
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
