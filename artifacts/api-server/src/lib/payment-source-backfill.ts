// [invoicing-engine 2026-06-16] One-time, idempotent backfill of
// clients.payment_source using Sal's derivation rule:
//   stripe_payment_method_id present → 'stripe'
//   otherwise                        → 'square'   (the recurring Square base)
//
// Only touches rows where payment_source IS NULL, so it is safe to run on every
// cold start and never clobbers an office-set value (incl. check/ach). Two
// guarded Drizzle UPDATEs (no raw sql write tags, per the codebase constraint).
// Runs in startup() — applies at deploy/boot only, never in CI.
import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { and, isNull, isNotNull } from "drizzle-orm";

export async function ensurePaymentSourceBackfill(): Promise<void> {
  // 1. Clients with a Stripe card on file → stripe.
  const stripeRes = await db
    .update(clientsTable)
    .set({ payment_source: "stripe" })
    .where(and(isNull(clientsTable.payment_source), isNotNull(clientsTable.stripe_payment_method_id)))
    .returning({ id: clientsTable.id });

  // 2. Everyone else still unset → square (the recurring base).
  const squareRes = await db
    .update(clientsTable)
    .set({ payment_source: "square" })
    .where(and(isNull(clientsTable.payment_source), isNull(clientsTable.stripe_payment_method_id)))
    .returning({ id: clientsTable.id });

  const stripeN = stripeRes.length;
  const squareN = squareRes.length;
  if (stripeN || squareN) {
    console.log(`[payment-source-backfill] set payment_source: ${stripeN} stripe, ${squareN} square`);
  }
}
