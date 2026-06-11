import { pgTable, serial, integer, timestamp, text, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { jobsTable } from "./jobs";
import { usersTable } from "./users";

// [job-discounts 2026-06-11] A discount APPLIED to a specific job. Distinct from
// the pricing_discounts catalog (the reusable codes) — this records each actual
// application so the office can track + report every discount given. A job can
// have more than one. `code` is the catalog code when picked from the catalog,
// null for a one-off custom discount. `type`/`value` mirror the catalog's
// 'percent' | 'flat' shape; `amount` is the dollars actually taken off THIS job
// at apply time (snapshot, so the report is stable even if the price changes).
export const jobDiscountsTable = pgTable("job_discounts", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  job_id: integer("job_id").references(() => jobsTable.id).notNull(),
  code: text("code"),
  type: text("type").notNull(), // 'percent' | 'flat'
  value: numeric("value", { precision: 10, scale: 2 }).notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  reason: text("reason"),
  applied_by: integer("applied_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertJobDiscountSchema = createInsertSchema(jobDiscountsTable).omit({ id: true, created_at: true });
export type InsertJobDiscount = z.infer<typeof insertJobDiscountSchema>;
export type JobDiscount = typeof jobDiscountsTable.$inferSelect;
