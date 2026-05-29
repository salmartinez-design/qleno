/**
 * Cutover 1C — Per-job worksheet payload.
 *
 * Holds the worksheet-specific fields that don't belong on jobs itself
 * (directions, entry photo, bedroom/bath counts captured at booking,
 * next-job date for follow-on planning). Other 1A fields (scope flags,
 * service type) already live on jobs and are mirrored here only when
 * the office wants to override the worksheet display without altering
 * the job record itself.
 *
 * One row per job. Created lazily on first GET /worksheet when a job
 * doesn't have one yet (the GET seeds defaults from jobs+clients).
 */
import { pgTable, serial, integer, text, timestamp, boolean, date, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { jobsTable } from "./jobs";

export const jobWorksheetTable = pgTable(
  "job_worksheet",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id").notNull().references(() => companiesTable.id),
    job_id: integer("job_id").notNull().references(() => jobsTable.id).unique(),
    service_set_name: text("service_set_name"),
    scope_deep_clean: boolean("scope_deep_clean").notNull().default(false),
    scope_first_time_in: boolean("scope_first_time_in").notNull().default(false),
    scope_priority: boolean("scope_priority").notNull().default(false),
    special_equipment_needed: boolean("special_equipment_needed").notNull().default(false),
    directions_text: text("directions_text"),
    entry_photo_url: text("entry_photo_url"),
    bedrooms: integer("bedrooms"),
    full_baths: integer("full_baths"),
    half_baths: integer("half_baths"),
    next_job_date: date("next_job_date"),
    billing_terms: text("billing_terms"),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    by_job: index("job_worksheet_company_job_idx").on(t.company_id, t.job_id),
  }),
);

export type JobWorksheet = typeof jobWorksheetTable.$inferSelect;
export type InsertJobWorksheet = typeof jobWorksheetTable.$inferInsert;
