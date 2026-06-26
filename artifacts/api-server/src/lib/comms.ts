/**
 * Cutover 1C — Minimal SMS wrapper for the on-my-way send.
 *
 * Mirrors the gating already enforced in routes/job-sms.ts but exposed
 * as a small library function so the 1C on-my-way route doesn't need
 * to duplicate the Twilio handshake. Returns a structured result so
 * the caller can persist `client_notified` accurately:
 *   - "sent"        — Twilio accepted the message
 *   - "suppressed_comms_disabled"  — COMMS_ENABLED env not "true"
 *   - "suppressed_tenant_disabled" — tenant flipped sms_on_my_way_enabled off
 *   - "suppressed_client_opted_out" — clients.wants_on_my_way_notifications=false
 *   - "suppressed_no_phone"  — client has no phone on file
 *   - "error"       — Twilio API rejected; logged but never thrown
 *                     so the on-my-way row still gets written.
 *
 * The route layer maps "sent" → client_notified=true; everything else
 * → client_notified=false. The route never throws on SMS failure;
 * the wage record (on_my_way_event row) always lands.
 */

export type OnMyWaySmsResult =
  | { status: "sent"; sid: string }
  | { status: "suppressed_comms_disabled" }
  | { status: "suppressed_tenant_disabled" }
  | { status: "suppressed_client_opted_out" }
  | { status: "suppressed_no_phone" }
  | { status: "error"; message: string };

export async function sendOnMyWaySms(opts: {
  toPhone: string | null | undefined;
  fromPhone: string | null | undefined;
  companyName: string;
  techName: string;
  clientFirstName: string;
  serviceAddress: string;
  promisedArrivalLabel: string;
  tenantSmsEnabled: boolean;
  clientOptedIn: boolean;
  // [customer-messages] When the office has an active on_my_way SMS template,
  // the caller renders it (with {{tech_name}}/{{arrival_window}}/etc. already
  // merged) and passes it here. Empty/undefined → the built-in default below,
  // so a tenant with no template still gets a sensible message.
  bodyOverride?: string;
}): Promise<OnMyWaySmsResult> {
  if (process.env.COMMS_ENABLED !== "true") {
    console.log(
      "[COMMS BLOCKED] on-my-way SMS suppressed — COMMS_ENABLED!=true",
    );
    return { status: "suppressed_comms_disabled" };
  }
  if (!opts.tenantSmsEnabled) return { status: "suppressed_tenant_disabled" };
  if (!opts.clientOptedIn) return { status: "suppressed_client_opted_out" };
  if (!opts.toPhone || !opts.fromPhone) return { status: "suppressed_no_phone" };

  // Lead with the tenant's name; tech FIRST name only; concise, no ALL-CAPS.
  const sender = (opts.companyName || "").trim();
  const body =
    opts.bodyOverride && opts.bodyOverride.trim()
      ? opts.bodyOverride.trim()
      : `${sender ? sender + ": " : ""}your cleaner ${
          opts.techName
        } is on the way, arriving around ${opts.promisedArrivalLabel}.`;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return { status: "error", message: "Twilio credentials not configured" };
  }
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${accountSid}:${authToken}`,
          ).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: opts.toPhone,
          From: opts.fromPhone,
          Body: body,
        }).toString(),
      },
    );
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return { status: "error", message: `Twilio HTTP ${res.status}: ${errBody}` };
    }
    const json: any = await res.json().catch(() => ({}));
    return { status: "sent", sid: json?.sid ?? "unknown" };
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }
}
