import { pgTable, serial, text, integer, timestamp, numeric, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";

export const billingMethodEnum = pgEnum("billing_method", [
  "hourly", "flat_rate", "per_unit",
]);

export const accountRateCardsTable = pgTable("account_rate_cards", {
  id: serial("id").primaryKey(),
  account_id: integer("account_id").references(() => accountsTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  service_type: text("service_type").notNull(),
  billing_method: billingMethodEnum("billing_method").notNull().default("hourly"),
  rate_amount: numeric("rate_amount", { precision: 10, scale: 2 }).notNull(),
  unit_label: text("unit_label").notNull().default("hr"),
  notes: text("notes"),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertAccountRateCardSchema = createInsertSchema(accountRateCardsTable).omit({ id: true, created_at: true });
export type InsertAccountRateCard = z.infer<typeof insertAccountRateCardSchema>;
export type AccountRateCard = typeof accountRateCardsTable.$inferSelect;
