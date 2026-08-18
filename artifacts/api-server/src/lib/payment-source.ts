// [invoicing-engine 2026-06-16] Payment-source derivation — Sal's rule.
//
// Phes clients have their card on file in SQUARE — recurring, phone/office, and
// (since [square-booking 2026-08-18]) online bookings from the public widget too.
// Stripe is no longer used to capture a card anywhere; the only clients still on
// it are historical online bookings taken before that switch, which keep working
// because their stripe_payment_method_id is still stored. The clean,
// deterministic derivation:
//
//   stripe_payment_method_id present  → 'stripe'
//   otherwise                         → 'square'   (the recurring base)
//
// check/ach are explicit office settings on clients.payment_source and are NEVER
// derived here — they are only honored when already stored. This function is the
// null-fallback at charge time AND the basis for the one-time clients.payment_source
// backfill. payment_source is also stamped explicitly at booking; saveSquareCardOnFile
// writes 'square' and clears stripe_payment_method_id, so a client who re-books
// online migrates off Stripe on their next card save.

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
