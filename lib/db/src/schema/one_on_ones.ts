import { pgTable, serial, integer, text, timestamp, date, numeric, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { dispatchEventsTable } from "./dispatch_events";

// [one-on-ones 2026-07-14] Quarterly 1-on-1 check-ins between the owner and an
// employee. The owner walks the tech's scorecard, talks work + personal +
// culture, and captures ideas — an honest conversation so every person gets
// face time and feels heard.
//
// PRIVACY — OWNER ONLY. These records hold personal-life and honest culture
// feedback. They are visible ONLY to role 'owner' (NOT admin/office — Maribel
// and Pancho cannot see them, including their own). Every /api/one-on-ones
// route gates to owner, and no SMS/email ever fires. See routes/one-on-ones.ts.
//
// The board block (dispatch_events, kind='one_on_one') is a SEPARATE, non-secret
// row so the office can schedule around the time — it carries who + when but
// none of the content below. dispatch_event_id links the two.
export const oneOnOnesTable = pgTable("one_on_ones", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  employee_id: integer("employee_id").references(() => usersTable.id).notNull(),
  manager_id: integer("manager_id").references(() => usersTable.id), // who conducts (the owner)
  period_label: text("period_label").notNull(), // e.g. "2026-Q3"
  event_date: date("event_date").notNull(),
  dispatch_event_id: integer("dispatch_event_id").references(() => dispatchEventsTable.id),
  // Scorecard captured at creation so the record reflects the quarter's number
  // even if the rolling score later moves. Re-pullable on demand.
  scorecard_pct: numeric("scorecard_pct"),
  scorecard_snapshot: jsonb("scorecard_snapshot"), // full /scorecards/report payload
  // Snapshot of the question set used, so historical records render faithfully
  // even after the standard questions change. Array of { id, section, label, hint? }.
  questions: jsonb("questions"),
  responses: jsonb("responses"), // { [questionId]: string }
  notes: text("notes"), // owner's private freeform notes / action items
  status: text("status").notNull().default("scheduled"), // scheduled | completed
  created_by_user_id: integer("created_by_user_id").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
  completed_at: timestamp("completed_at"),
});

export const insertOneOnOneSchema = createInsertSchema(oneOnOnesTable).omit({ id: true, created_at: true });
export type InsertOneOnOne = z.infer<typeof insertOneOnOneSchema>;
export type OneOnOne = typeof oneOnOnesTable.$inferSelect;
