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
  "office_cleaning", "common_areas", "retail_store", "medical_office", "ppm_turnover", "post_event",
  // [AI.3] PHES commercial — fills the gap that triggered the tenant-managed
  // commercial_service_types table. New tenant-added slugs are extended into
  // this enum at runtime via sanitized ALTER TYPE on POST /api/commercial-service-types.
  "ppm_common_areas",
  // [AI.4] Two more commercial slugs added to PHES seed.
  "commercial_cleaning", "recurring_commercial_cleaning",
  // [BUG-8 / 2026-06-01] Carpet Cleaning. MaidCentral has it as a first-class
  // residential service; pre-this jobs that should have been carpet were
  // typed under a substitute (e.g. deep_clean). Added as a residential
  // specialty in service_types (per-company row); historical jobs keep
  // their stored slug. Companion DB ALTER applied directly on prod.
  "carpet_cleaning",
]);

export const frequencyEnum = pgEnum("frequency", [
  "weekly", "biweekly", "every_3_weeks", "monthly", "on_demand",
  // [AI] Multi-day commercial scheduling (2026-04-27)
  "daily", "weekdays", "custom_days",
  // [PR #58] Semi-monthly cadence — anchors on specific days_of_month
  // (typically [1, 15] or [15, 30]). Engine snaps forward to next
  // business day when an anchor falls on a weekend.
  "semi_monthly",
  // [monthly-weekday 2026-07-21] Nth/last weekday of month — "Last Friday",
  // "2nd Tuesday". Pairs recurring_schedules.week_of_month (1..4, 5=last) with
  // day_of_week. Fixes the "every 4 weeks drifts on 5-Friday months" complaint.
  // Added to the live enum by runMonthlyWeekdayEnumMigration at boot.
  "monthly_weekday",
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
  // [commission-optin 2026-07-01] The commissionable base = base_fee (or
  // hrs×rate for commercial) + only the add-ons/rate-mods flagged
  // affects_commission. The pay engine reads THIS instead of billed_amount so
  // add-ons/adjustments count toward the fee split only when the office opts in.
  // NULL falls back to the legacy max(base_fee, billed_amount) behavior.
  // Recomputed alongside billed_amount in recomputeJobBilledAmount.
  commission_base: numeric("commission_base", { precision: 10, scale: 2 }),
  charge_attempted_at: timestamp("charge_attempted_at"),
  charge_succeeded_at: timestamp("charge_succeeded_at"),
  charge_failed_at: timestamp("charge_failed_at"),
  charge_failure_reason: text("charge_failure_reason"),
  service_type: serviceTypeEnum("service_type").notNull(),
  status: jobStatusEnum("status").notNull().default("scheduled"),
  scheduled_date: date("scheduled_date").notNull(),
  scheduled_time: text("scheduled_time"),
  // [time-change-notice 2026-06-30] Raise the manual "notify the client of the
  // new arrival time" note on the job card after a SAME-DAY time move. Columns
  // are created at boot by ensureTimeChangeNoticeSetup(); declared here so the
  // query builder can read them. time_change_from holds the prior "HH:MM".
  time_change_pending: boolean("time_change_pending").notNull().default(false),
  time_change_from: text("time_change_from"),
  // [auto-promo-suppress] When the office removes an AUTO_ promo from this job,
  // this flag records the intent so the self-healing chokepoint
  // (ensureAutoPromosForJob) stops re-stamping it. Cleared by the re-apply
  // endpoint. Column added at boot by runAutoPromosMigration.
  auto_promos_suppressed: boolean("auto_promos_suppressed").notNull().default(false),
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
  // [phes-lifecycle 2026-04-29] Manual no-show flag. Set by the field
  // app's "No Show" button after the tech has waited NO_SHOW_WAIT_MINUTES
  // on-site for the customer. Distinct from late_clockin (tech
  // accountability) — this represents customer accountability. Until
  // the field app ships, both fields stay null and no_show never
  // fires in production.
  no_show_marked_by_tech: timestamp("no_show_marked_by_tech"),
  no_show_marked_by_user_id: integer("no_show_marked_by_user_id"),
  job_lat: numeric("job_lat", { precision: 10, scale: 7 }),
  job_lng: numeric("job_lng", { precision: 10, scale: 7 }),
  geocode_failed: boolean("geocode_failed").notNull().default(false),
  zone_id: integer("zone_id"),
  branch_id: integer("branch_id").references(() => branchesTable.id),
  recurring_schedule_id: integer("recurring_schedule_id"),
  // [recurring-reschedule 2026-06-05] The cadence slot this job was generated
  // from — a stable identity for dedup, separate from scheduled_date (which the
  // office can move). The recurrence engine dedups on occurrence_date so moving
  // a recurring occurrence off its day never frees the original slot for the
  // nightly cron to regenerate (the "appears again on Monday" duplicate bug).
  // NULL for one-off (non-recurring) jobs.
  occurrence_date: date("occurrence_date"),
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
  // [notes-author] Last editor + time of the office notes, so the panel can
  // show "Edited by X · date". Stamped by the PATCH /jobs/:id handler.
  office_notes_updated_by: integer("office_notes_updated_by"),
  office_notes_updated_at: timestamp("office_notes_updated_at"),
  flagged: boolean("flagged").notNull().default(false),
  // [AG] Set true when a user manually overrides the calculated base_fee in
  // the edit modal. Cleared when scope/freq/add-ons change AND base_fee is
  // omitted from the patch (recalc pulls a fresh value from pricing engine).
  manual_rate_override: boolean("manual_rate_override").notNull().default(false),
  // ── Cutover 1A (data backbone) — additive columns ───────────────────────
  // Scope flags lifted off the MaidCentral worksheet header. 1B (day
  // view) reads these as chips on the job card; 1C (clock-in) doesn't
  // touch them; pay logic (later) consumes scope_deep_clean +
  // scope_first_time_in for surcharge math. All default false so the
  // additive migration is safe on existing job rows.
  scope_deep_clean: boolean("scope_deep_clean").notNull().default(false),
  scope_first_time_in: boolean("scope_first_time_in").notNull().default(false),
  scope_priority: boolean("scope_priority").notNull().default(false),
  special_equipment_needed: boolean("special_equipment_needed").notNull().default(false),
  out_of_rotation: boolean("out_of_rotation").notNull().default(false),
  // job_kind separates real cleaning visits from office events / meetings
  // that show up on the same daily timeline. Office events have no
  // client_id, no scorecard, no commission — just a slot on the day
  // view with allowed_hours so the tech sees "9:00 AM team huddle, 0.25h".
  // 1B renders these; later pay/commission logic skips them via this flag.
  job_kind: text("job_kind").notNull().default("cleaning"),
  // FK alias to service_types.id. Coexists with the existing
  // `service_type` (text/enum) column — the enum stays as the historical
  // source of truth on existing rows, and the FK is populated for new
  // rows + backfilled in a later migration once every existing slug is
  // confirmed mapped. The dispatch UI in 1B reads service_type_id when
  // present and falls back to service_type otherwise.
  service_type_id: integer("service_type_id"),
  // [redo-service 2026-07-10] A redo / re-clean created from an original job via
  // the "Create Redo Service" flow. redo_of_job_id links back to the original;
  // non_billable=true keeps the $0 redo OUT of revenue counts + invoicing (it's
  // free under the client guarantee). A recovery tech is still paid via the
  // job_technicians pay_override — non_billable only affects client billing.
  redo_of_job_id: integer("redo_of_job_id"),
  non_billable: boolean("non_billable").notNull().default(false),
  // [auto-issue-hold 2026-07-22] Office hold on THIS visit's invoice. Distinct
  // from non_billable (which means "free, never bill this") — a held job WILL be
  // billed, just not automatically: the office is still resolving a complaint, a
  // rate, or a scope question. Auto-issue skips it and it stays in the
  // "not yet invoiced" queue until the hold is lifted. Clearing the hold and
  // re-running completion invoices it normally.
  invoice_hold: boolean("invoice_hold").notNull().default(false),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, created_at: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
