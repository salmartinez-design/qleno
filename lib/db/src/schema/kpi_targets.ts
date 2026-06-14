import { pgTable, serial, integer, text, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// Owner-set KPI targets for the lead reporting layer (actual-vs-target).
// One row per (company, metric). metric ∈ leads | booked | lead_to_book |
// close_rate | contact_rate | booked_revenue | pipeline_value.
export const kpiTargetsTable = pgTable("kpi_targets", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  metric: text("metric").notNull(),
  target_value: numeric("target_value", { precision: 14, scale: 2 }).notNull().default("0"),
  period: text("period").notNull().default("monthly"),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uq: uniqueIndex("uq_kpi_targets_company_metric").on(t.company_id, t.metric),
}));

export const insertKpiTargetSchema = createInsertSchema(kpiTargetsTable).omit({ id: true, updated_at: true });
export type InsertKpiTarget = z.infer<typeof insertKpiTargetSchema>;
export type KpiTarget = typeof kpiTargetsTable.$inferSelect;
