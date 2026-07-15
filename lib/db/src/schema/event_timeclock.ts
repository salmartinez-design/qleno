import { pgTable, serial, integer, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { dispatchEventsTable } from "./dispatch_events";

// [event-clock 2026-07-15] A tech's clock-in/out on a dispatch EVENT (a non-job
// entry — meeting/training block, client visit, or 1-on-1). Deliberately a
// SEPARATE table from the job `timeclock`: event time is paid HOURLY (a
// considered exception to the commission-only comp model), so it must never
// leak into the job/commission/efficiency queries that read `timeclock`.
//
// Pay flows AUTOMATICALLY on clock-out (Sal's call): clock-out computes
// hours × rate and writes a `pay_adjustments` row (adjustment_type='event_pay'),
// which folds into /payroll/detail for the period by created_at. pay_adjustment_id
// links the punch to the money so it's traceable and can be voided if reopened.
export const eventTimeclockTable = pgTable(
  "event_timeclock",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id").notNull().references(() => companiesTable.id),
    dispatch_event_id: integer("dispatch_event_id").notNull().references(() => dispatchEventsTable.id),
    user_id: integer("user_id").notNull().references(() => usersTable.id),
    clock_in_at: timestamp("clock_in_at", { withTimezone: true }).notNull().defaultNow(),
    clock_out_at: timestamp("clock_out_at", { withTimezone: true }),
    // Snapshotted at clock-out so the paid figure is auditable even if the rate
    // table changes later.
    paid_hours: numeric("paid_hours", { precision: 6, scale: 2 }),
    paid_rate: numeric("paid_rate", { precision: 10, scale: 2 }),
    pay_adjustment_id: integer("pay_adjustment_id"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    by_event_user: index("event_timeclock_event_user_idx").on(t.dispatch_event_id, t.user_id),
    by_company_user: index("event_timeclock_company_user_idx").on(t.company_id, t.user_id),
  }),
);

export type EventTimeclock = typeof eventTimeclockTable.$inferSelect;
export type InsertEventTimeclock = typeof eventTimeclockTable.$inferInsert;
