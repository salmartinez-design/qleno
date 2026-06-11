import { pgTable, serial, text, integer, timestamp, boolean, numeric, date, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";

export const userRoleEnum = pgEnum("user_role", [
  "owner", "admin", "office", "technician", "team_lead", "super_admin"
]);

export const payTypeEnum = pgEnum("pay_type", [
  "hourly", "per_job", "fee_split"
]);

export const employmentTypeEnum = pgEnum("employment_type", [
  "full_time", "part_time", "contractor"
]);

export const hrStatusEnum = pgEnum("hr_status", [
  "trainee", "active", "quality_probation", "inactive",
]);

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("technician"),
  first_name: text("first_name").notNull(),
  last_name: text("last_name").notNull(),
  avatar_url: text("avatar_url"),
  phone: text("phone"),
  personal_email: text("personal_email"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  dob: date("dob"),
  gender: text("gender"),
  hire_date: date("hire_date"),
  termination_date: date("termination_date"),
  employment_type: employmentTypeEnum("employment_type"),
  pay_rate: numeric("pay_rate", { precision: 10, scale: 2 }),
  pay_type: payTypeEnum("pay_type"),
  fee_split_pct: numeric("fee_split_pct", { precision: 5, scale: 2 }),
  allowed_hours_per_week: numeric("allowed_hours_per_week", { precision: 6, scale: 2 }),
  overtime_eligible: boolean("overtime_eligible").default(true),
  w2_1099: text("w2_1099"),
  bank_name: text("bank_name"),
  bank_account_last4: text("bank_account_last4"),
  skills: text("skills").array(),
  tags: text("tags").array(),
  emergency_contact_name: text("emergency_contact_name"),
  emergency_contact_phone: text("emergency_contact_phone"),
  emergency_contact_relation: text("emergency_contact_relation"),
  ssn_last4: text("ssn_last4"),
  notes: text("notes"),
  hr_status: hrStatusEnum("hr_status").default("active"),
  commission_rate_override: numeric("commission_rate_override", { precision: 6, scale: 2 }),
  // MaidCentral-style scorecard: a single percentage per employee. Stored as
  // MC's authoritative value on import (NOT recomputed — MC's % is not a simple
  // average of job scores). Per-job history lives in scorecard_entries.
  scorecard_pct: numeric("scorecard_pct", { precision: 5, scale: 2 }),
  // [pay-matrix 2026-04-29] Per-employee 4-cell pay matrix. Replaces
  // the company-wide single-rate model. Type can be 'commission' (rate
  // is a fraction 0.00–1.00) or 'hourly' (rate is dollars/hour). The
  // dispatch route routes residential vs commercial off
  // clients.client_type and picks the corresponding pair from this
  // matrix. New employees inherit the tenant defaults from
  // companies.default_{residential,commercial}_pay_{type,rate}.
  residential_pay_type: text("residential_pay_type").default("commission"),
  residential_pay_rate: numeric("residential_pay_rate", { precision: 8, scale: 4 }).default("0.35"),
  commercial_pay_type:  text("commercial_pay_type").default("hourly"),
  commercial_pay_rate:  numeric("commercial_pay_rate",  { precision: 8, scale: 4 }).default("20.0000"),
  benefit_year_start: date("benefit_year_start"),
  leave_balance_hours: numeric("leave_balance_hours", { precision: 8, scale: 2 }).default("0"),
  leave_balance_activated: boolean("leave_balance_activated").default(false),
  invite_token: text("invite_token"),
  invite_sent_at: timestamp("invite_sent_at"),
  invite_accepted_at: timestamp("invite_accepted_at"),
  onboarding_complete: boolean("onboarding_complete").default(false),
  is_active: boolean("is_active").notNull().default(true),
  /**
   * Item 3 (P0 sprint 2026-05-14): soft-delete for LMS cleanup.
   * Distinct from `termination_date` (HR concept; sets the day someone
   * stopped working) and from `is_active` (used by other Qleno
   * surfaces). When set, the LMS roster + audit dashboard hide the
   * row but cert / signature history is preserved for legal. Set by
   * the owner via the per-employee admin drawer "Archive employee"
   * action; never set by the system.
   */
  archived_at: timestamp("archived_at"),
  /**
   * QA sandbox flag (2026-05-15 sprint). Currently set on a single
   * Phes account (training.sandbox@phes.io, user_id=446) — repurposed
   * from a Dispatch audit fixture. Sandbox rows are excluded from
   * every tenant-wide aggregate (active counts, audit dashboard
   * status cards, annual re-ack cron) so audits and demos don't
   * pollute production metrics. The roster view filters them in the
   * server SELECT; surface them only when the caller explicitly opts
   * in via a `?includeSandbox=true` query param.
   */
  is_sandbox: boolean("is_sandbox").notNull().default(false),
  /**
   * Last successful login timestamp. Populated by `POST /api/auth/login`
   * on every successful auth. Distinct from `lms_enrollments.last_activity_at`
   * (which only ticks on quiz-submit). The LMS admin roster surfaces both
   * so the office can see "did this person open the app at all" vs
   * "did this person make LMS progress."
   */
  last_login_at: timestamp("last_login_at"),
  crew_id: integer("crew_id"),
  home_branch_id: integer("home_branch_id").references(() => branchesTable.id),
  // ── Cutover 1A (data backbone) — additive columns for geofence /
  //    dispatch defaults. The existing address/city/state/zip cover the
  //    home address; what we add here is the geocoded lat/lng (cached
  //    once, used by 1C's commute exclusion + mileage logic) plus the
  //    operator-friendly default-team / default-position labels used by
  //    the day view (1B) to pre-fill assignment chips. All nullable so
  //    the additive migration is safe on the existing user rows.
  home_lat: numeric("home_lat", { precision: 10, scale: 7 }),
  home_lng: numeric("home_lng", { precision: 10, scale: 7 }),
  default_team: text("default_team"),
  default_position: text("default_position"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, created_at: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
