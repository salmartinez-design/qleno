import { pgTable, serial, integer, text, date, timestamp, jsonb } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const routeSequencesTable = pgTable("route_sequences", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  employee_id: integer("employee_id").references(() => usersTable.id).notNull(),
  date: date("date").notNull(),
  sequence: jsonb("sequence"),
  total_drive_time_min: integer("total_drive_time_min"),
  total_job_time_min: integer("total_job_time_min"),
  notes: text("notes"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type RouteSequence = typeof routeSequencesTable.$inferSelect;
