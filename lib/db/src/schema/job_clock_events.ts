/**
 * Cutover 1C — Job clock events with GPS integrity (the legal backbone).
 *
 * Every clock event written here is a wage record. The CHECK constraint
 * (enforced at the DB level by runCutoverClockIntegrityConstraint() in
 * artifacts/api-server/src/cutover-data-migration.ts) guarantees that
 * a row CANNOT exist with neither a captured GPS fix nor a flagged
 * failed_exception with a reason. There is no third state. The route
 * layer enforces the same rule before the row hits the DB; the
 * constraint is defense-in-depth.
 *
 * This is greenfield. The legacy `timeclock` table stays in place for
 * backwards compatibility and the existing /api/timeclock surface;
 * 1C and everything downstream write to job_clock_events.
 */
import { pgTable, serial, integer, text, timestamp, boolean, numeric, jsonb, pgEnum, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { jobsTable } from "./jobs";
import { usersTable } from "./users";

export const clockEventTypeEnum = pgEnum("clock_event_type", [
  "clock_in",
  "clock_out",
]);

export const clockGpsStatusEnum = pgEnum("clock_gps_status", [
  "captured",
  "failed_exception",
]);

export const jobClockEventsTable = pgTable(
  "job_clock_events",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id").notNull().references(() => companiesTable.id),
    job_id: integer("job_id").notNull().references(() => jobsTable.id),
    user_id: integer("user_id").notNull().references(() => usersTable.id),
    event_type: clockEventTypeEnum("event_type").notNull(),
    event_at: timestamp("event_at", { withTimezone: true }).notNull().defaultNow(),
    // GPS payload — populated when gps_status='captured'. Left NULL when
    // 'failed_exception'. The CHECK constraint forbids the mixed state.
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    gps_accuracy_meters: numeric("gps_accuracy_meters", { precision: 6, scale: 1 }),
    distance_from_site_meters: numeric("distance_from_site_meters", { precision: 8, scale: 1 }),
    within_geofence: boolean("within_geofence"),
    gps_status: clockGpsStatusEnum("gps_status").notNull(),
    // Exception fields — populated when gps_status='failed_exception'.
    // exception_reason is REQUIRED in that state (CHECK constraint).
    // exception_photo_url is required by the route handler but not the
    // DB constraint (photo upload could complete after-the-fact on
    // intermittent connections; the office review queue flags any row
    // missing it).
    exception_reason: text("exception_reason"),
    exception_photo_url: text("exception_photo_url"),
    exception_reviewed_by_user_id: integer("exception_reviewed_by_user_id").references(() => usersTable.id),
    exception_reviewed_at: timestamp("exception_reviewed_at", { withTimezone: true }),
    // Correction trail — never overwrite or delete an original event.
    // A correction INSERTs a new row with is_correction=true pointing
    // at the original via correction_of_event_id, snapshotting prior
    // values in correction_old_value.
    is_correction: boolean("is_correction").notNull().default(false),
    correction_of_event_id: integer("correction_of_event_id"),
    correction_old_value: jsonb("correction_old_value"),
    created_by_user_id: integer("created_by_user_id").notNull().references(() => usersTable.id),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    by_job: index("job_clock_events_company_job_idx").on(t.company_id, t.job_id),
    by_user: index("job_clock_events_company_user_event_at_idx").on(
      t.company_id,
      t.user_id,
      t.event_at,
    ),
  }),
);

export type JobClockEvent = typeof jobClockEventsTable.$inferSelect;
export type InsertJobClockEvent = typeof jobClockEventsTable.$inferInsert;

/**
 * Constant name for the CHECK constraint — referenced by the runtime
 * migration that installs it and by the tests that assert it exists.
 * Keeping the name in one place protects against drift on rename.
 */
export const JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_NAME =
  "job_clock_events_gps_integrity_chk";

/**
 * The exact SQL of the integrity CHECK. Either the GPS fix is captured
 * (lat + lng populated) OR it failed with a reason. No third state.
 * Exported so the runtime migration uses the same text as the tests.
 */
export const JOB_CLOCK_EVENTS_INTEGRITY_CONSTRAINT_SQL = `(
  (gps_status = 'captured' AND latitude IS NOT NULL AND longitude IS NOT NULL)
  OR
  (gps_status = 'failed_exception' AND exception_reason IS NOT NULL)
)`;
