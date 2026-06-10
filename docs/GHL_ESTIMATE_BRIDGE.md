# GoHighLevel Estimate Bridge — One-Time Setup

Qleno pushes estimate events to GoHighLevel; **GHL owns the texting** (from the
office line 773-706-6000 already connected in GHL). Two webhooks:

| Event | When Qleno fires it | What your GHL workflow does |
|---|---|---|
| `estimate_sent` | Office clicks "Send — get link" on an estimate | Create/update the contact, text the estimate link, start the follow-up drip |
| `estimate_accepted` / `estimate_declined` | Customer taps Accept (or Decline) on the hosted estimate page | Stop the drip; optionally notify the office |

Plan note: the **Inbound Webhook trigger works on the $97 Starter plan** — it's
a metered "premium workflow" feature (~$0.01 per execution after the monthly
free allowance), so each estimate costs roughly a penny plus normal SMS usage.

## Payload Qleno sends (JSON)

```json
{
  "event": "estimate_sent",
  "estimate_id": 42,
  "estimate_number": "EST-1042",
  "title": "Common Area Cleaning — Monthly Service",
  "contact_name": "Jane Property Manager",
  "contact_email": "jane@example.com",
  "contact_phone": "(773) 555-0123",
  "property_name": "5721 W 103rd St Condos",
  "service_address": "5721 W 103rd St, Oak Lawn, IL 60453",
  "total": "850.00",
  "valid_until": "2026-07-10",
  "estimate_link": "https://<your-app-domain>/estimate/<token>",
  "accepted_name": null
}
```

`estimate_accepted` carries the same fields plus `accepted_name` (the name the
customer typed when accepting).

## Workflow 1 — "Qleno Estimate Sent" (starts the drip)

1. GHL → **Automation → Workflows → Create Workflow → Start from Scratch**.
2. **Add Trigger → Inbound Webhook.** GHL shows a webhook URL — copy it.
   Keep this tab open; you'll post a sample to it in step 7.
3. Action: **Create/Update Contact** — map from the webhook payload:
   name ← `contact_name`, phone ← `contact_phone`, email ← `contact_email`.
4. Action: **Add Tag** → `qleno-estimate-out` (this is the drip's membership
   tag — removal stops the drip if you build the drip on tag).
5. Action: **Send SMS** (from the office number):
   > Hi {{contact.first_name}} — here's your cleaning estimate for
   > {{inboundWebhookRequest.property_name}}: {{inboundWebhookRequest.estimate_link}}
   > Total: ${{inboundWebhookRequest.total}}. Tap the link to view or accept.
   > — Phes
6. Drip: add **Wait 2 days → If/Else (contact has tag `qleno-estimate-out`) →
   Send SMS** ("Any questions on the estimate? Happy to walk it over the
   phone."), then **Wait 3 days → SMS**, then **Wait 4 days → final SMS**.
   Every follow-up SMS sits inside an If/Else that checks the tag, so removing
   the tag (Workflow 2) silences the rest of the drip.
7. **Save + Publish.** In the trigger, use "Check webhook" / send a test —
   you can paste the sample JSON above.
8. Paste the trigger's webhook URL into Qleno → **Estimates → GoHighLevel tab
   → "Estimate sent" webhook URL** → Save.

## Workflow 2 — "Qleno Estimate Outcome" (stops the drip)

1. New workflow → **Trigger: Inbound Webhook** — copy its URL.
2. Action: **Find/Update Contact** by phone/email (same mapping).
3. Action: **Remove Tag** → `qleno-estimate-out` (drip goes quiet).
4. Optional: **If/Else on `{{inboundWebhookRequest.event}}`**:
   - `estimate_accepted` → Send SMS to the customer ("Thank you! We'll reach
     out shortly to schedule.") and/or an internal notification to the office.
   - `estimate_declined` → internal notification only.
5. Save + Publish → paste this URL into Qleno → **Estimates → GoHighLevel tab
   → "Outcome" webhook URL** → Save.

## Behavior notes

- The bridge is **opt-in**: nothing fires until a URL is saved. Clearing a URL
  field disables that webhook.
- Webhooks are **fire-and-forget** with a 5-second timeout — a GHL outage never
  blocks sending or accepting an estimate. A successful `estimate_sent` stamp
  is recorded on the estimate (`ghl_synced_at`).
- Qleno itself sends **no SMS or email** for estimates; GHL is the only sender,
  consistent with the COMMS_ENABLED=false posture (which governs Qleno's own
  Twilio/Resend, not the tenant's CRM).
- Re-clicking "Send" on an estimate fires `estimate_sent` again — GHL's
  Create/Update Contact is idempotent, but if you don't want the drip to
  restart, add an If/Else on the tag at the top of Workflow 1.
