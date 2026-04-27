import { pgTable, serial, integer, text, boolean, date, time, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const recurringFrequencyEnum = pgEnum("recurring_frequency", [
  "weekly", "biweekly", "monthly", "custom",
]);

export const recurringDayEnum = pgEnum("recurring_day", [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

export const recurringSchedulesTable = pgTable("recurring_schedules", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  customer_id: integer("customer_id").references(() => clientsTable.id).notNull(),
  frequency: recurringFrequencyEnum("frequency").notNull(),
  day_of_week: recurringDayEnum("day_of_week"),
  start_date: date("start_date").notNull(),
  end_date: date("end_date"),
  assigned_employee_id: integer("assigned_employee_id").references(() => usersTable.id),
  service_type: text("service_type"),
  duration_minutes: integer("duration_minutes"),
  base_fee: text("base_fee"),
  notes: text("notes"),
  is_active: boolean("is_active").notNull().default(true),
  last_generated_date: date("last_generated_date"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  // [AG] Cascade-from-edit fields. Stay null on existing schedules until
  // the user picks "this and all future" in the edit modal.
  scheduled_time: time("scheduled_time"),
  instructions: text("instructions"),
  manual_rate_override: boolean("manual_rate_override").notNull().default(false),
  // Used when jobs.frequency='every_3_weeks' (no matching enum value on
  // recurring_schedules.frequency, which only has weekly/biweekly/monthly/custom).
  custom_frequency_weeks: integer("custom_frequency_weeks"),
});

export type RecurringSchedule = typeof recurringSchedulesTable.$inferSelect;
