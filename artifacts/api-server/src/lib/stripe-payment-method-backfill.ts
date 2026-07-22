// [card-link-chargeable 2026-07-22] Backfill clients.stripe_payment_method_id
// from Stripe.
//
// The card-on-file LINK handler used to store only the DISPLAY fields
// (card_last_four / card_brand / card_expiry) and never
// `stripe_payment_method_id`. That column is what makes a card chargeable:
// `charge-invoice.ts` and `POST /payments/charge-card` build the off-session
// PaymentIntent from it, and `derivePaymentSource()` routes a client to Stripe
// only when it is populated. So affected clients LOOK like they have a card on
// file but cannot be charged.
//
// Stripe itself has the right data — the card-link handler always attached the
// payment method to the customer and set it as
// invoice_settings.default_payment_method. This recovers the id from Stripe
// rather than asking those customers to re-enter their card.
//
// Safe to run on every cold start:
//   - only touches rows where stripe_customer_id IS NOT NULL
//     AND stripe_payment_method_id IS NULL  (never clobbers a good value)
//   - read-only against Stripe (retrieve + list). It never creates or charges.
//   - no-ops entirely when STRIPE_SECRET_KEY is absent (CI, local).
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function ensureStripePaymentMethodBackfill(): Promise<void> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret || secret === "payments disabled") return;

  const rows = (await db.execute(sql`
    SELECT id, company_id, stripe_customer_id
      FROM clients
     WHERE stripe_customer_id IS NOT NULL
       AND stripe_customer_id <> ''
       AND stripe_payment_method_id IS NULL
     LIMIT 500
  `)).rows as any[];

  if (!rows.length) return;

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(secret, { apiVersion: "2024-06-20" as any });

  let fixed = 0, noCard = 0, failed = 0;

  for (const r of rows) {
    try {
      // Prefer the customer's default payment method — that is exactly what the
      // card-link handler set. Fall back to their most recent saved card.
      const customer: any = await stripe.customers.retrieve(r.stripe_customer_id);
      let pmId: string | null =
        (customer && !customer.deleted && customer.invoice_settings?.default_payment_method) || null;
      if (pmId && typeof pmId !== "string") pmId = (pmId as any).id ?? null;

      if (!pmId) {
        const list = await stripe.paymentMethods.list({ customer: r.stripe_customer_id, type: "card", limit: 1 });
        pmId = list.data[0]?.id ?? null;
      }

      if (!pmId) { noCard++; continue; }

      const pm = await stripe.paymentMethods.retrieve(pmId);
      const card = pm.card;

      // Fill the display fields too when they are missing, so the profile and
      // the charge path agree about what is on file.
      await db.execute(sql`
        UPDATE clients SET
          stripe_payment_method_id = ${pmId},
          payment_source = COALESCE(payment_source, 'stripe'),
          card_last_four = COALESCE(card_last_four, ${card?.last4 ?? null}),
          card_brand     = COALESCE(card_brand,     ${card?.brand ?? null}),
          card_expiry    = COALESCE(card_expiry,    ${card ? `${card.exp_month}/${String(card.exp_year).slice(-2)}` : null})
        WHERE id = ${r.id} AND stripe_payment_method_id IS NULL
      `);
      fixed++;
    } catch (err: any) {
      // A deleted/foreign customer id is expected noise (e.g. a key rotation).
      // Skip it — never let one bad row abort the boot sequence.
      failed++;
      console.warn(`[stripe-pm-backfill] client ${r.id}: ${err?.message ?? err}`);
    }
  }

  console.log(`[stripe-pm-backfill] scanned ${rows.length}: ${fixed} fixed, ${noCard} no card in Stripe, ${failed} errored`);
}
