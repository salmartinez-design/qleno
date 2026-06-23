import { Router, Request, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

// POST /api/stripe/webhook
// Stripe calls this with raw body — signature is verified using STRIPE_WEBHOOK_SECRET.
// IMPORTANT: This route must be mounted with express.raw() before express.json() in app.ts.
router.post(
  "/",
  async (req: Request, res: Response) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const stripeKey = process.env.STRIPE_SECRET_KEY;

    if (!stripeKey) {
      console.warn("[stripe-webhook] STRIPE_SECRET_KEY not configured — ignoring event");
      return res.json({ received: true });
    }

    let event: any;

    if (webhookSecret) {
      const sig = req.headers["stripe-signature"];
      if (!sig) {
        console.error("[stripe-webhook] Missing stripe-signature header");
        return res.status(400).json({ error: "Missing stripe-signature" });
      }

      try {
        const Stripe = (await import("stripe")).default;
        const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" as any });
        // req.body is a raw Buffer when mounted with express.raw()
        event = stripe.webhooks.constructEvent(
          req.body as Buffer,
          sig as string,
          webhookSecret
        );
      } catch (err: any) {
        console.error("[stripe-webhook] Signature verification failed:", err.message);
        return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
      }
    } else {
      // Webhook secret not configured — parse body as JSON fallback (dev only)
      console.warn("[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — skipping signature check");
      try {
        event = JSON.parse((req.body as Buffer).toString("utf8"));
      } catch {
        return res.status(400).json({ error: "Invalid JSON body" });
      }
    }

    console.log(`[stripe-webhook] Event received: ${event.type} id=${event.id}`);

    try {
      switch (event.type) {
        // ── Payment Intent succeeded ─────────────────────────────────────────
        case "payment_intent.succeeded": {
          const pi = event.data.object;
          const companyId = pi.metadata?.company_id ? parseInt(pi.metadata.company_id) : null;
          const clientId  = pi.metadata?.client_id  ? parseInt(pi.metadata.client_id)  : null;
          const invoiceId = pi.metadata?.invoice_id ? parseInt(pi.metadata.invoice_id) : null;
          const jobId     = pi.metadata?.job_id     ? parseInt(pi.metadata.job_id)     : null;
          const amount    = (pi.amount_received / 100).toFixed(2);
          // ACH bank debit vs card/wallet — label the payment row accordingly.
          const isAch     = Array.isArray(pi.payment_method_types) && pi.payment_method_types.includes("us_bank_account");
          const method    = isAch ? "ach" : "card";

          if (companyId && clientId) {
            // Idempotent insert — the instant /pay path may have already recorded
            // this PaymentIntent (no UNIQUE index on stripe_payment_id, so guard
            // with NOT EXISTS rather than ON CONFLICT).
            await db.execute(sql`
              INSERT INTO payments (company_id, client_id, invoice_id, amount, method, status, stripe_payment_id, created_at)
              SELECT ${companyId}, ${clientId}, ${invoiceId}, ${amount}, ${method}, 'completed', ${pi.id}, NOW()
              WHERE NOT EXISTS (SELECT 1 FROM payments WHERE stripe_payment_id = ${pi.id})
            `);

            // Mark invoice paid (preserve an earlier paid_at from the instant path).
            if (invoiceId) {
              await db.execute(sql`
                UPDATE invoices
                SET status='paid', paid_at=COALESCE(paid_at, NOW()),
                    payment_source='stripe', stripe_payment_intent_id=${pi.id}
                WHERE id=${invoiceId} AND company_id=${companyId}
              `);
              await db.execute(sql`
                UPDATE jobs SET charge_succeeded_at=COALESCE(charge_succeeded_at, NOW())
                WHERE company_id=${companyId}
                  AND id=(SELECT job_id FROM invoices WHERE id=${invoiceId})
              `).catch(() => {});
            }

            // Log notification
            await db.execute(sql`
              INSERT INTO notification_log (company_id, client_id, job_id, event_type, message, created_at)
              VALUES (
                ${companyId}, ${clientId}, ${jobId},
                'payment_intent.succeeded',
                ${`Stripe payment ${pi.id} — $${amount} received`},
                NOW()
              )
              ON CONFLICT DO NOTHING
            `).catch(() => {});
          }
          break;
        }

        // ── Payment Intent failed ────────────────────────────────────────────
        case "payment_intent.payment_failed": {
          const pi = event.data.object;
          const companyId = pi.metadata?.company_id ? parseInt(pi.metadata.company_id) : null;
          const clientId  = pi.metadata?.client_id  ? parseInt(pi.metadata.client_id)  : null;
          const jobId     = pi.metadata?.job_id     ? parseInt(pi.metadata.job_id)     : null;
          const errorMsg  = pi.last_payment_error?.message ?? "Payment failed";

          if (companyId && clientId) {
            await db.execute(sql`
              INSERT INTO notification_log (company_id, client_id, job_id, event_type, message, created_at)
              VALUES (
                ${companyId}, ${clientId}, ${jobId},
                'payment_intent.payment_failed',
                ${`Stripe payment failed: ${errorMsg}. Intent: ${pi.id}`},
                NOW()
              )
              ON CONFLICT DO NOTHING
            `).catch(() => {});
          }
          break;
        }

        // ── Charge refunded ──────────────────────────────────────────────────
        case "charge.refunded": {
          const charge = event.data.object;
          const piId = charge.payment_intent;
          if (piId) {
            await db.execute(sql`
              UPDATE payments
              SET status='refunded', refunded_at=NOW()
              WHERE stripe_payment_id=${piId}
            `).catch(() => {});
          }
          break;
        }

        // ── Checkout session completed (booking widget) ──────────────────────
        case "checkout.session.completed": {
          const session = event.data.object;
          const companyId = session.metadata?.company_id ? parseInt(session.metadata.company_id) : null;
          const clientId  = session.metadata?.client_id  ? parseInt(session.metadata.client_id)  : null;
          const jobId     = session.metadata?.job_id     ? parseInt(session.metadata.job_id)     : null;
          const amount    = session.amount_total ? (session.amount_total / 100).toFixed(2) : "0.00";

          if (companyId) {
            await db.execute(sql`
              INSERT INTO notification_log (company_id, client_id, job_id, event_type, message, created_at)
              VALUES (
                ${companyId}, ${clientId}, ${jobId},
                'checkout.session.completed',
                ${`Stripe checkout completed — session ${session.id} — $${amount}`},
                NOW()
              )
              ON CONFLICT DO NOTHING
            `).catch(() => {});
          }
          break;
        }

        // ── Subscription events (SaaS billing) ──────────────────────────────
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const customerId = sub.customer;
          const newStatus = event.type === "customer.subscription.deleted" ? "canceled" : sub.status;

          await db.execute(sql`
            UPDATE companies
            SET subscription_status=${newStatus}, updated_at=NOW()
            WHERE stripe_customer_id=${customerId}
          `).catch(() => {});
          break;
        }

        default:
          console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
      }
    } catch (handlerErr) {
      console.error(`[stripe-webhook] Error handling ${event.type}:`, handlerErr);
    }

    return res.json({ received: true });
  }
);

export default router;
