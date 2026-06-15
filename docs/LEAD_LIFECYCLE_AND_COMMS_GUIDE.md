# Qleno Lead Lifecycle & Communications Guide

**Status:** Research / proposal for Sal's approval. **Nothing in section C/D is deployed.**
Prepared from the live system: imported MaidCentral templates (`message_templates`),
the active 7-touch cadence (`follow_up_steps`, company 4), Qleno's notification
templates (`notification_templates`, company 4), and the lead-pipeline code.

---

## A. Lead Lifecycle — Stages & Transitions

Seven canonical stages (source of truth: `leads.status`, UI `STATUS_CONFIG` /
`STATUS_ORDER` in `leads.tsx`). Pipeline order:

| # | Stage | Label | Entered when… | Trigger / source |
|---|-------|-------|---------------|------------------|
| 1 | `needs_contacted` | Needs Contacted | Lead created (manual, quote-sync, online form, contact form, booking widget) | `POST /api/leads`; `upsertLeadForQuote()` on quote create |
| 2 | `contacted` | Contacted | Office logs first outreach | **Manual** (office sets it); stamps `contacted_at` |
| 3 | `quoted` | Quoted | A quote is **sent** to the lead | `POST /api/quotes/:id/send` → `advanceLeadStage(…, "quoted")`; stamps `quoted_at` |
| 4 | `follow_up` | Follow Up | Lead is in the nurture window (quote out, not yet booked) | **Manual** stage; the 7-touch cadence runs during 3→4 |
| 5 | `booked` | Booked | Quote converted to a job (or accepted) | `POST /api/quotes/:id/convert` (and `/accept`) → `advanceLeadStage(…, "booked")`; stamps `booked_at`; **stops cadence** |
| 6 | `no_response` | No Response | Cadence exhausted, no engagement | **Manual** (office sets it) |
| 7 | `not_interested` | Not Interested | Lead declines | **Manual** (office sets it) |

**Notes**
- Stages 2, 4, 6, 7 are **operator-set** today (drag on the board / status change). Only `needs_contacted` (create), `quoted` (quote send), and `booked` (convert) are **automatic**.
- Every transition writes a `lead_activity_log` row (`stage_<name>`), so the lead's Activity tab shows the full history.
- Current Schaumburg/Phes data: 17 `needs_contacted`, 9 `booked` (no leads parked in the other stages yet).

---

## B. Every Communication a Lead Receives (in order)

### B0. Internal — "New Lead" office notification (fires on lead creation)
- **Audience:** internal office (NOT the customer). Function `fireOfficeNotification()` in `routes/leads.ts`.
- **Email** — to `info@phes.io` (hardcoded), from `Qleno <noreply@phes.io>` (hardcoded). Subject: `New Lead: <Full Name>`. Body: branded card with Name / Source / Scope / Phone / Lead ID + "Log in to Qleno to review and assign this lead."
- **SMS** — to `+17737869902` (hardcoded Oak Lawn), from the **global** Twilio env number. Body: `New lead — <name> — <source> — <phone>. Log in to review.`
- ⚠️ **Both recipient + sender are hardcoded to Oak Lawn** regardless of tenant — see Section D fix.

### B1. Quote email + SMS — the "your quote is ready" send (fires on quote send)
Two systems fire on `POST /api/quotes/:id/send`:

**(i) `quote_sent` notification** (immediate; `notificationService.sendNotification`)
- **Email** — subject `Your quote from {{company_name}} — #{{quote_number}}`
  Body: `Hi {{first_name}}, your quote #{{quote_number}} from {{company_name}} is ready — ${{quote_total}} estimated. Review: {{quote_link}} or call {{company_phone}} to book.`
- **SMS** — same copy.
- ⚠️ `{{quote_link}}` = `https://clean-ops-pro.replit.app/quote/<id>` → **404** (wrong domain + nonexistent path). SMS goes from the **global** Twilio number, not the tenant's. See Section D.

**(ii) 7-touch quote follow-up cadence** (enrolled on send; processed by the cron / `send-one`). Full content below.

### B2. The 7-touch follow-up cadence (company 4 — "Quote Follow-Up")
Delays are measured from the **previous** touch; all sends clamped to business hours (8:00–21:00 local).

| Touch | Channel | Cumulative timing | Subject (email) | Body |
|-------|---------|-------------------|-----------------|------|
| 1 | Email | ~0 (on send) | **Your cleaning quote from Phes** | Hi {{first_name}}, thank you for reaching out to Phes. Your quote is ready and we would love to get you on the schedule. Reply any time with questions. |
| 2 | SMS | ~0 (on send) | — | Hi {{first_name}}, this is the Phes office following up on your cleaning quote. Want us to find you a time? Just reply here. |
| 3 | SMS | +24h (~Day 1) | — | Hi {{first_name}}, checking in on your Phes quote. Happy to answer any questions or book your first clean whenever you are ready. |
| 4 | Email | +48h (~Day 3) | **Still here when you are ready** | Hi {{first_name}}, just following up on your cleaning quote. We have openings this week and can usually match the day that works best for you. Reply to get started. |
| 5 | SMS | +48h (~Day 5) | — | Hi {{first_name}}, the Phes team would still love to help with your cleaning. Want me to hold a spot for you this week? |
| 6 | Email | +120h (~Day 10) | **A clean home is closer than you think** | Hi {{first_name}}, we know life gets busy. Your Phes quote is still good and booking only takes a minute. Reply and we will take it from there. |
| 7 | Email | +192h (~Day 18) | **Closing out your quote** | Hi {{first_name}}, we will pause our follow-ups for now so we are not crowding your inbox. Whenever you are ready for a cleaning, just reply and we will pick right back up. Thank you from the Phes team. |

### B3. Booking confirmation (fires on convert/book)
- `job_scheduled` notification — email subject `Your cleaning is confirmed for {{date}}`.
- `new_client_welcome` (email + SMS) when a client record is created: `Hi {{first_name}}, welcome to {{company_name}}! We look forward to your first cleaning. Questions anytime: {{company_phone}}. See you soon.`

### B4. Cadence stop conditions
1. **Booked / accepted / converted** → `stopEnrollmentsForQuote(reason="booked")`.
2. **Customer replies** (any inbound SMS) → `handleInboundReply()` stops the active cadence (stop-on-reply), `POST /api/comms/inbound`.
3. **Opt-out keyword** — STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT → flagged opt-out + cadence stopped.
4. **Cadence completes** (touch 7 sent) → enrollment marked completed.

---

## C. Proposed Qleno Quote Email — modeled on Phes's MaidCentral version

### C1. The MaidCentral source (verbatim) — "Quote Send (Many Lines)"
This is the customized initial quote email Phes edited in MaidCentral.

- **Subject:** `Thank you for your interest!`
- **Structure / sections:**
  1. H1 greeting: `{{C_FIRSTNAME}}, thank you for your interest!`
  2. "Below is the quote we've discussed."
  3. "Please verify the information below and contact us at `{{SVCCOPHONE}}` or `{{SVCCOEMAIL}}` to get started."
  4. **Office hours + 48-hour notice** paragraph (Mon–Fri 9–6, Sat 9–12 CT; Sundays don't count).
  5. **Cancellations & Rescheduling** bullets: 48h notice; Monday→notify by Fri 6pm CT; Tuesday→notify by Sat noon CT; <48h = 100% charge; late arrival wait max 20 min then forfeit.
  6. **Satisfaction Guarantee:** miss a spot → free re-clean, **NO REFUNDS**, report within 24h.
  7. Link to the **Checklist** (`https://phes.io/cleaning-checklist`).
  8. **Customer info block:** Address `{{H_ADDRESS}} {{H_ADDRESS2}}`, Payment Method `{{PAYMENTMETHOD}}`, Email `{{C_EMAILADDRESS}}`, Phone `{{C_PHONE}}`.
  9. **"Quote Details"** heading → "We've itemized the services we are quoting." → itemized fee table `{{FEETABLE}}`.
- **Tone:** warm, professional, policy-forward (sets expectations up front). MaidCentral merge fields: `{{C_FIRSTNAME}}`, `{{SVCCONAME}}`, `{{SVCCOPHONE}}`, `{{SVCCOEMAIL}}`, `{{H_ADDRESS}}/{{H_ADDRESS2}}`, `{{PAYMENTMETHOD}}`, `{{C_EMAILADDRESS}}`, `{{C_PHONE}}`, `{{FEETABLE}}`.

(Companion templates Phes also customized: **"Quote Customer Convert (Many Lines)"** = booking confirmation with full cancellation/site-prep/liability/right-to-rectify/home-access/non-solicitation policy; **"Quote Follow Up"** = simple "still interested?" nudge; **"Online Quote Text Follow Up"** = the "Hi, this is Sal from Phes…" SMS; **"New Lead"** email/SMS = first-touch acknowledgements.)

### C2. Proposed Qleno quote email (Phes-styled, with corrected merge fields + link)

> **Subject:** Thank you for your interest, {{first_name}}! — Your Phes cleaning quote
>
> **{{first_name}}, thank you for your interest!**
>
> Below is the quote we've discussed. Please review the details and tap the button to view your full quote or book your first clean.
>
> **[ View & Book Your Quote ]** → `https://app.qleno.com/estimate/{{sign_token}}`
>
> Questions? Call or text us at {{company_phone}} or reply to this email.
>
> ---
> **Quote Details** — we've itemized the services we're quoting:
> {{line_items_table}}  ·  **Total: ${{quote_total}}**
>
> **Your info**
> Address: {{service_address}} · Email: {{customer_email}} · Phone: {{customer_phone}}
>
> ---
> **Office hours:** Mon–Fri 9 AM–6 PM, Sat 9 AM–12 PM CT (closed Sun).
>
> **Cancellations & Rescheduling**
> 🔹 48 hours' notice to cancel or reschedule (Sundays don't count)
> 🔹 Monday appointments: notify by Friday 6 PM CT · Tuesday: by Saturday noon CT
> 🔹 Cancellations within 48 hours are charged 100% of the invoice
> 🔹 Late arrivals: we wait a max of 20 minutes, then the visit is forfeited
>
> **Satisfaction Guarantee**
> 🔹 If we miss a spot, we'll return and re-clean for free — **no refunds**
> 🔹 Contact us within 24 hours of your cleaning if there's an issue
>
> See everything we do on our [Checklist](https://phes.io/cleaning-checklist).
>
> — The {{company_name}} Team

**Proposed Qleno merge fields:** `{{first_name}}`, `{{company_name}}`, `{{company_phone}}`,
`{{sign_token}}`, `{{quote_total}}`, `{{line_items_table}}`, `{{service_address}}`,
`{{customer_email}}`, `{{customer_phone}}`. The matching SMS keeps the existing short copy but
swaps `{{quote_link}}` for the corrected `app.qleno.com/estimate/{{sign_token}}` URL.

---

## D. Deployment Spec (to ship AFTER approval — not yet built)

### D1. Corrected customer-facing links
- **Single source of truth:** standardize on `process.env.APP_BASE_URL` (default `https://app.qleno.com`). Retire the hardcoded `clean-ops-pro.replit.app` strings and the buggy `getAppBaseUrl()` (operator-precedence bug returns the Replit domain even when `APP_URL` is set).
- **Quote link target:** the public, unauthenticated estimate page — `https://app.qleno.com/estimate/{{sign_token}}` (route `/estimate/:token` → `EstimatePublicPage`). Requires populating `quotes.sign_token` on send (the column exists; confirm it's set, else generate on `/send`).
- **Invoice/pay link:** `https://app.qleno.com/pay/{{pay_token}}` (route `/pay/:token` takes a **token**, not the invoice id — current `clean-ops-pro/pay/<invoiceId>` is wrong twice over).
- Call sites to fix: `routes/quotes.ts:311`, `routes/invoices.ts:447,503`, `routes/payment-links.ts:14`.

### D2. Per-tenant SMS from-number (all paths)
- Route **every** SMS send through `resolveSender(companyId, branchId)` + `sendSmsVia()` so each tenant sends from its own `companies.twilio_from_number` (Schaumburg = **+16308844318**).
- Retire the legacy global-env path `notificationService.sendTwilioSms()` (uses `TWILIO_FROM_NUMBER` = Oak Lawn +17737869902). Update `sendNotification`'s SMS branch (it already has `companyId`) and the two stray paths (`notificationService.ts:330`, `lib/comms.ts:73`).

### D3. Per-tenant internal "New Lead" notification routing
- `fireOfficeNotification()` must route by `companyId` instead of hardcoding Oak Lawn:
  - **From (email):** the tenant's `companies.email_from_address` → Schaumburg = `schaumburg@phes.io`.
  - **To (email):** the tenant's office inbox → **Schaumburg lead alerts go to `salmartinez8@gmail.com`** (per Sal). (Oak Lawn keeps its existing inbox.) Suggest a dedicated `companies.lead_notify_email` column rather than overloading `companies.email`.
  - **SMS:** office number + from-number via `resolveSender(companyId)`, not the hardcoded `+17737869902` / global env.

### D4. Quote email content
- Replace the one-line `quote_sent` email/SMS with the **Phes-styled quote email** in Section C2 (policy-forward, itemized, public-estimate CTA), using the corrected merge fields and `APP_BASE_URL`.

---

*All sends remain gated off (global `COMMS_ENABLED=false`, all tenants `comms_enabled=false`)
until Sal approves this spec and we re-run the go-live sequence.*
