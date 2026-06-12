import { pgTable, serial, integer, numeric, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Per-employee, per-service-type efficiency % (Allowed ÷ Actual; >100% = under
// budget = good). Mirrors MaidCentral's authoritative figures, stored as-is.
// One row per (employee, service_type, period). 0%/blank rows are NOT stored —
// they mean "no jobs of that type in the window," not real 0% efficiency, so
// the import filters them and the UI naturally omits absent service types.
export const employeeEfficiencyTable = pgTable("employee_efficiency", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  employee_id: integer("employee_id").references(() => usersTable.id).notNull(),
  service_type: text("service_type").notNull(), // MC label, verbatim
  efficiency_pct: numeric("efficiency_pct", { precision: 6, scale: 2 }).notNull(),
  source: text("source").notNull().default("mc"), // 'mc' | 'qleno'
  period: text("period").notNull().default("all_time"),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("uq_employee_efficiency").on(t.company_id, t.employee_id, t.service_type, t.period),
]);

export const insertEmployeeEfficiencySchema = createInsertSchema(employeeEfficiencyTable).omit({ id: true, updated_at: true });
export type InsertEmployeeEfficiency = z.infer<typeof insertEmployeeEfficiencySchema>;
export type EmployeeEfficiency = typeof employeeEfficiencyTable.$inferSelect;
