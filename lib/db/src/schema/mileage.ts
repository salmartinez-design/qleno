/**
 * Cutover 2A (corrective) — Mileage tables.
 *
 * Three tables that turn 1C's on-my-way events into office-reviewable
 * mileage proposals — NOT into pay yet. The 2B step promotes a
 * reviewed leg into a pay_adjustments row; until then nothing is
 * money. Lessons from the first 2A:
 *
 *   mileage_rates    Dated, owner-editable, append-only. A rate
 *                    change creates a NEW row, never overwrites.
 *                    The rate used for a leg is the row whose
 *                    effective_date is the latest on or before the
 *                    leg's date. Mirrors employee_pay_rates so the
 *                    compliance story for "what rate was paid on
 *                    2026-03-14?" stays answerable forever.
 *
 *   mileage_legs     One row per OMW leg that the route considered.
 *                    Carries the measurement, the rate that applied
 *                    at the time, the amount in cents, and a lifecycle
 *                    state (computed → reviewed → applied | discarded).
 *                    Computed-but-not-applied rows are visible to the
 *                    office but DO NOT flow into pay_adjustments or
 *                    the period's gross_total. The applied state is
 *                    set by 2B when the office signs off and a
 *                    pay_adjustments row is inserted referencing it.
 *
 *   distance_cache   Per-tenant cache of measured legs, keyed by
 *                    coord-pair. A recompute over an unchanged period
 *                    hits the cache instead of re-calling the mapping
 *                    API. The measurement provenance (source +
 *                    is_estimated) is preserved on the cache row so a
 *                    later forensic question can tell the office
 *                    whether the original measurement was an API
 *                    call or a haversine estimate.
 *
 * All money fields are numeric not float. All distance fields are
 * numeric. Tenant-scoped via company_id on every table.
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
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";
import { onMyWayEventsTable } from "./on_my_way_events";
import { payPeriodsTable, payAdjustmentsTable } from "./pay";

// ─────────────────────────────────────────────────────────────────────────────
// mileage_rates — dated $/mi, append-only
// ─────────────────────────────────────────────────────────────────────────────

export const mileageRatesTable = pgTable(
  "mileage_rates",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    rate: numeric("rate", { precision: 6, scale: 4 }).notNull(),
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
    by_company_effective: index("mileage_rates_company_effective_idx").on(
      t.company_id,
      t.effective_date,
    ),
    uq_effective: uniqueIndex("mileage_rates_company_effective_uq").on(
      t.company_id,
      t.effective_date,
    ),
  }),
);

export type MileageRate = typeof mileageRatesTable.$inferSelect;
export type InsertMileageRate = typeof mileageRatesTable.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// mileage_legs — computed work, NOT pay
// ─────────────────────────────────────────────────────────────────────────────

export const mileageLegStatusEnum = pgEnum("mileage_leg_status", [
  "computed",
  "reviewed",
  "applied",
  "discarded",
]);

export const mileageLegsTable = pgTable(
  "mileage_legs",
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
    // Idempotency key. Partial unique index installed by
    // cutover-data-migration: prevents a recompute from creating two
    // rows for the same OMW event.
    source_on_my_way_event_id: integer("source_on_my_way_event_id")
      .notNull()
      .references(() => onMyWayEventsTable.id),
    from_job_id: integer("from_job_id")
      .notNull()
      .references(() => jobsTable.id),
    to_job_id: integer("to_job_id")
      .notNull()
      .references(() => jobsTable.id),
    leg_date: date("leg_date").notNull(),
    miles: numeric("miles", { precision: 7, scale: 2 }).notNull(),
    minutes: integer("minutes").notNull(),
    rate_per_mile: numeric("rate_per_mile", { precision: 6, scale: 4 }).notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    measurement_source: text("measurement_source").notNull(),
    measurement_is_estimated: boolean("measurement_is_estimated").notNull(),
    // Lifecycle.
    status: mileageLegStatusEnum("status").notNull().default("computed"),
    reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
    reviewed_by_user_id: integer("reviewed_by_user_id").references(
      () => usersTable.id,
    ),
    applied_at: timestamp("applied_at", { withTimezone: true }),
    // Set by 2B when the leg becomes a pay_adjustments row.
    applied_pay_adjustment_id: integer("applied_pay_adjustment_id").references(
      () => payAdjustmentsTable.id,
    ),
    discarded_at: timestamp("discarded_at", { withTimezone: true }),
    discarded_by_user_id: integer("discarded_by_user_id").references(
      () => usersTable.id,
    ),
    discard_reason: text("discard_reason"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    by_period: index("mileage_legs_company_period_idx").on(
      t.company_id,
      t.pay_period_id,
    ),
    by_user_period: index("mileage_legs_company_user_period_idx").on(
      t.company_id,
      t.user_id,
      t.pay_period_id,
    ),
    by_status: index("mileage_legs_company_status_idx").on(
      t.company_id,
      t.status,
    ),
    uq_source: uniqueIndex("mileage_legs_source_uq").on(
      t.company_id,
      t.source_on_my_way_event_id,
    ),
  }),
);

export type MileageLeg = typeof mileageLegsTable.$inferSelect;
export type InsertMileageLeg = typeof mileageLegsTable.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// distance_cache — per-tenant cache of mapping-API results
// ─────────────────────────────────────────────────────────────────────────────
//
// Coords are stored at numeric(10,7) to match clients.lat/lng so the
// uniqueness check is exact across recomputes. A force-refresh flow
// deletes the row and re-fetches.

export const distanceCacheTable = pgTable(
  "distance_cache",
  {
    id: serial("id").primaryKey(),
    company_id: integer("company_id")
      .notNull()
      .references(() => companiesTable.id),
    from_lat: numeric("from_lat", { precision: 10, scale: 7 }).notNull(),
    from_lng: numeric("from_lng", { precision: 10, scale: 7 }).notNull(),
    to_lat: numeric("to_lat", { precision: 10, scale: 7 }).notNull(),
    to_lng: numeric("to_lng", { precision: 10, scale: 7 }).notNull(),
    meters: numeric("meters", { precision: 10, scale: 2 }).notNull(),
    minutes: integer("minutes").notNull(),
    source: text("source").notNull(),
    is_estimated: boolean("is_estimated").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uq_pair: uniqueIndex("distance_cache_pair_uq").on(
      t.company_id,
      t.from_lat,
      t.from_lng,
      t.to_lat,
      t.to_lng,
    ),
  }),
);

export type DistanceCacheRow = typeof distanceCacheTable.$inferSelect;
export type InsertDistanceCacheRow = typeof distanceCacheTable.$inferInsert;
