import { pgTable, serial, text, integer, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";

export const accountContactRoleEnum = pgEnum("account_contact_role", [
  "billing", "operations", "onsite", "accountant", "property_manager", "other",
]);

export const accountContactsTable = pgTable("account_contacts", {
  id: serial("id").primaryKey(),
  account_id: integer("account_id").references(() => accountsTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  role: accountContactRoleEnum("role").notNull().default("operations"),
  email: text("email"),
  phone: text("phone"),
  receives_invoices: boolean("receives_invoices").notNull().default(false),
  receives_receipts: boolean("receives_receipts").notNull().default(false),
  receives_on_way_sms: boolean("receives_on_way_sms").notNull().default(false),
  receives_completion_notifications: boolean("receives_completion_notifications").notNull().default(false),
  is_primary: boolean("is_primary").notNull().default(false),
  notes: text("notes"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertAccountContactSchema = createInsertSchema(accountContactsTable).omit({ id: true, created_at: true });
export type InsertAccountContact = z.infer<typeof insertAccountContactSchema>;
export type AccountContact = typeof accountContactsTable.$inferSelect;
