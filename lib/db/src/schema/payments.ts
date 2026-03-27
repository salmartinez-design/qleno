import { pgTable, serial, text, integer, timestamp, decimal } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { invoicesTable } from "./invoices";
import { usersTable } from "./users";

export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id).notNull(),
  invoice_id: integer("invoice_id").references(() => invoicesTable.id),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  method: text("method"),
  status: text("status").notNull().default("completed"),
  job_id: integer("job_id"),
  stripe_payment_id: text("stripe_payment_id"),
  stripe_error_code: text("stripe_error_code"),
  stripe_error_message: text("stripe_error_message"),
  last_4: text("last_4"),
  card_brand: text("card_brand"),
  processed_by: integer("processed_by").references(() => usersTable.id),
  attempted_at: timestamp("attempted_at"),
  refunded_at: timestamp("refunded_at"),
  refund_reason: text("refund_reason"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({ id: true, created_at: true });
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type Payment = typeof paymentsTable.$inferSelect;
