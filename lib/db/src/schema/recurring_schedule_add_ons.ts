import { pgTable, serial, integer, numeric, timestamp } from "drizzle-orm/pg-core";
import { recurringSchedulesTable } from "./recurring_schedules";

export const recurringScheduleAddOnsTable = pgTable("recurring_schedule_add_ons", {
  id: serial("id").primaryKey(),
  recurring_schedule_id: integer("recurring_schedule_id")
    .references(() => recurringSchedulesTable.id, { onDelete: "cascade" })
    .notNull(),
  pricing_addon_id: integer("pricing_addon_id").notNull(),
  qty: numeric("qty", { precision: 6, scale: 2 }).notNull().default("1"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type RecurringScheduleAddOn = typeof recurringScheduleAddOnsTable.$inferSelect;
