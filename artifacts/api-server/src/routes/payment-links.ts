import { Router } from "express";
import { db } from "@workspace/db";
import {
  paymentLinksTable, clientsTable, companiesTable, invoicesTable, notificationLogTable
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import crypto from "crypto";

const router = Router();

// ─── Helper: get app base URL ─────────────────────────────────────────────────
function getAppBaseUrl(): string {
  return process.env.APP_URL || process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:5173";
}

// ─── POST /payment-links — create & optionally send ───────────────────────────
router.post("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const { client_id, purpose = "save_card", invoice_id, amount, send_email, send_sms } = req.body;

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

    const baseUrl = getAppBaseUrl();
    const payUrl = `${baseUrl}/pay/${token}`;

    const clientName = `${client.first_name} ${client.last_name}`;
    const companyName = company.name;

    // Send email via Resend if requested
    if (send_email) {
      const toEmail = client.billing_contact_email || client.email;
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
            from: `${companyName} <noreply@cleanopspro.com>`,
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
        } catch (err) {
          console.error("Email send failed:", err);
        }
      }
    }

    // Send SMS via Twilio if requested
    if (send_sms) {
      const toPhone = client.billing_contact_phone || client.phone;
      const twilioSid = process.env.TWILIO_ACCOUNT_SID;
      const twilioToken = process.env.TWILIO_AUTH_TOKEN;
      const twilioFrom = company.twilio_from_number || process.env.TWILIO_FROM_NUMBER;
      if (!twilioSid || !twilioToken || !twilioFrom || !toPhone) {
        console.warn("Twilio not configured or no phone — skipping SMS");
      } else {
        try {
          const twilio = (await import("twilio")).default;
          const client2 = twilio(twilioSid, twilioToken);
          await client2.messages.create({
            from: twilioFrom,
            to: toPhone,
            body: `${companyName}: Please save your payment method for future invoices. Link expires in 72 hours: ${payUrl}`,
          });
          await db.insert(notificationLogTable).values({
            company_id: companyId,
            trigger: "payment_link_sms",
            channel: "sms",
            recipient: toPhone,
            status: "sent",
          }).catch(() => {});
        } catch (err) {
          console.error("SMS send failed:", err);
        }
      }
    }

    res.json({ id: link.id, token, url: payUrl, expires_at: expiresAt });
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
    if (link.invoice_id) {
      const [inv] = await db
        .select({ invoice_number: invoicesTable.invoice_number })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, link.invoice_id));
      invoiceNumber = inv?.invoice_number ?? null;
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
      } catch (err) {
        console.error("Stripe setup intent error:", err);
      }
    }

    res.json({
      link: { id: link.id, purpose: link.purpose, amount: link.amount, expires_at: link.expires_at },
      company,
      client: client ? { id: client.id, first_name: client.first_name, last_name: client.last_name } : null,
      invoice_number: invoiceNumber,
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

    // Update client record
    await db.update(clientsTable)
      .set({
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
