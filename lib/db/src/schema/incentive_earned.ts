import { pgTable, serial, integer, text, numeric, date, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { incentiveProgramsTable } from "./incentive_programs";

export const incentiveEarnedStatusEnum = pgEnum("incentive_earned_status", [
  "pending_approval", "approved", "rejected", "paid",
]);

export const incentiveEarnedTable = pgTable("incentive_earned", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  employee_id: integer("employee_id").references(() => usersTable.id).notNull(),
  program_id: integer("program_id").references(() => incentiveProgramsTable.id).notNull(),
  earned_date: date("earned_date").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  notes: text("notes"),
  status: incentiveEarnedStatusEnum("status").notNull().default("approved"),
  approved_by: integer("approved_by").references(() => usersTable.id),
  approved_at: timestamp("approved_at"),
  rejection_note: text("rejection_note"),
  awarded_by: integer("awarded_by").references(() => usersTable.id),
  paid_date: date("paid_date"),
  paid_via_payroll_run_id: integer("paid_via_payroll_run_id"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type IncentiveEarned = typeof incentiveEarnedTable.$inferSelect;
