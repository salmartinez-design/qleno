import { Router } from "express";
import { db } from "@workspace/db";
import {
  paymentLinksTable, clientsTable, companiesTable, invoicesTable, notificationLogTable,
  paymentsTable, jobsTable
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { appBaseUrl } from "../lib/app-url.js";
import crypto from "crypto";

const router = Router();

// ─── Helper: get app base URL ─────────────────────────────────────────────────
// Delegates to the single source of truth (APP_BASE_URL → https://app.qleno.com).
// The previous implementation had an operator-precedence bug: `A || B ? C : D`
// parsed as `(A || B) ? C : D`, so it returned the Replit domain even when
// APP_URL was set, and never returned APP_URL at all.
function getAppBaseUrl(): string {
  return appBaseUrl();
}

// [card-link-delivery 2026-07-22] Twilio only accepts E.164. The card-link
// route was passing whatever was typed ("7738188400") straight through, so
// Twilio rejected it and the send silently died. Same normalisation the
// working estimate-SMS path uses.
function toE164(p: string | null | undefined): string | null {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d ? `+${d}` : null;
}

// ─── POST /payment-links — create & optionally send ───────────────────────────
router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    // [card-link-recipient-override 2026-07-22] to_email / to_phone let the
    // caller send this one link to a different address/number than the client
    // record holds (Sal: "send this as an SMS… with the ability to edit the
    // number so clients can leave a card on file"). Omitted = client record, so
    // every existing caller is unchanged.
    const { client_id, purpose = "save_card", invoice_id, amount, send_email, send_sms, to_email, to_phone } = req.body;
    const overrideEmail = typeof to_email === "string" && to_email.trim() ? to_email.trim() : null;
    const overridePhone = typeof to_phone === "string" && to_phone.trim() ? to_phone.trim() : null;

    if (!client_id) return res.status(400).json({ error: "client_id required" });

    // Look up client
    const [client] = await db
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.id, client_id), eq(clientsTable.company_id, companyId)));
    if (!client) return res.status(404).json({ error: "Client not found" });

    const [company] = await db
      .select()
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));

    // Generate token
    const token = crypto.randomBytes(20).toString("hex");
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours

    const [link] = await db
      .insert(paymentLinksTable)
      .values({
        company_id: companyId,
        client_id,
        token,
        purpose,
        invoice_id: invoice_id ?? null,
        amount: amount ?? null,
        expires_at: expiresAt,
        created_by: req.auth!.userId,
      })
      .returning();

    // [card-link-delivery 2026-07-22] Track what ACTUALLY went out. This route
    // used to return success even when the send was skipped or threw, so the UI
    // reported "sent" for a message that never left. Callers now get the truth.
    let emailSent = false, smsSent = false;
    let emailReason: string | null = null, smsReason: string | null = null;
    let smsDetail: string | null = null;

    const baseUrl = getAppBaseUrl();
    const payUrl = `${baseUrl}/pay/${token}`;

    const clientName = `${client.first_name} ${client.last_name}`;
    const companyName = company.name;

    // Send email via Resend if requested
    if (send_email) {
      if (process.env.COMMS_ENABLED !== "true") {
        console.log("[COMMS BLOCKED] Payment link email suppressed:", { clientId: client.id });
      } else {
      const toEmail = overrideEmail || client.billing_contact_email || client.email;
      if (!toEmail) {
        return res.status(400).json({ error: "Client has no email address" });
      }

      const resendKey = process.env.RESEND_API_KEY;
      if (!resendKey) {
        console.warn("RESEND_API_KEY not set — skipping email");
      } else {
        try {
          const { Resend } = await import("resend") as any;
          const resend = new Resend(resendKey);
          await resend.emails.send({
            // [card-link-from-addr 2026-06-26] Was noreply@qlenopro.com — an
            // UNVERIFIED Resend domain, so every card-link email was silently
            // rejected. Use the tenant's verified sender (the same address the
            // working confirmation/reminder emails use).
            from: `${companyName} <${(company as any).email_from_address || "info@phes.io"}>`,
            to: toEmail,
            subject: `${companyName} — Save your payment method`,
            html: buildCardLinkEmail({ clientName, companyName, payUrl, brandColor: company.brand_color }),
          });
          await db.insert(notificationLogTable).values({
            company_id: companyId,
            trigger: "payment_link_email",
            channel: "email",
            recipient: toEmail,
            status: "sent",
          }).catch(() => {});
          emailSent = true;
        } catch (err: any) {
          emailReason = "send_failed";
          console.error("[card-link] Email send failed:", err?.message ?? err);
        }
      }
      } // end COMMS_ENABLED else
      if (!emailSent && !emailReason) emailReason = process.env.COMMS_ENABLED !== "true" ? "comms_disabled" : "resend_unconfigured";
    }

    // Send SMS via Twilio if requested
    if (send_sms) {
      if (process.env.COMMS_ENABLED !== "true") {
        console.log("[COMMS BLOCKED] Payment link SMS suppressed:", { clientId: client.id });
      } else {
      const toPhone = toE164(overridePhone || client.billing_contact_phone || client.phone);
      // [card-link-sender-parity 2026-07-22] This path used to hand-roll a Twilio
      // REST call: it authenticated with the ENV account_sid but took the From
      // number as `company.twilio_from_number || sender.from_number` — the
      // INVERSE of resolveSender's branch-first precedence. For a tenant that
      // keeps a stale number on the company row (Phes co1 keeps the real numbers
      // on the BRANCHES), that pairs an account with a From it doesn't own and
      // Twilio rejects the send (21606) — the card link "sent" but never arrived
      // while the estimate SMS to the SAME number worked. Route through
      // resolveSender + sendSmsVia like every other working SMS path so the
      // credentials and the From number always come from one resolution.
      const { resolveSender, sendSmsVia } = await import("../lib/comms-sender.js");
      const sender = await resolveSender(companyId, (client as any).branch_id ?? null);
      if (!toPhone || sender.reason) {
        smsReason = !toPhone ? "no_phone" : sender.reason!;
        console.warn("[card-link] SMS skipped:", smsReason);
      } else {
        try {
          await sendSmsVia(
            sender,
            toPhone,
            `${companyName}: Please save your payment method for future invoices. Link expires in 72 hours: ${payUrl}`
          );
          await db.insert(notificationLogTable).values({
            company_id: companyId,
            trigger: "payment_link_sms",
            channel: "sms",
            recipient: toPhone,
            status: "sent",
          }).catch(() => {});
          smsSent = true;
        } catch (err: any) {
          // sendSmsVia throws with the Twilio status + code + message. Surface it
          // so a rejected send says WHY instead of a bare "send_failed".
          smsReason = "send_failed";
          smsDetail = String(err?.message ?? err).slice(0, 300);
          console.error("[card-link] SMS send failed:", smsDetail, { from: sender.from_number, to: toPhone });
        }
      }
      } // end COMMS_ENABLED else
      if (!smsSent && !smsReason) smsReason = "comms_disabled";
    }

    res.json({
      id: link.id, token, url: payUrl, expires_at: expiresAt,
      email_sent: emailSent, email_reason: emailReason,
      sms_sent: smsSent, sms_reason: smsReason, sms_detail: smsDetail,
    });
  } catch (err) {
    console.error("Create payment link error:", err);
    res.status(500).json({ error: "Failed to create payment link" });
  }
});

// ─── GET /pay/:token — PUBLIC: validate token ─────────────────────────────────
router.get("/public/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const [link] = await db
      .select()
      .from(paymentLinksTable)
      .where(eq(paymentLinksTable.token, token));

    if (!link) return res.status(404).json({ error: "INVALID_LINK" });
    if (link.used_at) return res.status(410).json({ error: "ALREADY_USED" });
    if (link.expires_at < new Date()) return res.status(410).json({ error: "EXPIRED" });

    const [client] = await db
      .select({
        id: clientsTable.id,
        first_name: clientsTable.first_name,
        last_name: clientsTable.last_name,
        email: clientsTable.email,
        billing_contact_email: clientsTable.billing_contact_email,
      })
      .from(clientsTable)
      .where(eq(clientsTable.id, link.client_id));

    const [company] = await db
      .select({
        id: companiesTable.id,
        name: companiesTable.name,
        logo_url: companiesTable.logo_url,
        brand_color: companiesTable.brand_color,
      })
      .from(companiesTable)
      .where(eq(companiesTable.id, link.company_id));

    let invoiceNumber: string | null = null;
    let invoiceAlreadyPaid = false;
    let invoiceJobId: number | null = null;
    if (link.invoice_id) {
      const [inv] = await db
        .select({ invoice_number: invoicesTable.invoice_number, status: invoicesTable.status, job_id: invoicesTable.job_id })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, link.invoice_id));
      invoiceNumber = inv?.invoice_number ?? null;
      invoiceAlreadyPaid = inv?.status === "paid";
      invoiceJobId = inv?.job_id ?? null;
    }

    // Create Stripe setup intent if Stripe is configured
    let stripePublishableKey: string | null = null;
    let clientSecret: string | null = null;
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const stripePubKey = process.env.STRIPE_PUBLISHABLE_KEY;

    if (stripeSecretKey && stripeSecretKey !== "payments disabled" && stripePubKey) {
      try {
        const Stripe = (await import("stripe")).default;
        const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-06-20" as any });

        // Get or create Stripe customer
        let stripeCustomerId = client ? (await db
          .select({ stripe_customer_id: clientsTable.stripe_customer_id })
          .from(clientsTable)
          .where(eq(clientsTable.id, link.client_id)))[0]?.stripe_customer_id : null;

        if (!stripeCustomerId) {
          const customer = await stripe.customers.create({
            name: `${client?.first_name} ${client?.last_name}`,
            email: client?.billing_contact_email || client?.email || undefined,
            metadata: { company_id: String(link.company_id), client_id: String(link.client_id) },
          });
          stripeCustomerId = customer.id;
          await db.update(clientsTable)
            .set({ stripe_customer_id: stripeCustomerId })
            .where(eq(clientsTable.id, link.client_id));
        }

        // [invoice-pay 2026-06-22] A 'pay_invoice' link CHARGES the invoice total
        // via a PaymentIntent; everything else SAVES a card via a SetupIntent.
        // The intent id is stored in stripe_setup_intent_id either way (a link is
        // only ever one purpose) and re-checked server-side on confirm.
        const amountCents = Math.round(parseFloat(String(link.amount ?? "0")) * 100);
        if (link.purpose === "pay_invoice" && link.invoice_id && amountCents > 0 && !invoiceAlreadyPaid) {
          const paymentIntent = await stripe.paymentIntents.create({
            amount: amountCents,
            currency: "usd",
            customer: stripeCustomerId,
            // Offer every method enabled in the Stripe Dashboard — card/debit,
            // Apple Pay & Google Pay (card wallets), and ACH bank debit
            // (us_bank_account). The Payment Element renders whatever is on.
            automatic_payment_methods: { enabled: true },
            description: invoiceNumber ? `Invoice ${invoiceNumber}` : `Invoice ${link.invoice_id}`,
            // client_id + job_id are what the Stripe webhook reads to mark the
            // invoice paid (esp. for ACH, which confirms asynchronously).
            metadata: {
              payment_link_id: String(link.id), company_id: String(link.company_id),
              invoice_id: String(link.invoice_id), client_id: String(link.client_id),
              ...(invoiceJobId != null ? { job_id: String(invoiceJobId) } : {}),
            },
          });
          clientSecret = paymentIntent.client_secret;
          stripePublishableKey = stripePubKey;
          await db.update(paymentLinksTable)
            .set({ stripe_setup_intent_id: paymentIntent.id })
            .where(eq(paymentLinksTable.id, link.id));
        } else {
          const setupIntent = await stripe.setupIntents.create({
            customer: stripeCustomerId,
            payment_method_types: ["card"],
            metadata: { payment_link_id: String(link.id), company_id: String(link.company_id) },
          });
          clientSecret = setupIntent.client_secret;
          stripePublishableKey = stripePubKey;
          await db.update(paymentLinksTable)
            .set({ stripe_setup_intent_id: setupIntent.id })
            .where(eq(paymentLinksTable.id, link.id));
        }
      } catch (err) {
        console.error("Stripe setup intent error:", err);
      }
    }

    res.json({
      link: { id: link.id, purpose: link.purpose, amount: link.amount, expires_at: link.expires_at },
      company,
      client: client ? { id: client.id, first_name: client.first_name, last_name: client.last_name } : null,
      invoice_number: invoiceNumber,
      invoice_paid: invoiceAlreadyPaid,
      stripe_publishable_key: stripePublishableKey,
      client_secret: clientSecret,
    });
  } catch (err) {
    console.error("Public token lookup error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ─── POST /pay/:token/save-card — PUBLIC: confirm Stripe setup intent ─────────
router.post("/public/:token/save-card", async (req, res) => {
  try {
    const { token } = req.params;
    const { payment_method_id } = req.body;

    const [link] = await db
      .select()
      .from(paymentLinksTable)
      .where(eq(paymentLinksTable.token, token));

    if (!link) return res.status(404).json({ error: "INVALID_LINK" });
    if (link.used_at) return res.status(410).json({ error: "ALREADY_USED" });
    if (link.expires_at < new Date()) return res.status(410).json({ error: "EXPIRED" });

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey || stripeSecretKey === "payments disabled") {
      return res.status(503).json({ error: "Payment processing not configured" });
    }

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-06-20" as any });

    const [clientRow] = await db
      .select({ stripe_customer_id: clientsTable.stripe_customer_id })
      .from(clientsTable)
      .where(eq(clientsTable.id, link.client_id));

    const stripeCustomerId = clientRow?.stripe_customer_id;
    if (!stripeCustomerId) return res.status(400).json({ error: "No Stripe customer" });

    // Attach payment method
    await stripe.paymentMethods.attach(payment_method_id, { customer: stripeCustomerId });
    await stripe.customers.update(stripeCustomerId, {
      invoice_settings: { default_payment_method: payment_method_id },
    });

    // Get card details
    const pm = await stripe.paymentMethods.retrieve(payment_method_id);
    const card = pm.card;

    // Update client record.
    // [card-link-chargeable 2026-07-22] This used to save ONLY the display
    // fields (last4 / brand / expiry). It never stored
    // `stripe_payment_method_id` — the one field that actually makes the card
    // chargeable. `charge-invoice.ts` reads that column to build the
    // off-session PaymentIntent and bails with "No Stripe card on file" when
    // it's null, and `derivePaymentSource()` uses its presence to route the
    // client to Stripe at all. So a customer who saved a card through the
    // card-on-file LINK looked done in the UI ("•••• 6613 Visa") but could
    // never actually be charged, and still derived to Square. The online
    // booking path (routes/public.ts) has always stored both; this brings the
    // link path to parity with it.
    await db.update(clientsTable)
      .set({
        stripe_payment_method_id: payment_method_id,
        payment_source: "stripe",
        card_last_four: card?.last4 ?? null,
        card_brand: card?.brand ?? null,
        card_expiry: card ? `${card.exp_month}/${String(card.exp_year).slice(-2)}` : null,
        card_saved_at: new Date(),
        default_card_last_4: card?.last4 ?? null,
        default_card_brand: card?.brand ?? null,
      })
      .where(eq(clientsTable.id, link.client_id));

    // Mark link as used
    await db.update(paymentLinksTable)
      .set({ used_at: new Date() })
      .where(eq(paymentLinksTable.id, link.id));

    res.json({ success: true });
  } catch (err: any) {
    console.error("Save card error:", err);
    res.status(500).json({ error: err.message || "Failed to save card" });
  }
});

// ─── POST /pay/:token/pay — PUBLIC: confirm an invoice payment ────────────────
// The customer has confirmed the PaymentIntent client-side. We re-check its
// status SERVER-SIDE (never trust the client) and, if it succeeded, mark the
// invoice paid + record the Stripe payment. Idempotent: a second call on an
// already-paid invoice just returns success. NOTE for production hardening: add
// a Stripe `payment_intent.succeeded` webhook so a closed browser after a
// successful charge still marks the invoice paid.
router.post("/public/:token/pay", async (req, res) => {
  try {
    const { token } = req.params;

    const [link] = await db.select().from(paymentLinksTable).where(eq(paymentLinksTable.token, token));
    if (!link) return res.status(404).json({ error: "INVALID_LINK" });
    if (link.purpose !== "pay_invoice" || !link.invoice_id) return res.status(400).json({ error: "NOT_A_PAYMENT_LINK" });
    if (link.expires_at < new Date()) return res.status(410).json({ error: "EXPIRED" });

    const [invoice] = await db
      .select({ id: invoicesTable.id, status: invoicesTable.status, total: invoicesTable.total,
                client_id: invoicesTable.client_id, job_id: invoicesTable.job_id })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.id, link.invoice_id), eq(invoicesTable.company_id, link.company_id)));
    if (!invoice) return res.status(404).json({ error: "INVOICE_NOT_FOUND" });
    if (invoice.status === "paid") return res.json({ success: true, already_paid: true });

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey || stripeSecretKey === "payments disabled") {
      return res.status(503).json({ error: "Payment processing not configured" });
    }
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-06-20" as any });

    // Re-verify the PaymentIntent succeeded — the stored intent id is authoritative.
    if (!link.stripe_setup_intent_id) return res.status(400).json({ error: "NO_INTENT" });
    const pi = await stripe.paymentIntents.retrieve(link.stripe_setup_intent_id);
    if (pi.status !== "succeeded") {
      return res.status(402).json({ error: "PAYMENT_NOT_COMPLETE", stripe_status: pi.status });
    }

    const paidAmount = pi.amount_received != null ? pi.amount_received / 100 : parseFloat(invoice.total || "0");

    // stripe_payment_id lets the async webhook recognize this PaymentIntent was
    // already recorded here (instant path) and skip a duplicate row.
    await db.insert(paymentsTable).values({
      company_id: link.company_id,
      client_id: invoice.client_id,
      invoice_id: invoice.id,
      amount: paidAmount.toFixed(2),
      method: "stripe",
      status: "completed",
      stripe_payment_id: pi.id,
    });

    await db.update(invoicesTable)
      .set({ status: "paid", paid_at: new Date(), payment_source: "stripe", stripe_payment_intent_id: pi.id })
      .where(and(eq(invoicesTable.id, invoice.id), eq(invoicesTable.company_id, link.company_id)));

    if (invoice.job_id) {
      await db.update(jobsTable)
        .set({ charge_succeeded_at: new Date() })
        .where(eq(jobsTable.id, invoice.job_id));
    }

    await db.update(paymentLinksTable).set({ used_at: new Date() }).where(eq(paymentLinksTable.id, link.id));

    await db.insert(notificationLogTable).values({
      company_id: link.company_id, recipient: "system", channel: "system",
      trigger: "payment_collected", status: "sent",
      metadata: { invoice_id: invoice.id, amount: paidAmount, method: "stripe", source: "customer_pay_link" } as any,
    });

    res.json({ success: true, amount: paidAmount });
  } catch (err: any) {
    console.error("Invoice pay error:", err);
    res.status(500).json({ error: err.message || "Failed to record payment" });
  }
});

// ─── Helper: build card link email HTML ───────────────────────────────────────
function buildCardLinkEmail({ clientName, companyName, payUrl, brandColor }: {
  clientName: string;
  companyName: string;
  payUrl: string;
  brandColor: string;
}) {
  const color = brandColor || "#5B9BD5";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: 'Plus Jakarta Sans', Arial, sans-serif; background: #F7F6F3; margin: 0; padding: 0; }
  .container { max-width: 520px; margin: 40px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .header { background: ${color}; padding: 32px 40px; }
  .header h1 { color: #fff; margin: 0; font-size: 22px; font-weight: 600; }
  .body { padding: 36px 40px; color: #1A1917; }
  .body p { font-size: 15px; line-height: 1.6; margin: 0 0 20px; }
  .btn { display: inline-block; background: ${color}; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px; }
  .footer { padding: 24px 40px; color: #9E9B94; font-size: 12px; border-top: 1px solid #E5E2DC; }
</style></head>
<body>
<div class="container">
  <div class="header"><h1>${companyName}</h1></div>
  <div class="body">
    <p>Hi ${clientName},</p>
    <p>Please save a payment method for future invoices from <strong>${companyName}</strong>.</p>
    <p><a class="btn" href="${payUrl}">Save Payment Method</a></p>
    <p style="color:#6B7280;font-size:13px;">This link expires in 72 hours. You will not be charged today.</p>
  </div>
  <div class="footer">
    <p>This email was sent by ${companyName} via Qleno.</p>
    <p>If you did not expect this email, you can safely ignore it.</p>
  </div>
</div>
</body></html>`;
}

export default router;
