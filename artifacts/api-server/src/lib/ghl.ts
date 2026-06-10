// [ghl-estimate-bridge 2026-06-10] GoHighLevel inbound-webhook bridge.
//
// Qleno does NOT text estimate follow-ups itself — GHL owns the drip, sending
// from the office line the tenant already texts from. Qleno's only job is to
// notify GHL's workflow webhooks at two moments:
//   - estimate sent    → GHL creates/updates the contact and starts the drip
//   - accept / decline → GHL stops the drip (and can notify the office)
//
// Opt-in by design: a webhook only fires when the tenant pasted its URL into
// Estimate Settings. These are integration events to the tenant's own CRM,
// not Qleno comms — the COMMS_ENABLED Twilio/Resend gate does not apply.
// Fire-and-forget: a GHL outage must never fail the user-facing request.

const TIMEOUT_MS = 5000;

export type GhlEstimatePayload = {
  event: "estimate_sent" | "estimate_accepted" | "estimate_declined";
  estimate_id: number;
  estimate_number: string | null;
  title: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  property_name: string | null;
  service_address: string | null;
  total: string | null;
  valid_until: string | null;
  estimate_link: string | null;
  accepted_name?: string | null;
};

export async function fireGhlWebhook(url: string | null | undefined, payload: GhlEstimatePayload): Promise<boolean> {
  if (!url || !/^https:\/\//i.test(url.trim())) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(url.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[ghl] webhook ${payload.event} for estimate ${payload.estimate_id} returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`[ghl] webhook ${payload.event} for estimate ${payload.estimate_id} failed:`, err?.message ?? err);
    return false;
  }
}
