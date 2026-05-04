import { pgTable, serial, integer, text, boolean, date, time, numeric, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const recurringFrequencyEnum = pgEnum("recurring_frequency", [
  "weekly", "biweekly", "monthly", "custom",
  // [AI] every_3_weeks closes AG bug (was falling back to 'custom' and
  // walking 14-day intervals via the biweekly path).
  "every_3_weeks",
  // [AI] Multi-day commercial scheduling (2026-04-27)
  "daily", "weekdays", "custom_days",
  // [PR #58] Semi-monthly cadence — anchors on specific days_of_month
  // (typically [1, 15] or [15, 30]). Engine snaps forward to next
  // business day when an anchor falls on a weekend.
  "semi_monthly",
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
  // [AH] Cascade target for commercial hourly rate. When the user picks
  // "this and all future" on a commercial recurring job, this column gets
  // the rate so the engine can re-derive base_fee for spawned jobs.
  commercial_hourly_rate: numeric("commercial_hourly_rate", { precision: 10, scale: 2 }),
  // [AI] Multi-day weekday pattern for daily/weekdays/custom_days. Array of
  // integers 0–6 (0=Sunday). Mutually exclusive with day_of_week:
  //   weekly/biweekly/every_3_weeks/monthly → day_of_week (string enum)
  //   daily/weekdays/custom_days            → days_of_week (int array)
  // PATCH endpoint enforces exclusivity; engine warns and prefers
  // days_of_week if both end up populated.
  days_of_week: integer("days_of_week").array(),
  // [PR #58] Anchor days for monthly + semi_monthly cadences. Stored as an
  // INTEGER[] of day-of-month values (1..31 plus a sentinel 0 for "last day
  // of month" — engine resolves 0 to the actual last day per month).
  // monthly: a single-element array (e.g., [15]). semi_monthly: two-element
  // (e.g., [1, 15] or [15, 30]). NULL for non-anchored frequencies.
  days_of_month: integer("days_of_month").array(),
  // [AI.6] Parking fee per-occurrence config. When parking_fee_enabled,
  // engine stamps a job_add_ons row (parking) on each generated job whose
  // weekday matches parking_fee_days (NULL = apply to all). Amount falls
  // back to the tenant's Parking Fee pricing_addons entry when null.
  // Weekday convention: 0=Sun..6=Sat, matching days_of_week.
  parking_fee_enabled: boolean("parking_fee_enabled").notNull().default(false),
  parking_fee_amount: numeric("parking_fee_amount", { precision: 10, scale: 2 }),
  parking_fee_days: integer("parking_fee_days").array(),
});

export type RecurringSchedule = typeof recurringSchedulesTable.$inferSelect;
