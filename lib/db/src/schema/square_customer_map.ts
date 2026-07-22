import { pgTable, serial, text, integer, timestamp, boolean, numeric, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { accountsTable } from "./accounts";
import { accountPropertiesTable } from "./account_properties";

// [square-map 2026-07-22] Square ↔ Qleno customer map. Step 1 of connecting
// Square payments back to Qleno invoices — the payment webhook reads this table
// to answer "which Qleno record does this Square customer_id belong to?".
//
// WHY A TABLE AND NOT JUST clients.square_customer_id:
//   - Square keeps ONE customer record PER PROPERTY for property-management
//     accounts (Cucci has 4 Square records, all chris@cuccirealty1.com, one per
//     building). A single column on clients cannot express
//     many-Square-records → one-Qleno-account, nor which property each covers.
//   - Matching is not always confident. Duplicates, shared/placeholder emails
//     (admin@phes.io is on 6 Square records) and name-only matches must land in
//     a review queue instead of being silently auto-linked. status carries that.
//   - The map is the audit trail: match_method + match_score + review_reason
//     record WHY a link exists, so a wrong link is explainable and reversible.
//
// clients.square_customer_id / accounts.square_customer_id stay the fast path
// that charge-invoice.ts already reads; the sync MIRRORS confident links onto
// them but NEVER overwrites a non-null value it didn't set.
//
// Idempotent by construction: unique (company_id, square_customer_id) + upsert,
// so the sync can be re-run safely on every cold start or on demand.
export const squareCustomerMapTable = pgTable("square_customer_map", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),

  // --- the Square side (snapshot of the remote record, refreshed each sync) ---
  square_customer_id: text("square_customer_id").notNull(),
  square_customer_name: text("square_customer_name"),
  square_email: text("square_email"),
  square_company_name: text("square_company_name"),
  square_phone: text("square_phone"),
  square_address: text("square_address"),
  square_postal: text("square_postal"),
  square_created_at: timestamp("square_created_at"),

  // --- the Qleno side. At most one of client_id / account_id is the billing
  // entity; account_property_id refines WHICH building an account-level Square
  // record covers (the Cucci per-property pattern). ---
  client_id: integer("client_id").references(() => clientsTable.id),
  account_id: integer("account_id").references(() => accountsTable.id),
  account_property_id: integer("account_property_id").references(() => accountPropertiesTable.id),

  // --- card on file. card_id is what a future charge would use as sourceId;
  // stored so the webhook/reconciler can recognise the instrument without a
  // second Square round-trip. Storing the id is NOT authorisation to charge. ---
  square_card_id: text("square_card_id"),
  card_brand: text("card_brand"),
  card_last4: text("card_last4"),
  card_exp: text("card_exp"),
  card_count: integer("card_count").notNull().default(0),

  // --- lifecycle ---
  // linked        — confident match, safe for the reconciler to use
  // needs_review  — ambiguous / duplicate / fuzzy; office must confirm
  // unmatched     — no Qleno counterpart found at all
  // ignored       — office dismissed it (test records, closed customers)
  status: text("status").notNull().default("needs_review"),
  // existing_link | email | name | address | property_address | manual
  match_method: text("match_method"),
  match_score: numeric("match_score", { precision: 5, scale: 2 }),
  review_reason: text("review_reason"),
  // Square's email disagrees with Qleno's for an otherwise-confident link.
  // Not blocking (usually a typo on one side) but surfaced for cleanup.
  email_mismatch: boolean("email_mismatch").notNull().default(false),
  // For accounts with several Square records: which one is the account's
  // default billing record. Never auto-set when ambiguous — office confirms.
  is_account_primary: boolean("is_account_primary").notNull().default(false),

  linked_at: timestamp("linked_at"),
  linked_by_user_id: integer("linked_by_user_id"),
  reviewed_at: timestamp("reviewed_at"),
  reviewed_by_user_id: integer("reviewed_by_user_id"),

  first_seen_at: timestamp("first_seen_at").notNull().defaultNow(),
  last_synced_at: timestamp("last_synced_at").notNull().defaultNow(),
  // Candidate alternatives considered by the matcher, kept so a reviewer can
  // see what else it could have been without re-running the match.
  candidates: jsonb("candidates"),
}, (t) => ({
  // The idempotency key — one map row per Square customer per tenant.
  uq: uniqueIndex("uq_square_map_company_customer").on(t.company_id, t.square_customer_id),
  // The webhook lookup path: payment arrives with a Square customer_id.
  bySquare: index("idx_square_map_square_customer").on(t.square_customer_id),
  byClient: index("idx_square_map_client").on(t.client_id),
  byAccount: index("idx_square_map_account").on(t.account_id),
  byStatus: index("idx_square_map_status").on(t.company_id, t.status),
}));

export const insertSquareCustomerMapSchema = createInsertSchema(squareCustomerMapTable).omit({ id: true, first_seen_at: true });
export type InsertSquareCustomerMap = z.infer<typeof insertSquareCustomerMapSchema>;
export type SquareCustomerMap = typeof squareCustomerMapTable.$inferSelect;
