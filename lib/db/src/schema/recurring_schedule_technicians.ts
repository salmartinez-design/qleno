import { pgTable, serial, integer, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { recurringSchedulesTable } from "./recurring_schedules";
import { usersTable } from "./users";

export const recurringScheduleTechniciansTable = pgTable("recurring_schedule_technicians", {
  id: serial("id").primaryKey(),
  recurring_schedule_id: integer("recurring_schedule_id")
    .references(() => recurringSchedulesTable.id, { onDelete: "cascade" })
    .notNull(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  is_primary: boolean("is_primary").notNull().default(false),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique().on(t.recurring_schedule_id, t.user_id)]);

export type RecurringScheduleTechnician = typeof recurringScheduleTechniciansTable.$inferSelect;
