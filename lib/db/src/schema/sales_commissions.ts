import { pgTable, serial, text, integer, timestamp, numeric, date, boolean, jsonb, pgEnum, unique } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";
import { recurringSubscriptionsTable, recurringClientTypeEnum } from "./recurring_subscriptions";

// [recurring-revenue 2026-07-12] VA SALES commission — paid to whoever SIGNED a
// recurring client. This is NOT Qleno's technician-pay commission
// (users.commission_rate_override / job_technicians.commission_pct, 35% of job
// value). Unrelated systems that share a word — this one does NOT touch payroll
// tables. All tables here are new + additive; nothing writes clients /
// recurring_schedules / jobs.
//
// [ares-parity 2026-08-18] Extended to mirror the legacy Ares commission engine
// exactly. Ares pays FLAT DOLLARS from a (client_type, cadence) rate card — not
// a percentage of MRR — so `commission_rate_card` is now the primary pricing
// source and `commission_policy.commission_rate` is retained for a future
// percentage model. The composition of an amount is stored in parts
// (base + sourcing bonus + specialty bonus) so any total is explainable.
//
// Money-system invariants baked into the shape:
//   • Every aggregate $ is reproducible from line items — a payout's total is
//     the SUM of the commissions carrying its payment_id; a commission's amount
//     is base_amount + source_bonus_amount + specialty_bonus_amount (or
//     mrr_basis × commission_rate under a future percentage policy).
//   • Every state transition writes an immutable row in commission_status_events.
//   • Every money movement writes a signed row in commission_ledger.
//   • Payout runs are idempotent via commission_payments.idempotency_key.

// ── Enums ────────────────────────────────────────────────────────────────────

// Ares' 10 live statuses, expressed in Qleno naming. The two renames:
//   Ares 'pending'      ≡ 'pending_review'
//   Ares 'chargebacked' ≡ 'charged_back'  (VA-disputed, parked out of payout)
// Flow: earned → pending_review → approved → paid
//       exits: rejected | not_eligible | on_hold (client paused)
//       chargeback: chargeback_pending → chargeback_confirmed → recouped
export const salesCommissionStatusEnum = pgEnum("sales_commission_status", [
  "earned", "pending_review", "approved", "paid", "rejected", "charged_back",
  // [ares-parity] additive — never reorder, never remove.
  "not_eligible", "on_hold", "chargeback_pending", "chargeback_confirmed", "recouped",
]);

// What KIND of money this line is. 'base' is the cadence rate; the rest are the
// bonus/adjustment paths Ares supports.
export const salesCommissionTypeEnum = pgEnum("sales_commission_type", [
  "base", "sourcing_bonus", "performance_bonus", "specialty_bonus", "frequency_adjustment",
]);

// Why a commission was ruled out. All 9 of Ares' categories, in the order its
// dropdown lists them (CommissionPortal.tsx:234-244). The legacy DB only ever
// stored 4 of these, but the UI has always offered 9 — the enum follows the UI,
// because a category the reviewer can pick must be one the database can store.
export const commissionIneligibilityCategoryEnum = pgEnum("commission_ineligibility_category", [
  "returning_90_days",       // Returning Client — Active within 90 days (no new agreement)
  "returning_no_agreement",  // Returning Client (No New Agreement)
  "missing_agreement",       // Missing Service Agreement
  "cancelled_before_clean",  // Client Cancelled Before First Clean
  "duplicate",               // Duplicate Commission
  "data_error",              // Data Entry Error
  "client_initiated",        // Client Initiated Contact (Not VA-Sourced)
  "previous_phes",           // Previously Used PHES Services
  "other",                   // Other
]);

// Signed ledger movements. Every dollar that moves writes one of these.
export const commissionLedgerEntryTypeEnum = pgEnum("commission_ledger_entry_type", [
  "base", "commercial_source_bonus", "specialty_bonus", "performance_bonus",
  "adjustment", "chargeback", "payout",
]);

// ── commission_policy ────────────────────────────────────────────────────────
// Dated policy (mirrors mileage_rates): chargeback window + payout schedule
// effective from a date, so a commission computed months ago is explainable by
// the policy in force THEN — never silently re-rated by today's.
//
// [ares-parity] `commission_rate` is NOT used by the Ares engine — flat rates
// live in commission_rate_card. It is kept for a future percentage model.
export const commissionPolicyTable = pgTable("commission_policy", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  // Reserved for a future percentage model. Unused by the flat-rate engine.
  commission_rate: numeric("commission_rate", { precision: 6, scale: 4 }).notNull().default("0"),
  // Days after FIRST CLEANING during which a client cancel claws the commission
  // back. Ares: residential 180 (6 months), commercial exempt.
  chargeback_window_days: integer("chargeback_window_days").notNull().default(180),
  // [ares-parity] Commercial clients sign 1-year agreements and are exempt from
  // chargeback entirely. 0 = exempt.
  commercial_chargeback_window_days: integer("commercial_chargeback_window_days").notNull().default(0),
  // Days a VA has to dispute after a loss before the clawback is confirmed.
  chargeback_dispute_days: integer("chargeback_dispute_days").notNull().default(14),
  // Flat $ paid when a commercial client is self-sourced by the VA.
  self_sourced_bonus: numeric("self_sourced_bonus", { precision: 12, scale: 2 }).notNull().default("100"),
  // Flat $ paid when a VA lands N qualifying weekly/biweekly clients in a month.
  performance_bonus_amount: numeric("performance_bonus_amount", { precision: 12, scale: 2 }).notNull().default("100"),
  performance_bonus_threshold: integer("performance_bonus_threshold").notNull().default(5),
  // Share of specialty-service revenue paid as a bonus (0.05 = 5%).
  specialty_bonus_rate: numeric("specialty_bonus_rate", { precision: 6, scale: 4 }).notNull().default("0.05"),
  payout_schedule: text("payout_schedule").notNull().default("monthly"),
  effective_date: date("effective_date").notNull(),
  end_date: date("end_date"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

// ── commission_rate_card ─────────────────────────────────────────────────────
// [ares-parity] The flat-dollar base rate for one (client_type, cadence) pair.
// This is what Ares actually pays and is the primary pricing source.
//
// `cadence` is TEXT, not recurring_cadence, on purpose: the Ares rate table
// includes cadences the recurring_cadence enum does not carry yet
// (every_5_weeks, quarterly). Keeping it text lets the rate card price a
// cadence before the enum grows, instead of blocking on a migration.
// An unmatched (client_type, cadence) pays $0 — same as Ares.
export const commissionRateCardTable = pgTable("commission_rate_card", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  commission_policy_id: integer("commission_policy_id").references(() => commissionPolicyTable.id),
  client_type: recurringClientTypeEnum("client_type").notNull(),
  cadence: text("cadence").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  effective_date: date("effective_date").notNull(),
  end_date: date("end_date"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  // One live rate per (company, branch, type, cadence, effective_date).
  uniqRate: unique("commission_rate_card_uniq").on(
    t.company_id, t.branch_id, t.client_type, t.cadence, t.effective_date,
  ),
}));

// ── commission_payments ──────────────────────────────────────────────────────
// A payout run for one VA over one period. IDEMPOTENT: idempotency_key
// (company:va:period) is UNIQUE, so re-running a period can never double-pay.
// total_amount + item_count are a snapshot for display; the source of truth is
// the set of commissions whose payment_id points here.
export const commissionPaymentsTable = pgTable("commission_payments", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  va_user_id: integer("va_user_id").references(() => usersTable.id).notNull(),
  // [ares-parity] Name snapshot, so a historic receipt reads correctly even if
  // the user is renamed or deactivated.
  va_name: text("va_name"),
  period_start: date("period_start").notNull(),
  period_end: date("period_end").notNull(),
  // Human label for the earning window, e.g. "July 2026 sales".
  sales_period: text("sales_period"),
  // NET of confirmed chargebacks — what the VA is actually paid.
  total_amount: numeric("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  // Gross before chargebacks, and the chargeback total netted out of it.
  gross_amount: numeric("gross_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  chargeback_total: numeric("chargeback_total", { precision: 12, scale: 2 }).notNull().default("0"),
  // [ares-parity FIX] When chargebacks exceed the payout, Ares announced the
  // carryover in an email and then dropped it — the recouped rows were already
  // consumed, so the excess was silently forgiven. Persisting it here means the
  // next run can actually collect it.
  carryover_amount: numeric("carryover_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  // Set when a later payout run actually collects the carryover above.
  carryover_collected_at: timestamp("carryover_collected_at"),
  item_count: integer("item_count").notNull().default(0),
  status: text("status").notNull().default("processed"),   // processed | void
  idempotency_key: text("idempotency_key").notNull(),
  // PHR-YYYY-MM-NNN
  receipt_number: text("receipt_number"),
  payment_method: text("payment_method"),                  // PayPal | Zelle | Payoneer
  // Snapshot of the netted chargeback detail at run time.
  payment_details: jsonb("payment_details"),
  notes: text("notes"),
  processed_by: integer("processed_by").references(() => usersTable.id),
  processed_at: timestamp("processed_at").notNull().defaultNow(),
}, (t) => ({
  // The load-bearing anti-double-pay guard.
  uniqIdem: unique("commission_payments_idem_uniq").on(t.company_id, t.idempotency_key),
}));

// ── commissions ──────────────────────────────────────────────────────────────
// One earned commission line item for one VA. Under the Ares flat-rate model the
// amount is reproducible as base_amount + source_bonus_amount +
// specialty_bonus_amount; the rate card row that priced it is snapshotted via
// rate_card_id so a historic line is explainable by the rates in force THEN.
//
// subscription_id is NULLABLE: a performance bonus is earned against a MONTH of
// activity, not a single subscription.
export const commissionsTable = pgTable("commissions", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  subscription_id: integer("subscription_id").references(() => recurringSubscriptionsTable.id),
  client_id: integer("client_id").references(() => clientsTable.id),
  // [ares-parity] Name snapshot — Ares dedupes new commissions on
  // lower(client_name) + va, and a receipt must read correctly forever.
  client_name: text("client_name"),
  // The VA earning the credit (a Qleno user with role 'VA').
  va_user_id: integer("va_user_id").references(() => usersTable.id).notNull(),
  va_name: text("va_name"),
  status: salesCommissionStatusEnum("status").notNull().default("earned"),
  commission_type: salesCommissionTypeEnum("commission_type").notNull().default("base"),
  // Snapshot of what was true at earn time — a later cadence or type change
  // must not silently re-price a line that already exists.
  client_type: recurringClientTypeEnum("client_type"),
  cadence: text("cadence"),
  // ── amount composition (flat-rate model) ──
  base_amount: numeric("base_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  source_bonus_amount: numeric("source_bonus_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  specialty_bonus_amount: numeric("specialty_bonus_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  // Specialty bonus inputs: 5% of this revenue, for this service.
  specialty_service_type: text("specialty_service_type"),
  revenue_amount: numeric("revenue_amount", { precision: 12, scale: 2 }),
  // ── percentage model (reserved, unused by the Ares engine) ──
  mrr_basis: numeric("mrr_basis", { precision: 12, scale: 2 }),
  commission_rate: numeric("commission_rate", { precision: 6, scale: 4 }),
  commission_policy_id: integer("commission_policy_id").references(() => commissionPolicyTable.id),
  rate_card_id: integer("rate_card_id").references(() => commissionRateCardTable.id),
  earned_date: date("earned_date"),
  // The client's first cleaning — drives BOTH the chargeback clock and which
  // payout period the line falls into (payout month M pays first-cleans in M-1).
  first_cleaning_date: date("first_cleaning_date"),
  // End of the clawback window (first_cleaning_date + policy window).
  // NULL = exempt (commercial).
  chargeback_until: date("chargeback_until"),
  // Set when a loss triggers a clawback: the VA has until this date to dispute.
  chargeback_dispute_deadline: date("chargeback_dispute_deadline"),
  chargeback_date: date("chargeback_date"),
  // Computed live from the subscription's uploaded agreement in Ares; stored
  // here and refreshed on read so an approval queue can sort on it.
  service_agreement_verified: boolean("service_agreement_verified").notNull().default(false),
  ineligibility_category: commissionIneligibilityCategoryEnum("ineligibility_category"),
  ineligibility_reason: text("ineligibility_reason"),
  // Returning-client detection: set when the client had cancelled >= 90 days ago.
  reactivation_date: date("reactivation_date"),
  days_inactive: integer("days_inactive"),
  notes: text("notes"),
  approved_by: integer("approved_by").references(() => usersTable.id),
  approved_at: timestamp("approved_at"),
  paid_date: date("paid_date"),
  // Set when a payout run pays this line — the join that makes payout totals
  // reproducible from line items.
  payment_id: integer("payment_id").references(() => commissionPaymentsTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

// ── commission_status_events ─────────────────────────────────────────────────
// IMMUTABLE, append-only audit of every state transition (who, when, from→to,
// note). No updated_at — rows are never edited. This is how we answer "why was
// this VA paid $555" six months from now.
export const commissionStatusEventsTable = pgTable("commission_status_events", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  commission_id: integer("commission_id").references(() => commissionsTable.id).notNull(),
  from_status: salesCommissionStatusEnum("from_status"),   // null on the initial 'earned'
  to_status: salesCommissionStatusEnum("to_status").notNull(),
  actor_user_id: integer("actor_user_id").references(() => usersTable.id),
  note: text("note"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

// ── commission_ledger ────────────────────────────────────────────────────────
// [ares-parity] Signed money movements. A status flip says WHAT a line is; the
// ledger says how much money moved, when, and why. Career earnings, chargeback
// exposure and VA statements all sum this, not the commission rows — an
// adjustment (frequency upgrade/downgrade) moves money without creating a line.
//
// Sign convention: positive = owed to the VA, negative = clawed back.
export const commissionLedgerTable = pgTable("commission_ledger", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  commission_id: integer("commission_id").references(() => commissionsTable.id),
  subscription_id: integer("subscription_id").references(() => recurringSubscriptionsTable.id),
  client_id: integer("client_id").references(() => clientsTable.id),
  va_user_id: integer("va_user_id").references(() => usersTable.id).notNull(),
  entry_type: commissionLedgerEntryTypeEnum("entry_type").notNull(),
  // SIGNED. Negative for chargebacks and downgrade adjustments.
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  description: text("description").notNull(),
  metadata: jsonb("metadata"),
  // YYYY-MM the entry belongs to, for statement bucketing.
  related_period: text("related_period"),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

// ── commission_chargebacks ───────────────────────────────────────────────────
// A clawback event: client cancelled inside the chargeback window, so an
// approved/paid commission is reversed. Kept as its own record (not just a
// status flip) so the reversal is itemized + auditable.
export const commissionChargebacksTable = pgTable("commission_chargebacks", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  commission_id: integer("commission_id").references(() => commissionsTable.id).notNull(),
  subscription_id: integer("subscription_id").references(() => recurringSubscriptionsTable.id),
  reason: text("reason"),
  clawback_amount: numeric("clawback_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  chargeback_date: date("chargeback_date").notNull(),
  // The 14-day dispute window this clawback was opened under.
  dispute_deadline: date("dispute_deadline"),
  // Set when the clawback is actually netted out of a payout run.
  recouped_payment_id: integer("recouped_payment_id").references(() => commissionPaymentsTable.id),
  recouped_at: timestamp("recouped_at"),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

// ── subscription_cadence_history ─────────────────────────────────────────────
// [ares-parity] Every cadence change on a subscription, with the commission
// adjustment it produced. Ares only wrote this row when the money delta was
// non-zero, which lost the history of same-price changes — here it is ALWAYS
// written and `adjustment_amount` carries the (possibly zero) delta.
export const subscriptionCadenceHistoryTable = pgTable("subscription_cadence_history", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  subscription_id: integer("subscription_id").references(() => recurringSubscriptionsTable.id).notNull(),
  previous_cadence: text("previous_cadence"),
  new_cadence: text("new_cadence").notNull(),
  // Signed commission delta this change produced. 0 = no money moved.
  adjustment_amount: numeric("adjustment_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  effective_date: timestamp("effective_date").notNull().defaultNow(),
  changed_by: integer("changed_by").references(() => usersTable.id),
  reason: text("reason"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});
