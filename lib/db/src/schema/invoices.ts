import { pgTable, serial, text, integer, timestamp, numeric, jsonb, pgEnum, date, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { jobsTable } from "./jobs";
import { usersTable } from "./users";
import { branchesTable } from "./branches";

// [invoicing-engine 2026-06-16] `void` and `superseded` appended for the
// invoicing engine: `void` backs the Void action, `superseded` is the status of
// batch per-visit children that have been folded (zeroed) into a month's parent
// invoice. Appended at the END so existing ordinals are untouched — the enum
// values are added to the live DB via pre-push-fix.ts (ALTER TYPE ADD VALUE
// IF NOT EXISTS) BEFORE drizzle-kit push runs, so push sees no enum diff.
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft", "sent", "paid", "overdue", "void", "superseded"
]);

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id),
  account_id: integer("account_id"),
  job_id: integer("job_id").references(() => jobsTable.id),
  invoice_number: text("invoice_number"),
  status: invoiceStatusEnum("status").notNull().default("draft"),
  line_items: jsonb("line_items").notNull().default([]),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull().default("0"),
  tips: numeric("tips", { precision: 10, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 10, scale: 2 }).notNull().default("0"),
  due_date: date("due_date"),
  // [invoice-service-date 2026-07-03] Manual service-date override. When NULL the
  // API derives the service date from the linked job (job_id) or, for consolidated
  // invoices, the earliest line-item job date. Set when the office edits "Service
  // Date" on the invoice (Maribel). Added to the live DB via an idempotent
  // ADD COLUMN IF NOT EXISTS in runStartupMigrations, before the API gate opens.
  service_date: date("service_date"),
  // [invoice-bill-to 2026-07-03] Manual "Bill to" name override on the invoice
  // document. When NULL the invoice bills to the client/account name; when set
  // (e.g. the specific HOA the account manages — "Krys always asks to put the
  // name of the HOA there") the document + PDF show this instead. Added to the
  // live DB via idempotent ADD COLUMN IF NOT EXISTS in runStartupMigrations.
  bill_to_name: text("bill_to_name"),
  sent_at: timestamp("sent_at"),
  last_reminder_sent_at: timestamp("last_reminder_sent_at"),
  payment_failed: boolean("payment_failed").default(false),
  created_by: integer("created_by").references(() => usersTable.id),
  qbo_invoice_id: text("qbo_invoice_id"),
  stripe_payment_intent_id: text("stripe_payment_intent_id"),
  square_payment_id: text("square_payment_id"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  paid_at: timestamp("paid_at"),
  po_number: text("po_number"),
  payment_terms: text("payment_terms").default("due_on_receipt"),
  billing_contact_name: text("billing_contact_name"),
  billing_contact_email: text("billing_contact_email"),
  branch_id: integer("branch_id").references(() => branchesTable.id),
  // [invoicing-engine 2026-06-16] Processor stamped on the invoice at creation,
  // copied from clients.payment_source ('stripe' | 'square' | 'check' | 'ach').
  // Drives the office Charge action's routing so a later change to the client's
  // default source never re-routes an already-issued invoice. Null falls back to
  // the client's current payment_source at charge time.
  payment_source: text("payment_source"),
  // [invoicing-engine 2026-06-16] Batch ("first invoice of the month") workflow.
  // Per-visit invoices for batch_invoice clients are created with
  // batch_status='pending' (draft, not sent, not charged) so the month-end
  // roll-up can find them. Cleared/!= 'pending' once consolidated. Null for
  // per_visit clients (their invoices are never part of a batch).
  batch_status: text("batch_status"),
  // [invoicing-engine 2026-06-16] On a folded child invoice, points at the
  // month's parent (consolidated) invoice. The child is zeroed and set to
  // status='superseded'; the parent carries the full month total. Null on
  // per-visit invoices and on the parent itself. Plain integer (no FK) to match
  // the self-reference style used elsewhere (e.g. account_id) and avoid a
  // circular Drizzle self-ref.
  parent_invoice_id: integer("parent_invoice_id"),
  // [refunds 2026-06-27] Partial or full refund issued against a paid invoice.
  // refunded_amount tracks how much was returned (≤ total); null means no refund.
  // Status stays 'paid' — money moved both directions; the net is total−refunded_amount.
  // For Stripe invoices the refund is initiated via the Stripe API before this is set.
  // For manual payments the refund is recorded here only (money returned offline).
  refunded_amount: numeric("refunded_amount", { precision: 10, scale: 2 }),
  refund_reason: text("refund_reason"),
  refunded_at: timestamp("refunded_at"),
});

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({ id: true, created_at: true });
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
