import { pgTable, serial, integer, timestamp, numeric, boolean, text, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { jobsTable } from "./jobs";
import { usersTable } from "./users";

export const timeclockTable = pgTable("timeclock", {
  id: serial("id").primaryKey(),
  job_id: integer("job_id").references(() => jobsTable.id).notNull(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  clock_in_at: timestamp("clock_in_at").notNull().defaultNow(),
  clock_out_at: timestamp("clock_out_at"),
  clock_in_lat: numeric("clock_in_lat", { precision: 10, scale: 7 }),
  clock_in_lng: numeric("clock_in_lng", { precision: 10, scale: 7 }),
  clock_out_lat: numeric("clock_out_lat", { precision: 10, scale: 7 }),
  clock_out_lng: numeric("clock_out_lng", { precision: 10, scale: 7 }),
  distance_from_job_ft: numeric("distance_from_job_ft", { precision: 10, scale: 2 }),
  clock_in_distance_ft: numeric("clock_in_distance_ft", { precision: 10, scale: 2 }),
  clock_out_distance_ft: numeric("clock_out_distance_ft", { precision: 10, scale: 2 }),
  clock_in_outside_geofence: boolean("clock_in_outside_geofence").notNull().default(false),
  clock_out_outside_geofence: boolean("clock_out_outside_geofence").notNull().default(false),
  clock_in_location_accuracy: numeric("clock_in_location_accuracy", { precision: 8, scale: 2 }),
  override_approved: boolean("override_approved").notNull().default(false),
  override_by: integer("override_by").references(() => usersTable.id),
  flagged: boolean("flagged").notNull().default(false),
});

export const clockInAttemptResultEnum = pgEnum("clock_in_attempt_result", [
  "success", "blocked", "soft_warned", "override_approved", "override_denied"
]);

export const clockInAttemptsTable = pgTable("clock_in_attempts", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  job_id: integer("job_id").references(() => jobsTable.id).notNull(),
  attempted_at: timestamp("attempted_at").notNull().defaultNow(),
  employee_lat: numeric("employee_lat", { precision: 10, scale: 7 }),
  employee_lng: numeric("employee_lng", { precision: 10, scale: 7 }),
  job_lat: numeric("job_lat", { precision: 10, scale: 7 }),
  job_lng: numeric("job_lng", { precision: 10, scale: 7 }),
  distance_ft: numeric("distance_ft", { precision: 10, scale: 2 }),
  radius_ft: integer("radius_ft"),
  result: clockInAttemptResultEnum("result").notNull(),
  override_by: integer("override_by").references(() => usersTable.id),
  notes: text("notes"),
});

export const insertTimeclockSchema = createInsertSchema(timeclockTable).omit({ id: true });
export type InsertTimeclock = z.infer<typeof insertTimeclockSchema>;
export type TimeclockEntry = typeof timeclockTable.$inferSelect;

export const insertClockInAttemptSchema = createInsertSchema(clockInAttemptsTable).omit({ id: true });
export type InsertClockInAttempt = z.infer<typeof insertClockInAttemptSchema>;
export type ClockInAttempt = typeof clockInAttemptsTable.$inferSelect;
