import { pgTable, serial, text, integer, timestamp, numeric, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { accountsTable } from "./accounts";
import { invoicesTable } from "./invoices";
import { paymentsTable } from "./payments";

// [square-webhook 2026-07-22] Every Square payment Qleno has been told about,
// and what was done with it. Step 2 of the Square integration — step 1 was
// square_customer_map, which answers "whose payment is this?".
//
// READ-ONLY BY DESIGN. Qleno never charges a card and never pushes any of this
// to QuickBooks. Money moved in Square; this table only records that Qleno
// noticed, and reconciles it against an open invoice.
//
// WHY A LEDGER AND NOT JUST "MARK THE INVOICE PAID":
//   - A webhook can fire more than once for the same payment (Square retries on
//     any non-2xx, and payment.updated fires again on every status change).
//     Unique (company_id, square_payment_id) makes replay a no-op instead of a
//     double-credit.
//   - Most payments will match cleanly; the ones that don't are the whole point.
//     An unmapped customer, an amount that matches nothing, or an amount that
//     matches THREE open invoices must be visible and resolvable by the office,
//     not silently guessed at. resolution + review_reason carry that.
//   - It is the audit trail: when Tim asks why invoice 7094 says paid, the row
//     names the Square payment id, the amount, and the rule that matched it.
//
// A payment that arrives before its invoice exists is NOT an error — it lands
// as needs_review and can be re-run once the invoice is issued.
export const squarePaymentEventsTable = pgTable("square_payment_events", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),

  // --- the Square side (the event, as received) ---
  square_payment_id: text("square_payment_id").notNull(),
  square_customer_id: text("square_customer_id"),
  square_order_id: text("square_order_id"),
  square_location_id: text("square_location_id"),
  event_type: text("event_type"),
  // Square's own payment status: COMPLETED / APPROVED / PENDING / FAILED /
  // CANCELED. Only COMPLETED is ever reconciled.
  square_status: text("square_status"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  card_brand: text("card_brand"),
  card_last4: text("card_last4"),
  square_created_at: timestamp("square_created_at"),

  // --- what Qleno resolved it to ---
  // applied       — matched exactly one open invoice; invoice marked paid
  // needs_review  — ambiguous, unmatched, or the customer isn't confidently
  //                 mapped. NOTHING was written to an invoice.
  // ignored       — office dismissed it (a payment that isn't Qleno AR at all)
  // skipped       — not a reconcilable event (non-COMPLETED status, $0, refund)
  resolution: text("resolution").notNull().default("needs_review"),
  // unmapped_customer | customer_needs_review | no_open_invoice |
  // no_amount_match | ambiguous_amount | already_paid | not_completed
  review_reason: text("review_reason"),
  resolved_client_id: integer("resolved_client_id").references(() => clientsTable.id),
  resolved_account_id: integer("resolved_account_id").references(() => accountsTable.id),
  matched_invoice_id: integer("matched_invoice_id").references(() => invoicesTable.id),
  // The payments row written when resolution='applied' — the bridge back to
  // Qleno's own AR, so an applied event can be traced (and undone) precisely.
  applied_payment_id: integer("applied_payment_id").references(() => paymentsTable.id),
  // Every open invoice considered, when the match was ambiguous or empty. This
  // is what the office review screen offers as one-click choices.
  candidate_invoice_ids: jsonb("candidate_invoice_ids"),
  // The raw webhook payload, kept so a mis-parse can be replayed without asking
  // Square for the event again.
  raw: jsonb("raw"),

  created_at: timestamp("created_at").notNull().defaultNow(),
  processed_at: timestamp("processed_at"),
  reviewed_at: timestamp("reviewed_at"),
  reviewed_by_user_id: integer("reviewed_by_user_id"),
}, (t) => ({
  // Idempotency: one row per Square payment per tenant. The webhook upserts on
  // this, so Square's retries can never double-apply a payment.
  uqPayment: uniqueIndex("uq_square_payment_company_payment").on(t.company_id, t.square_payment_id),
  idxCustomer: index("idx_square_payment_customer").on(t.square_customer_id),
  idxResolution: index("idx_square_payment_resolution").on(t.company_id, t.resolution),
  idxInvoice: index("idx_square_payment_invoice").on(t.matched_invoice_id),
}));

export const insertSquarePaymentEventSchema = createInsertSchema(squarePaymentEventsTable).omit({ id: true, created_at: true });
export type InsertSquarePaymentEvent = z.infer<typeof insertSquarePaymentEventSchema>;
export type SquarePaymentEvent = typeof squarePaymentEventsTable.$inferSelect;
