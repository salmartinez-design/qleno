// [invoicing-engine 2026-06-16] Payment-source derivation — Sal's rule.
//
// Most recurring/existing Phes clients have a card on file in SQUARE and stay on
// Square. New ONLINE bookings use STRIPE (SetupIntent card on file). Phone/office
// bookings most likely stay on Square. The clean, deterministic derivation:
//
//   stripe_payment_method_id present  → 'stripe'
//   otherwise                         → 'square'   (the recurring base)
//
// check/ach are explicit office settings on clients.payment_source and are NEVER
// derived here — they are only honored when already stored. This function is the
// null-fallback at charge time AND the basis for the one-time clients.payment_source
// backfill. Going forward, payment_source is also set explicitly at booking
// (online → stripe), but that wiring lives in the booking flow (out of scope here,
// per the quote-tool constraint).

export type PaymentSource = "stripe" | "square" | "check" | "ach";

// Derive the processor from card-on-file state. Returns 'stripe' iff a Stripe
// payment method is stored, else 'square'.
export function derivePaymentSource(input: { stripe_payment_method_id?: string | null }): PaymentSource {
  return input.stripe_payment_method_id ? "stripe" : "square";
}

// Resolve the effective payment source for an already-issued invoice: prefer the
// value stamped on the invoice at creation; if null (older rows / not stamped),
// fall back to deriving from the client's current card-on-file state. An explicit
// check/ach stamp is preserved as-is.
export function resolveInvoicePaymentSource(
  invoicePaymentSource: string | null | undefined,
  client: { stripe_payment_method_id?: string | null },
): PaymentSource {
  const stamped = (invoicePaymentSource || "").toLowerCase();
  if (stamped === "stripe" || stamped === "square" || stamped === "check" || stamped === "ach") {
    return stamped as PaymentSource;
  }
  return derivePaymentSource(client);
}
