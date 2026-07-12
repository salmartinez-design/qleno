import { pgTable, serial, text, integer, timestamp, numeric, date, pgEnum, unique } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";
import { recurringSubscriptionsTable } from "./recurring_subscriptions";

// [recurring-revenue 2026-07-12] VA SALES commission — paid to whoever SIGNED a
// recurring client. This is NOT Qleno's technician-pay commission
// (users.commission_rate_override / job_technicians.commission_pct, 35% of job
// value). Unrelated systems that share a word — this one does NOT touch payroll
// tables. All tables here are new + additive; nothing writes clients /
// recurring_schedules / jobs.
//
// Money-system invariants baked into the shape:
//   • Every aggregate $ is reproducible from line items — a payout's total is
//     the SUM of the commissions carrying its payment_id; a commission's amount
//     is mrr_basis × commission_rate. No bare stored totals.
//   • Every state transition writes an immutable row in commission_status_events.
//   • Payout runs are idempotent via commission_payments.idempotency_key.

// earned → pending_review → approved → paid, with rejected + charged_back exits.
export const salesCommissionStatusEnum = pgEnum("sales_commission_status", [
  "earned", "pending_review", "approved", "paid", "rejected", "charged_back",
]);

// ── commission_policy ────────────────────────────────────────────────────────
// Dated policy (mirrors mileage_rates): rate + chargeback window + payout
// schedule effective from a date, so a commission computed months ago is
// explainable by the policy in force THEN — never silently re-rated by today's.
export const commissionPolicyTable = pgTable("commission_policy", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  // Applied to the MRR basis to produce the commission amount (e.g. 0.1000).
  commission_rate: numeric("commission_rate", { precision: 6, scale: 4 }).notNull().default("0"),
  // Days after earned during which a client cancel claws the commission back.
  chargeback_window_days: integer("chargeback_window_days").notNull().default(90),
  // 'monthly' | 'biweekly' | … — cadence of payout runs.
  payout_schedule: text("payout_schedule").notNull().default("monthly"),
  effective_date: date("effective_date").notNull(),
  end_date: date("end_date"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

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
  period_start: date("period_start").notNull(),
  period_end: date("period_end").notNull(),
  total_amount: numeric("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  item_count: integer("item_count").notNull().default(0),
  status: text("status").notNull().default("processed"),   // processed | void
  idempotency_key: text("idempotency_key").notNull(),
  processed_by: integer("processed_by").references(() => usersTable.id),
  processed_at: timestamp("processed_at").notNull().defaultNow(),
}, (t) => ({
  // The load-bearing anti-double-pay guard.
  uniqIdem: unique("commission_payments_idem_uniq").on(t.company_id, t.idempotency_key),
}));

// ── commissions ──────────────────────────────────────────────────────────────
// One earned commission line item for one VA on one subscription. The amount is
// reproducible: mrr_basis × commission_rate (the rate snapshotted from the
// policy in force at earn time). payment_id links to the payout that paid it.
export const commissionsTable = pgTable("commissions", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  subscription_id: integer("subscription_id").references(() => recurringSubscriptionsTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id),
  // The VA earning the credit (a Qleno user with role 'VA').
  va_user_id: integer("va_user_id").references(() => usersTable.id).notNull(),
  status: salesCommissionStatusEnum("status").notNull().default("earned"),
  // The reproducible basis for `amount`.
  mrr_basis: numeric("mrr_basis", { precision: 12, scale: 2 }),
  commission_rate: numeric("commission_rate", { precision: 6, scale: 4 }),
  commission_policy_id: integer("commission_policy_id").references(() => commissionPolicyTable.id),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  earned_date: date("earned_date"),
  // End of the clawback window (earned_date + policy.chargeback_window_days).
  chargeback_until: date("chargeback_until"),
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
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});
