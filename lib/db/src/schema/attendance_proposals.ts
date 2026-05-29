/**
 * Cutover 3B — Attendance overlay proposals.
 *
 * The dispatch board's "Attendance" drawer surfaces office-actionable
 * discrepancies between scheduled assignments and actual clock activity:
 *   - late      tech clocked in 20+ minutes past scheduled start
 *   - short     worked minutes are 20+ minutes below estimated_hours
 *   - no_show   the day passed (or the wait window elapsed today) with
 *               no clock-in at all
 *   - missing_clockout
 *               clocked in but never clocked out and either the day is
 *               over or the bracket exceeds 16h
 *
 * A proposal is the OFFICE-EDITABLE staging row. The scanner inserts
 * pending proposals; the office confirms (writes an
 * employee_attendance_log entry + drives the unexcused-hours ladder)
 * or dismisses. Nothing in the proposal table is the source of truth
 * for pay — confirms write to the existing 3A attendance_log + the 1E
 * pay pipeline reads from there.
 *
 * Multi-tenant via company_id on every row + every query. The unique
 * index on (company_id, user_id, job_id, scheduled_date) is the
 * idempotency guarantee — a re-scan of the same window will not
 * insert duplicate proposals (ON CONFLICT DO NOTHING).
 *
 * Status transitions in place: pending → confirmed | dismissed. There
 * is no `superseded` state and no `scan_run_id` — re-scan of an
 * existing pending row is a no-op. Office must dismiss + re-scan to
 * refresh.
 */
import {
  pgTable,
  serial,
  integer,
  numeric,
  text,
  date,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";
import { jobClockEventsTable } from "./job_clock_events";
import { leaveRequestsTable } from "./leave";
import { employeeAttendanceLogTable } from "./hr_logs";

export const attendanceProposalKindEnum = pgEnum("attendance_proposal_kind", [
  "late",
  "short",
  "no_show",
  "missing_clockout",
]);

export const attendanceProposalStatusEnum = pgEnum(
  "attendance_proposal_status",
  ["pending", "confirmed", "dismissed"],
);

export const attendanceProposalsTable = pgTable(
  "attendance_proposals",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    job_id: integer("job_id")
      .notNull()
      .references(() => jobsTable.id),
    /** Snapshot of jobs.scheduled_date at scan time. Rows with NULL
     *  jobs.scheduled_date are SKIPPED entirely — they cannot be
     *  attendance-classified. */
    scheduled_date: date("scheduled_date").notNull(),
    /** Minutes-since-midnight, Chicago wall-clock, parsed from
     *  jobs.scheduled_time at scan time. Stored as int so the
     *  confirm path never re-parses. */
    scheduled_time_minutes: integer("scheduled_time_minutes"),
    estimated_hours: numeric("estimated_hours", { precision: 5, scale: 2 }),
    kind: attendanceProposalKindEnum("kind").notNull(),
    status: attendanceProposalStatusEnum("status").notNull().default("pending"),
    /** Populated when kind='late'. */
    minutes_late: integer("minutes_late"),
    /** Populated when kind='short'. */
    minutes_short: integer("minutes_short"),
    /** Null for no_show. */
    clock_in_event_id: integer("clock_in_event_id").references(
      () => jobClockEventsTable.id,
    ),
    /** Null for missing_clockout, no_show. */
    clock_out_event_id: integer("clock_out_event_id").references(
      () => jobClockEventsTable.id,
    ),
    /** Non-null when an approved leave overlaps the date — surfaced
     *  for office context. Full-day overlaps cause the scanner to
     *  auto-dismiss; partial leaves stay pending with this column
     *  attached as context. */
    leave_request_id: integer("leave_request_id").references(
      () => leaveRequestsTable.id,
    ),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    /** NULL when auto-dismissed by the scanner (full-day approved
     *  leave reconciliation). */
    decided_by_user_id: integer("decided_by_user_id").references(
      () => usersTable.id,
    ),
    decision_note: text("decision_note"),
    /** Populated on confirm — points at the row this proposal
     *  materialized into. */
    created_attendance_log_id: integer("created_attendance_log_id").references(
      () => employeeAttendanceLogTable.id,
    ),
  },
  (t) => ({
    by_status: index("attendance_proposals_company_status_idx").on(
      t.company_id,
      t.status,
      t.scheduled_date,
    ),
    by_user: index("attendance_proposals_company_user_idx").on(
      t.company_id,
      t.user_id,
      t.scheduled_date,
    ),
    by_job: index("attendance_proposals_company_job_idx").on(
      t.company_id,
      t.job_id,
    ),
    uq_per_assignment: uniqueIndex(
      "attendance_proposals_unique_per_assignment_uq",
    ).on(t.company_id, t.user_id, t.job_id, t.scheduled_date),
  }),
);

export type AttendanceProposal = typeof attendanceProposalsTable.$inferSelect;
export type InsertAttendanceProposal =
  typeof attendanceProposalsTable.$inferInsert;
