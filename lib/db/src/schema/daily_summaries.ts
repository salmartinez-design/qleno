import { pgTable, serial, integer, date, numeric, timestamp, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const dailySummariesTable = pgTable("daily_summaries", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  summary_date: date("summary_date").notNull(),
  jobs_complete: integer("jobs_complete").default(0),
  jobs_flagged: integer("jobs_flagged").default(0),
  invoices_created: integer("invoices_created").default(0),
  invoices_sent: integer("invoices_sent").default(0),
  revenue_collected: numeric("revenue_collected", { precision: 12, scale: 2 }).default("0"),
  revenue_outstanding: numeric("revenue_outstanding", { precision: 12, scale: 2 }).default("0"),
  clock_entries_missing: integer("clock_entries_missing").default(0),
  marked_complete_by: integer("marked_complete_by").references(() => usersTable.id),
  marked_complete_at: timestamp("marked_complete_at"),
  notes: text("notes"),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  companyDateUnique: uniqueIndex("daily_summaries_company_date_idx").on(t.company_id, t.summary_date),
}));

export const insertDailySummarySchema = createInsertSchema(dailySummariesTable).omit({ id: true, created_at: true });
export type InsertDailySummary = z.infer<typeof insertDailySummarySchema>;
export type DailySummary = typeof dailySummariesTable.$inferSelect;
