/**
 * Cutover 1C — On-my-way event log.
 *
 * Captures the one-tap "I'm on my way" action with a pre-solved ETA.
 * Critically, the row also captures `from_job_id` + from coordinates
 * so the mileage piece (2A) gets the client-to-client leg for free —
 * no separate "log a mileage leg" surface required from the tech.
 *
 * `eta_edited_after_scheduled_start` is the late signal: when the
 * tech adjusts the ETA such that promised_arrival_at lands AFTER the
 * job's scheduled_start_time, the row flags it. The attendance /
 * discipline piece (later) decides what to do with that signal; 1C
 * just captures it.
 *
 * `deferred=true` records the "wait to send" choice and sends nothing.
 */
import { pgTable, serial, integer, text, timestamp, boolean, numeric, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { jobsTable } from "./jobs";
import { usersTable } from "./users";

export const onMyWayEventsTable = pgTable(
  "on_my_way_events",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id").notNull().references(() => companiesTable.id),
    job_id: integer("job_id").notNull().references(() => jobsTable.id),
    user_id: integer("user_id").notNull().references(() => usersTable.id),
    // The job the tech is LEAVING (for ETA + mileage leg in 2A). NULL
    // when this is the first job of the day (home-to-first-job is not
    // a reimbursable leg per the handbook).
    from_job_id: integer("from_job_id").references(() => jobsTable.id),
    from_latitude: numeric("from_latitude", { precision: 9, scale: 6 }),
    from_longitude: numeric("from_longitude", { precision: 9, scale: 6 }),
    estimated_eta_minutes: integer("estimated_eta_minutes"),
    promised_arrival_at: timestamp("promised_arrival_at", { withTimezone: true }),
    eta_adjusted_by_tech: boolean("eta_adjusted_by_tech").notNull().default(false),
    eta_edited_after_scheduled_start: boolean("eta_edited_after_scheduled_start").notNull().default(false),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    client_notified: boolean("client_notified").notNull().default(false),
    deferred: boolean("deferred").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    by_job: index("on_my_way_events_company_job_idx").on(t.company_id, t.job_id),
    by_user: index("on_my_way_events_company_user_created_at_idx").on(
      t.company_id,
      t.user_id,
      t.created_at,
    ),
  }),
);

export type OnMyWayEvent = typeof onMyWayEventsTable.$inferSelect;
export type InsertOnMyWayEvent = typeof onMyWayEventsTable.$inferInsert;
