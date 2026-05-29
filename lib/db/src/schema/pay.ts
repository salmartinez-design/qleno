/**
 * Cutover 1E — Pay summary and export.
 *
 * Four tables that turn 1C's clock events into a finalized pay summary
 * the office can hand to any downstream payroll consumer. Provider-
 * neutral by design: no vendor name appears in table names, column
 * names, or this comment. Downstream consumers receive a generic CSV
 * (see lib/pay-export.ts) and can be swapped without schema changes.
 *
 * All money fields are numeric(10,2). All hours fields are numeric(7,2).
 * No floats. Tenant-scoped via company_id on every table.
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

export const payPeriodStatusEnum = pgEnum("pay_period_status", [
  "open",
  "locked",
  "approved",
  "exported",
]);

// ─────────────────────────────────────────────────────────────────────────────
// employee_pay_rates
// ─────────────────────────────────────────────────────────────────────────────
//
// Dated hourly rate per employee. A rate change creates a NEW row;
// existing rows are never overwritten. The effective rate as of a
// given date is the row with the latest effective_date that is
// <= date AND (end_date IS NULL OR end_date >= date).
//
// end_date is only set when a later row supersedes (a write-time
// helper closes the prior row off); manual edits should leave it NULL
// and add a new row instead. Audit trail by design.

export const employeePayRatesTable = pgTable(
  "employee_pay_rates",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    hourly_rate: numeric("hourly_rate", { precision: 10, scale: 2 }).notNull(),
    effective_date: date("effective_date").notNull(),
    end_date: date("end_date"),
    created_by_user_id: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    by_user: index("employee_pay_rates_company_user_idx").on(
      t.company_id,
      t.user_id,
      t.effective_date,
    ),
    uq_effective: uniqueIndex("employee_pay_rates_user_effective_uq").on(
      t.company_id,
      t.user_id,
      t.effective_date,
    ),
  }),
);

export type EmployeePayRate = typeof employeePayRatesTable.$inferSelect;
export type InsertEmployeePayRate = typeof employeePayRatesTable.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// pay_periods
// ─────────────────────────────────────────────────────────────────────────────
//
// Lifecycle: open → locked → approved → exported. One-way. Each
// transition records who and when. Recompute only allowed while open.
// Status enum lives in payPeriodStatusEnum above.

export const payPeriodsTable = pgTable(
  "pay_periods",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    start_date: date("start_date").notNull(),
    end_date: date("end_date").notNull(),
    status: payPeriodStatusEnum("status").notNull().default("open"),
    locked_at: timestamp("locked_at", { withTimezone: true }),
    locked_by_user_id: integer("locked_by_user_id").references(() => usersTable.id),
    approved_at: timestamp("approved_at", { withTimezone: true }),
    approved_by_user_id: integer("approved_by_user_id").references(() => usersTable.id),
    exported_at: timestamp("exported_at", { withTimezone: true }),
    exported_by_user_id: integer("exported_by_user_id").references(() => usersTable.id),
    notes: text("notes"),
    created_by_user_id: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    by_status: index("pay_periods_company_status_idx").on(t.company_id, t.status),
    uq_window: uniqueIndex("pay_periods_company_window_uq").on(
      t.company_id,
      t.start_date,
      t.end_date,
    ),
  }),
);

export type PayPeriod = typeof payPeriodsTable.$inferSelect;
export type InsertPayPeriod = typeof payPeriodsTable.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// pay_period_summaries
// ─────────────────────────────────────────────────────────────────────────────
//
// One row per (pay_period, user) — the computed result of the eligibility
// filter + rate selection + overtime split. `flags` is a text[] surfacing
// anything the office should look at (missing_rate, missing_clock_out,
// unreviewed_gps_exception, etc.).

export const payPeriodSummariesTable = pgTable(
  "pay_period_summaries",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    pay_period_id: integer("pay_period_id")
      .notNull()
      .references(() => payPeriodsTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    regular_hours: numeric("regular_hours", { precision: 7, scale: 2 })
      .notNull()
      .default("0"),
    overtime_hours: numeric("overtime_hours", { precision: 7, scale: 2 })
      .notNull()
      .default("0"),
    regular_pay: numeric("regular_pay", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    overtime_pay: numeric("overtime_pay", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    adjustments_total: numeric("adjustments_total", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    gross_total: numeric("gross_total", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    flags: text("flags").array(),
    computed_at: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    by_period: index("pay_period_summaries_company_period_idx").on(
      t.company_id,
      t.pay_period_id,
    ),
    uq_user: uniqueIndex("pay_period_summaries_period_user_uq").on(
      t.company_id,
      t.pay_period_id,
      t.user_id,
    ),
  }),
);

export type PayPeriodSummary = typeof payPeriodSummariesTable.$inferSelect;
export type InsertPayPeriodSummary = typeof payPeriodSummariesTable.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// pay_adjustments
// ─────────────────────────────────────────────────────────────────────────────
//
// Generic by design — adjustment_type is a free string slug (mileage,
// recognition, bonus, correction, etc.) so the office can add any
// adjustment without a schema change. pay_period_id is nullable until
// the office assigns the adjustment to a specific period.

export const payAdjustmentsTable = pgTable(
  "pay_adjustments",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    pay_period_id: integer("pay_period_id").references(() => payPeriodsTable.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    adjustment_type: text("adjustment_type").notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    note: text("note"),
    // ── Cutover 2A — structured mileage fields ──────────────────────
    // Populated when adjustment_type='mileage' (auto-generated by the
    // mileage routes from on_my_way_events legs) and left null for
    // every other adjustment type. The on-my-way event that produced
    // this row is recorded so re-running the mileage computation does
    // not double-pay; uniqueness is enforced by a partial unique index
    // created in the cutover-data-migration (cannot express partial
    // uniqueness via drizzle-kit alone).
    source_on_my_way_event_id: integer("source_on_my_way_event_id"),
    from_job_id: integer("from_job_id"),
    to_job_id: integer("to_job_id"),
    miles: numeric("miles", { precision: 7, scale: 2 }),
    minutes: integer("minutes"),
    rate_per_mile: numeric("rate_per_mile", { precision: 6, scale: 4 }),
    measurement_source: text("measurement_source"),
    measurement_is_estimated: integer("measurement_is_estimated"),
    created_by_user_id: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    by_user_period: index("pay_adjustments_company_user_period_idx").on(
      t.company_id,
      t.user_id,
      t.pay_period_id,
    ),
  }),
);

export type PayAdjustment = typeof payAdjustmentsTable.$inferSelect;
export type InsertPayAdjustment = typeof payAdjustmentsTable.$inferInsert;
