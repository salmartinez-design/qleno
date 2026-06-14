import { pgTable, serial, integer, text, numeric, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// Per-tenant marketing spend by channel + period. Feeds CPL / CPA / ROI in the
// lead reporting layer. `source` mirrors leads.source channel keys.
export const marketingSpendTable = pgTable("marketing_spend", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  source: text("source").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  period_start: date("period_start").notNull(),
  period_end: date("period_end").notNull(),
  notes: text("notes"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertMarketingSpendSchema = createInsertSchema(marketingSpendTable).omit({ id: true, created_at: true });
export type InsertMarketingSpend = z.infer<typeof insertMarketingSpendSchema>;
export type MarketingSpend = typeof marketingSpendTable.$inferSelect;
