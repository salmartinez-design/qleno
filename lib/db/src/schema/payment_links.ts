import { pgTable, serial, text, integer, timestamp, numeric, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const paymentLinkPurposeEnum = pgEnum("payment_link_purpose", ["save_card", "pay_invoice"]);

export const paymentLinksTable = pgTable("payment_links", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id).notNull(),
  token: text("token").notNull().unique(),
  purpose: paymentLinkPurposeEnum("purpose").notNull().default("save_card"),
  invoice_id: integer("invoice_id"),
  amount: numeric("amount", { precision: 10, scale: 2 }),
  stripe_setup_intent_id: text("stripe_setup_intent_id"),
  expires_at: timestamp("expires_at").notNull(),
  used_at: timestamp("used_at"),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertPaymentLinkSchema = createInsertSchema(paymentLinksTable).omit({ id: true, created_at: true });
export type InsertPaymentLink = z.infer<typeof insertPaymentLinkSchema>;
export type PaymentLink = typeof paymentLinksTable.$inferSelect;
