import { pgTable, serial, text, integer, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const accountTypeEnum = pgEnum("account_type", [
  "property_management", "commercial_office", "retail", "other",
]);

export const invoiceFrequencyEnum = pgEnum("invoice_frequency", [
  "per_job", "weekly", "monthly", "custom",
]);

export const accountPaymentMethodEnum = pgEnum("account_payment_method", [
  "card_on_file", "check", "ach", "invoice_only",
]);

export const accountsTable = pgTable("accounts", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  account_name: text("account_name").notNull(),
  billing_contact_id: integer("billing_contact_id"),
  payment_method: accountPaymentMethodEnum("payment_method").notNull().default("card_on_file"),
  auto_charge_on_completion: boolean("auto_charge_on_completion").notNull().default(true),
  invoice_frequency: invoiceFrequencyEnum("invoice_frequency").notNull().default("per_job"),
  payment_terms_days: integer("payment_terms_days").notNull().default(0),
  account_type: accountTypeEnum("account_type").notNull().default("property_management"),
  stripe_customer_id: text("stripe_customer_id"),
  square_customer_id: text("square_customer_id"),
  notes: text("notes"),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAccountSchema = createInsertSchema(accountsTable).omit({ id: true, created_at: true, updated_at: true });
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
