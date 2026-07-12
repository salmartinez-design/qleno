import { pgTable, serial, text, integer, timestamp, numeric, date, boolean, pgEnum } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";
import { recurringSchedulesTable } from "./recurring_schedules";

// [recurring-revenue 2026-07-12] Qleno-native Recurring Revenue engine — MRR,
// retention, churn, and the go-forward capture layer that feeds them. This
// module is strictly ADDITIVE: every table below is new, and the module NEVER
// writes to clients / recurring_schedules / jobs. The FK references to
// clients.id and recurring_schedules.id are READ-ONLY links (a constraint, not
// a write) — the module SELECTs from those tables and records its own view here.
//
// Phase 1 is RESIDENTIAL only. client_type is present on every table and every
// query hard-sets it to 'residential' for now; Phase 2 is "flip the filter".

// ── Enums ────────────────────────────────────────────────────────────────────
export const recurringClientTypeEnum = pgEnum("recurring_client_type", [
  "residential", "commercial",
]);

export const recurringStatusEnum = pgEnum("recurring_status", [
  "active", "paused", "lost", "on_demand",
]);

// How the captured rate should be read. Metadata only — it does NOT change the
// MRR math (MRR is always rate × monthly_multiplier).
export const recurringPriceBasisEnum = pgEnum("recurring_price_basis", [
  "monthly", "per_visit", "unknown",
]);

// The cadence drives the monthly multiplier. `custom` and `weekdays` have NO
// deterministic multiplier — MRR is NOT COMPUTABLE for them; those rows are
// flagged and surfaced on the Data Health screen, never silently dropped.
// `semi_monthly` is commercial-oriented but supported here for completeness.
export const recurringCadenceEnum = pgEnum("recurring_cadence", [
  "weekly", "biweekly", "every_3_weeks", "every_6_weeks", "every_8_weeks",
  "semi_monthly", "monthly", "custom", "weekdays",
]);

export const subscriptionLossReasonEnum = pgEnum("subscription_loss_reason", [
  "price_budget_change",       // Price / Budget Change
  "moved_no_longer_needs",     // Moved / No Longer Needs Service
  "internal_personal",         // Internal / Personal Reasons
  "service_quality",           // Service Quality Issue
]);

export const subscriptionPauseReasonEnum = pgEnum("subscription_pause_reason", [
  "seasonal_pause",            // Seasonal Pause
  "home_renovation",           // Home Renovation / Construction
]);

export const subscriptionLifecycleEventTypeEnum = pgEnum("subscription_lifecycle_event_type", [
  "pause", "resume", "notice", "loss",
]);

export const subscriptionNoCommissionReasonEnum = pgEnum("subscription_no_commission_reason", [
  "reactivation", "marketing", "other",
]);

// ── recurring_subscriptions ──────────────────────────────────────────────────
// One row per recurring client the module tracks. Carries the module's own view
// of the subscription: cadence + rate → MRR, lifecycle status, and the read-only
// links back to the Qleno client + schedule that produce the numbers.
export const recurringSubscriptionsTable = pgTable("recurring_subscriptions", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),                       // Oak Lawn / Schaumburg — every query scopes on this
  // READ-ONLY links. A recurring client = a row in recurring_schedules; the
  // client is the person. Both nullable so a captured subscription can exist
  // before/independent of a linked schedule, but the module never writes them.
  client_id: integer("client_id").references(() => clientsTable.id),
  recurring_schedule_id: integer("recurring_schedule_id").references(() => recurringSchedulesTable.id),
  client_type: recurringClientTypeEnum("client_type").notNull().default("residential"),
  status: recurringStatusEnum("status").notNull().default("active"),
  cadence: recurringCadenceEnum("cadence"),
  // Monthly multiplier for the cadence. NULL for custom/weekdays (NOT COMPUTABLE).
  monthly_multiplier: numeric("monthly_multiplier", { precision: 6, scale: 3 }),
  // The captured visit/monthly rate.
  rate: numeric("rate", { precision: 12, scale: 2 }),
  price_basis: recurringPriceBasisEnum("price_basis").notNull().default("unknown"),
  // Derived MRR = rate × monthly_multiplier. NULL when NOT COMPUTABLE (custom/
  // weekdays cadence, or a $0/null rate). A NULL here is never a silent drop —
  // it's what the Data Health "MRR Confidence" metric counts against, with the
  // blocking reason shown. Stored (not just computed) so it's reproducible, but
  // always equals rate × monthly_multiplier.
  mrr: numeric("mrr", { precision: 12, scale: 2 }),
  first_cleaning_date: date("first_cleaning_date"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

// ── subscription_lifecycle_events ────────────────────────────────────────────
// Pause / resume / notice / loss, each with its reason + dates. This is the
// churn + pause record. A loss detected from Qleno's EXISTING cancellation_log
// (read-only) is written here with source='needs_classification' and NO reason,
// so a human tags it — the module never guesses a loss reason.
export const subscriptionLifecycleEventsTable = pgTable("subscription_lifecycle_events", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  subscription_id: integer("subscription_id").references(() => recurringSubscriptionsTable.id).notNull(),
  event_type: subscriptionLifecycleEventTypeEnum("event_type").notNull(),
  // Loss fields
  loss_reason: subscriptionLossReasonEnum("loss_reason"),
  loss_date: date("loss_date"),
  notice_given_date: date("notice_given_date"),
  final_service_date: date("final_service_date"),
  // Pause fields — snapshot the original cadence + MRR so resume restores exactly.
  pause_reason: subscriptionPauseReasonEnum("pause_reason"),
  pause_end_date: date("pause_end_date"),
  original_cadence: recurringCadenceEnum("original_cadence"),
  original_mrr: numeric("original_mrr", { precision: 12, scale: 2 }),
  attachment_url: text("attachment_url"),
  notes: text("notes"),
  // 'captured' = tagged by a human in this module's flow.
  // 'needs_classification' = auto-detected from cancellation_log, awaiting a human tag.
  source: text("source").notNull().default("captured"),
  // READ-ONLY provenance link to the existing cancel record we detected from.
  cancellation_log_id: integer("cancellation_log_id"),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

// ── sales_attribution ────────────────────────────────────────────────────────
// Who SIGNED the recurring client (the VA sales credit) + eligibility for
// commission. Person names are normalized on write so a leaderboard doesn't
// split "Sal Martinez" vs "Salvador Martinez" into two people.
export const salesAttributionTable = pgTable("sales_attribution", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  subscription_id: integer("subscription_id").references(() => recurringSubscriptionsTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id),
  // Normalized display name of the salesperson (the credit).
  salesperson: text("salesperson"),
  // When the salesperson is a Qleno VA user, link them so the commission engine
  // and the "View as VA" impersonation resolve to a real account.
  salesperson_user_id: integer("salesperson_user_id").references(() => usersTable.id),
  subscribed_by: text("subscribed_by"),
  is_self_sourced: boolean("is_self_sourced").notNull().default(false),
  commission_eligible: boolean("commission_eligible").notNull().default(true),
  // Required + displayed when commission_eligible = false.
  no_commission_reason: subscriptionNoCommissionReasonEnum("no_commission_reason"),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});
