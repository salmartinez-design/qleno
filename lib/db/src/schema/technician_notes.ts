/**
 * Cutover 1C — Technician's own notes attached to a job.
 *
 * Distinct from the existing `employee_notes` table (HR-side notes
 * about the employee). technician_notes is the tech's own working
 * notes about the job — color of damage, where the cat is hiding,
 * which closet has the spare vacuum bags. The office can read them;
 * the tech is the author.
 */
import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { jobsTable } from "./jobs";
import { usersTable } from "./users";

export const technicianNotesTable = pgTable(
  "technician_notes",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id").notNull().references(() => companiesTable.id),
    job_id: integer("job_id").notNull().references(() => jobsTable.id),
    user_id: integer("user_id").notNull().references(() => usersTable.id),
    body: text("body").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    by_job: index("technician_notes_company_job_idx").on(t.company_id, t.job_id),
  }),
);

export type TechnicianNote = typeof technicianNotesTable.$inferSelect;
export type InsertTechnicianNote = typeof technicianNotesTable.$inferInsert;
