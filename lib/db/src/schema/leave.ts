/**
 * Cutover 3A — Availability + leave catalog + requests + blackouts.
 *
 * Tenant-configurable leave system. PLAWA is ONE configuration of the
 * generic catalog; nothing about PLAWA's rules is baked in. The same
 * tables serve any state's leave law via per-tenant rows.
 *
 * Tables:
 *   employee_availability   Weekly recurring grid per employee (day +
 *                           time block per row). Structured, not text.
 *
 *   leave_types             Per-tenant catalog. Each row is a "bucket"
 *                           the office and employee see by name (PLAWA,
 *                           PTO, Sick, Unpaid Leave, Unexcused). All
 *                           rule numbers — accrual mode, cap, waiting
 *                           period, carryover, requestable, blackout
 *                           exemption — live on the row.
 *
 *   employee_leave_balances One row per (employee, leave_type). Tracks
 *                           granted/accrued, used, available. Reset
 *                           job touches this row; ceiling lives on the
 *                           policy, not here.
 *
 *   leave_requests          Lifecycle: pending → approved | denied |
 *                           cancelled. Approval decrements the
 *                           balance + writes an employee_leave_usage
 *                           row (existing 1E table). Cancellation of
 *                           an approved request restores the balance.
 *
 *   leave_blackouts         Tenant-defined date ranges that auto-deny
 *                           non-exempt requests. Per-bucket exemption
 *                           lives on leave_types.exempt_from_blackout,
 *                           never hardcoded.
 *
 * All money/hours numeric not float. Multi-tenant via company_id on
 * every table.
 */
import {
  pgTable,
  serial,
  integer,
  boolean,
  text,
  numeric,
  date,
  time,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// employee_availability — weekly recurring grid
// ─────────────────────────────────────────────────────────────────────────────
//
// One row per (employee, day_of_week, start_time). day_of_week uses
// the same convention as recurring_schedules (0=Sunday..6=Saturday).
// Multiple rows per day are allowed for split-availability.

export const employeeAvailabilityTable = pgTable(
  "employee_availability",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    day_of_week: integer("day_of_week").notNull(), // 0..6
    start_time: time("start_time").notNull(), // HH:MM
    end_time: time("end_time").notNull(), // HH:MM
    available: boolean("available").notNull().default(true),
    note: text("note"),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    by_user: index("employee_availability_company_user_idx").on(
      t.company_id,
      t.user_id,
    ),
  }),
);

export type EmployeeAvailability =
  typeof employeeAvailabilityTable.$inferSelect;
export type InsertEmployeeAvailability =
  typeof employeeAvailabilityTable.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// leave_types — tenant-configurable catalog
// ─────────────────────────────────────────────────────────────────────────────
//
// accrual_mode:
//   flat_grant       — annual_cap_hours granted at eligibility + each reset
//   accrue_per_hours — accrue (accrual_rate) hours per hour worked
//   office_recorded  — bucket decrements as office records entries; no
//                      grant flow (e.g. Unexcused — counts down from cap)

export const leaveAccrualModeEnum = pgEnum("leave_accrual_mode", [
  "flat_grant",
  "accrue_per_hours",
  "office_recorded",
]);

export const leaveTypesTable = pgTable(
  "leave_types",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    /** Stable internal slug (e.g. "plawa", "pto"). Not displayed. */
    slug: text("slug").notNull(),
    /** Office-editable name shown in UI. */
    display_name: text("display_name").notNull(),
    is_paid: boolean("is_paid").notNull().default(true),
    annual_cap_hours: numeric("annual_cap_hours", { precision: 8, scale: 2 })
      .notNull()
      .default("0"),
    accrual_mode: leaveAccrualModeEnum("accrual_mode")
      .notNull()
      .default("flat_grant"),
    /** Only meaningful when accrual_mode='accrue_per_hours'. */
    accrual_rate: numeric("accrual_rate", { precision: 8, scale: 4 })
      .notNull()
      .default("0"),
    waiting_period_days: integer("waiting_period_days").notNull().default(0),
    carryover_allowed: boolean("carryover_allowed").notNull().default(false),
    documentation_required: boolean("documentation_required")
      .notNull()
      .default(false),
    requestable: boolean("requestable").notNull().default(true),
    exempt_from_blackout: boolean("exempt_from_blackout")
      .notNull()
      .default(false),
    active: boolean("active").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    by_company: index("leave_types_company_idx").on(t.company_id, t.active),
    uq_slug: uniqueIndex("leave_types_company_slug_uq").on(t.company_id, t.slug),
  }),
);

export type LeaveType = typeof leaveTypesTable.$inferSelect;
export type InsertLeaveType = typeof leaveTypesTable.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// employee_leave_balances — per (employee, leave_type)
// ─────────────────────────────────────────────────────────────────────────────
//
// granted_hours        Lifetime grants written to this bucket (flat /
//                      office_recorded). For accrue_per_hours, the
//                      route layer computes from clock events on
//                      demand and writes a snapshot here only at
//                      reset.
// used_hours           Sum of approved leave_requests + office-recorded
//                      employee_leave_usage rows for this bucket.
// last_reset_at        Last anniversary/calendar-year reset.

export const employeeLeaveBalancesTable = pgTable(
  "employee_leave_balances",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    leave_type_id: integer("leave_type_id")
      .notNull()
      .references(() => leaveTypesTable.id),
    granted_hours: numeric("granted_hours", { precision: 8, scale: 2 })
      .notNull()
      .default("0"),
    used_hours: numeric("used_hours", { precision: 8, scale: 2 })
      .notNull()
      .default("0"),
    last_reset_at: timestamp("last_reset_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uq_user_type: uniqueIndex("employee_leave_balances_user_type_uq").on(
      t.company_id,
      t.user_id,
      t.leave_type_id,
    ),
  }),
);

export type EmployeeLeaveBalance =
  typeof employeeLeaveBalancesTable.$inferSelect;
export type InsertEmployeeLeaveBalance =
  typeof employeeLeaveBalancesTable.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// leave_requests — request lifecycle
// ─────────────────────────────────────────────────────────────────────────────
//
// Lifecycle:
//   pending → approved   (office, decrements balance)
//   pending → denied     (office, balance unchanged)
//   approved → cancelled (office, restores balance)
//   pending → cancelled  (office or employee, balance unchanged)
//
// blackout_conflict     Set when the request overlaps a non-exempt
//                       blackout. Auto-denied at create time, but the
//                       row still persists so the office can override.

export const leaveRequestStatusEnum = pgEnum("leave_request_status", [
  "pending",
  "approved",
  "denied",
  "cancelled",
]);

export const leaveRequestsTable = pgTable(
  "leave_requests",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    leave_type_id: integer("leave_type_id")
      .notNull()
      .references(() => leaveTypesTable.id),
    start_date: date("start_date").notNull(),
    end_date: date("end_date").notNull(),
    hours: numeric("hours", { precision: 8, scale: 2 }).notNull(),
    note: text("note"),
    status: leaveRequestStatusEnum("status").notNull().default("pending"),
    blackout_conflict: boolean("blackout_conflict").notNull().default(false),
    blackout_label: text("blackout_label"),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    decided_by_user_id: integer("decided_by_user_id").references(
      () => usersTable.id,
    ),
    decision_note: text("decision_note"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    by_status: index("leave_requests_company_status_idx").on(
      t.company_id,
      t.status,
    ),
    by_user: index("leave_requests_company_user_idx").on(
      t.company_id,
      t.user_id,
      t.start_date,
    ),
  }),
);

export type LeaveRequest = typeof leaveRequestsTable.$inferSelect;
export type InsertLeaveRequest = typeof leaveRequestsTable.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// leave_blackouts — tenant-configurable blackout windows
// ─────────────────────────────────────────────────────────────────────────────

export const leaveBlackoutsTable = pgTable(
  "leave_blackouts",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    start_date: date("start_date").notNull(),
    end_date: date("end_date").notNull(),
    label: text("label").notNull(),
    created_by_user_id: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    by_window: index("leave_blackouts_company_window_idx").on(
      t.company_id,
      t.start_date,
      t.end_date,
    ),
  }),
);

export type LeaveBlackout = typeof leaveBlackoutsTable.$inferSelect;
export type InsertLeaveBlackout = typeof leaveBlackoutsTable.$inferInsert;
