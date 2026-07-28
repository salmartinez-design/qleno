import { pgTable, serial, integer, numeric, boolean, timestamp } from "drizzle-orm/pg-core";
import { recurringSchedulesTable } from "./recurring_schedules";

export const recurringScheduleAddOnsTable = pgTable("recurring_schedule_add_ons", {
  id: serial("id").primaryKey(),
  recurring_schedule_id: integer("recurring_schedule_id")
    .references(() => recurringSchedulesTable.id, { onDelete: "cascade" })
    .notNull(),
  pricing_addon_id: integer("pricing_addon_id").notNull(),
  qty: numeric("qty", { precision: 6, scale: 2 }).notNull().default("1"),
  // [addon-recurrence 2026-07-28] true = perform + stamp this add-on on EVERY
  // generated visit; false = FIRST visit only (the schedule's start-date job).
  // Mirrors the parking-fee-per-occurrence pattern. The recurring engine reads
  // this when stamping job_add_ons on each child job.
  every_visit: boolean("every_visit").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type RecurringScheduleAddOn = typeof recurringScheduleAddOnsTable.$inferSelect;
