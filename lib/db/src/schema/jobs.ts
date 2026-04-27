import { pgTable, serial, text, integer, timestamp, numeric, date, pgEnum, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";
import { billingMethodEnum } from "./account_rate_cards";
import { branchesTable } from "./branches";

export const jobStatusEnum = pgEnum("job_status", [
  "scheduled", "in_progress", "complete", "cancelled"
]);

export const serviceTypeEnum = pgEnum("service_type", [
  "standard_clean", "deep_clean", "move_out", "recurring", "post_construction", "move_in",
  "office_cleaning", "common_areas", "retail_store", "medical_office", "ppm_turnover", "post_event"
]);

export const frequencyEnum = pgEnum("frequency", [
  "weekly", "biweekly", "every_3_weeks", "monthly", "on_demand"
]);

export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id),
  account_id: integer("account_id"),
  account_property_id: integer("account_property_id"),
  assigned_user_id: integer("assigned_user_id").references(() => usersTable.id),
  billing_method: billingMethodEnum("billing_method"),
  hourly_rate: numeric("hourly_rate", { precision: 10, scale: 2 }),
  estimated_hours: numeric("estimated_hours", { precision: 5, scale: 2 }),
  billed_hours: numeric("billed_hours", { precision: 5, scale: 2 }),
  billed_amount: numeric("billed_amount", { precision: 10, scale: 2 }),
  charge_attempted_at: timestamp("charge_attempted_at"),
  charge_succeeded_at: timestamp("charge_succeeded_at"),
  charge_failed_at: timestamp("charge_failed_at"),
  charge_failure_reason: text("charge_failure_reason"),
  service_type: serviceTypeEnum("service_type").notNull(),
  status: jobStatusEnum("status").notNull().default("scheduled"),
  scheduled_date: date("scheduled_date").notNull(),
  scheduled_time: text("scheduled_time"),
  frequency: frequencyEnum("frequency").notNull().default("on_demand"),
  base_fee: numeric("base_fee", { precision: 10, scale: 2 }).notNull(),
  fee_split_pct: numeric("fee_split_pct", { precision: 5, scale: 2 }),
  allowed_hours: numeric("allowed_hours", { precision: 6, scale: 2 }),
  actual_hours: numeric("actual_hours", { precision: 6, scale: 2 }),
  notes: text("notes"),
  completion_pdf_url: text("completion_pdf_url"),
  completion_pdf_sent_at: timestamp("completion_pdf_sent_at"),
  // [AF] Mark-complete flow — set atomically on Mark Complete click
  actual_end_time: timestamp("actual_end_time"),
  locked_at: timestamp("locked_at"),
  completed_by_user_id: integer("completed_by_user_id"),
  job_lat: numeric("job_lat", { precision: 10, scale: 7 }),
  job_lng: numeric("job_lng", { precision: 10, scale: 7 }),
  geocode_failed: boolean("geocode_failed").notNull().default(false),
  zone_id: integer("zone_id"),
  branch_id: integer("branch_id").references(() => branchesTable.id),
  recurring_schedule_id: integer("recurring_schedule_id"),
  supply_cost: numeric("supply_cost", { precision: 8, scale: 2 }).default("0.00"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  // ── Booking widget extra fields ─────────────────────────────────────────────
  home_condition_rating: integer("home_condition_rating"),
  condition_multiplier: numeric("condition_multiplier", { precision: 5, scale: 3 }),
  applied_bundle_id: integer("applied_bundle_id"),
  bundle_discount_total: numeric("bundle_discount_total", { precision: 10, scale: 2 }),
  last_cleaned_response: text("last_cleaned_response"),
  last_cleaned_flag: text("last_cleaned_flag"),
  overage_disclaimer_acknowledged: boolean("overage_disclaimer_acknowledged").default(false),
  overage_rate: numeric("overage_rate", { precision: 10, scale: 2 }),
  // ── Upsell tracking ─────────────────────────────────────────────────────────
  upsell_shown: boolean("upsell_shown").default(false),
  upsell_accepted: boolean("upsell_accepted").default(false),
  upsell_declined: boolean("upsell_declined").default(false),
  upsell_deferred: boolean("upsell_deferred").default(false),
  upsell_cadence_selected: text("upsell_cadence_selected"),
  property_vacant: boolean("property_vacant").default(false),
  first_recurring_discounted: boolean("first_recurring_discounted").default(false),
  // ── Address (from booking widget) ───────────────────────────────────────────
  address_street: text("address_street"),
  address_city: text("address_city"),
  address_state: text("address_state"),
  address_zip: text("address_zip"),
  address_verified: boolean("address_verified").default(false),
  address_lat: numeric("address_lat", { precision: 10, scale: 7 }),
  address_lng: numeric("address_lng", { precision: 10, scale: 7 }),
  // ── Location routing ────────────────────────────────────────────────────────
  booking_location: text("booking_location"),
  // ── Office notes (pushed from quote call notes) ─────────────────────────────
  office_notes: text("office_notes"),
  flagged: boolean("flagged").notNull().default(false),
  // [AG] Set true when a user manually overrides the calculated base_fee in
  // the edit modal. Cleared when scope/freq/add-ons change AND base_fee is
  // omitted from the patch (recalc pulls a fresh value from pricing engine).
  manual_rate_override: boolean("manual_rate_override").notNull().default(false),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, created_at: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
