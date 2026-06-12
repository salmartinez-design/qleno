import { pgTable, serial, integer, numeric, text, date, timestamp, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";

// Per-(job, tech) efficiency audit row — the drill-down behind the rolled-up
// employee_efficiency aggregate. Captured on job completion (source='qleno').
// efficiency for a job/tech = allowed_share ÷ actual_hours × 100, where
// allowed_share = job.allowed_hours × (this tech's clocked share). The rollup
// (employee_efficiency) is hours-weighted: 100 × Σallowed_share ÷ Σactual_hours
// over the employee's entries for a package. One row per (job, employee).
export const efficiencyEntriesTable = pgTable("efficiency_entries", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  employee_id: integer("employee_id").references(() => usersTable.id).notNull(),
  job_id: integer("job_id").references(() => jobsTable.id).notNull(),
  package: text("package").notNull(), // resolved Qleno package name
  allowed_share: numeric("allowed_share", { precision: 8, scale: 3 }).notNull(),
  actual_hours: numeric("actual_hours", { precision: 8, scale: 3 }).notNull(),
  ratio: numeric("ratio", { precision: 6, scale: 2 }).notNull(), // efficiency %
  source: text("source").notNull().default("qleno"),
  entry_date: date("entry_date").notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  unique("uq_efficiency_entries_job_emp").on(t.job_id, t.employee_id),
  index("idx_efficiency_entries_emp_pkg").on(t.company_id, t.employee_id, t.package),
]);

export const insertEfficiencyEntrySchema = createInsertSchema(efficiencyEntriesTable).omit({ id: true, created_at: true });
export type InsertEfficiencyEntry = z.infer<typeof insertEfficiencyEntrySchema>;
export type EfficiencyEntry = typeof efficiencyEntriesTable.$inferSelect;
