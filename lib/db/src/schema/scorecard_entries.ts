import { pgTable, serial, integer, numeric, text, date, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";

// Per-job scorecard history backing the MaidCentral-style percentage model.
// The rolled-up per-employee % lives on users.scorecard_pct (stored as MC's
// authoritative value — NOT recomputed from these rows, since MC's % is not a
// simple average). These rows are the underlying history (781 imported from MC
// + any Qleno-generated entries going forward) for drill-down / audit.
export const scorecardEntriesTable = pgTable("scorecard_entries", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  employee_id: integer("employee_id").references(() => usersTable.id).notNull(),
  // Nullable: historical MC rows may not map to a Qleno job.
  job_id: integer("job_id").references(() => jobsTable.id),
  entry_date: date("entry_date").notNull(),
  // The raw per-job score and its scale (e.g. 95 / 100, or 4 / 4). Kept as
  // captured so we can re-derive later if MC's rollup formula is provided.
  score_value: numeric("score_value", { precision: 8, scale: 2 }).notNull(),
  max_value: numeric("max_value", { precision: 8, scale: 2 }).notNull().default("100"),
  source: text("source").notNull().default("mc"), // 'mc' | 'qleno'
  // Office "Exclude from employee" action (MC parity) — excluded responses
  // (e.g. 0-scores / churn flags) drop out of the tech's mean.
  excluded: boolean("excluded").notNull().default(false),
  // Links a qleno entry back to its customer survey response.
  survey_id: integer("survey_id"),
  notes: text("notes"),
  // [GAP3] Office/owner reply to the customer's feedback on this entry. Shown
  // on the employee profile Scorecards tab next to the customer comment.
  office_reply: text("office_reply"),
  office_reply_by_user_id: integer("office_reply_by_user_id").references(() => usersTable.id),
  office_reply_at: timestamp("office_reply_at"),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("idx_scorecard_entries_emp").on(t.company_id, t.employee_id),
]);

export const insertScorecardEntrySchema = createInsertSchema(scorecardEntriesTable).omit({ id: true, created_at: true });
export type InsertScorecardEntry = z.infer<typeof insertScorecardEntrySchema>;
export type ScorecardEntry = typeof scorecardEntriesTable.$inferSelect;
