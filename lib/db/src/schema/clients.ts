import { pgTable, serial, text, integer, timestamp, numeric, boolean, date, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";

export const clientTypeEnum = pgEnum("client_type", ["residential", "commercial"]);
export const paymentTermsEnum = pgEnum("client_payment_terms", ["due_on_receipt", "net_15", "net_30"]);
// [invoicing-engine 2026-06-16] How invoicing behaves for the client:
//   per_visit (DEFAULT) — invoice auto-creates the moment a job completes.
//   batch_invoice        — per-visit invoices still generate per completion
//                          (draft, batch_status='pending'), then fold into the
//                          month's first invoice at the office consolidate step.
// Brand-new enum type → drizzle-kit push CREATEs it (push-safe, no pre-push-fix
// needed). Append-only if values are ever added later (never swap).
export const billingTermsEnum = pgEnum("billing_terms", ["per_visit", "batch_invoice"]);
export const referralSourceEnum = pgEnum("referral_source", [
  "google", "nextdoor", "facebook", "yelp", "client_referral",
  "door_hanger", "yard_sign", "website", "other",
]);

export const clientsTable = pgTable("clients", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  first_name: text("first_name").notNull(),
  last_name: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  company_name: text("company_name"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  lat: numeric("lat", { precision: 10, scale: 7 }),
  lng: numeric("lng", { precision: 10, scale: 7 }),
  notes: text("notes"),
  is_active: boolean("is_active").notNull().default(true),
  frequency: text("frequency"),
  service_type: text("service_type"),
  base_fee: numeric("base_fee", { precision: 10, scale: 2 }),
  allowed_hours: numeric("allowed_hours", { precision: 6, scale: 2 }),
  home_access_notes: text("home_access_notes"),
  alarm_code: text("alarm_code"),
  pets: text("pets"),
  loyalty_tier: text("loyalty_tier").notNull().default("standard"),
  client_since: date("client_since"),
  scorecard_avg: numeric("scorecard_avg", { precision: 3, scale: 2 }),
  rate_increase_last_date: date("rate_increase_last_date"),
  rate_increase_last_pct: numeric("rate_increase_last_pct", { precision: 5, scale: 2 }),
  qbo_customer_id: text("qbo_customer_id"),
  stripe_customer_id: text("stripe_customer_id"),
  square_customer_id: text("square_customer_id"),
  loyalty_points: integer("loyalty_points").notNull().default(0),
  portal_access: boolean("portal_access").default(false),
  portal_invite_token: text("portal_invite_token"),
  portal_invite_sent_at: timestamp("portal_invite_sent_at"),
  portal_last_login: timestamp("portal_last_login"),
  property_group_id: integer("property_group_id"),
  default_card_last_4: text("default_card_last_4"),
  default_card_brand: text("default_card_brand"),
  client_type: clientTypeEnum("client_type").notNull().default("residential"),
  // [commercial-category 2026-06-12] Sub-category for commercial clients
  // (Office, Condo/HOA Common Areas, Church, ...). Free text; the UI offers
  // a fixed top-10 list + Other. NULL for residential clients.
  commercial_category: text("commercial_category"),
  billing_contact_name: text("billing_contact_name"),
  billing_contact_email: text("billing_contact_email"),
  billing_contact_phone: text("billing_contact_phone"),
  po_number_required: boolean("po_number_required").notNull().default(false),
  default_po_number: text("default_po_number"),
  payment_terms: paymentTermsEnum("payment_terms").notNull().default("due_on_receipt"),
  auto_charge: boolean("auto_charge").notNull().default(false),
  card_last_four: text("card_last_four"),
  card_brand: text("card_brand"),
  card_expiry: text("card_expiry"),
  card_saved_at: timestamp("card_saved_at"),
  stripe_payment_method_id: text("stripe_payment_method_id"),
  payment_source: text("payment_source"),
  // [invoicing-engine 2026-06-16] per_visit (default) vs batch_invoice. See
  // billingTermsEnum above. Existing rows backfill to 'per_visit' via the NOT
  // NULL DEFAULT, preserving today's per-visit-on-completion behavior.
  billing_terms: billingTermsEnum("billing_terms").notNull().default("per_visit"),
  zone_id: integer("zone_id"),
  account_id: integer("account_id"),
  referral_source: referralSourceEnum("referral_source"),
  referral_by_customer_id: integer("referral_by_customer_id"),
  branch_id: integer("branch_id").references(() => branchesTable.id),
  // Office-editable payment method (distinct from payment_terms which drives invoice due dates)
  payment_method: text("payment_method").default("manual"),
  net_terms: integer("net_terms").default(0),
  // [AH] Per-client commercial hourly rate. Used by the edit-job modal for
  // single-location commercial clients (e.g. Jaira Estrada $50/hr). Null for
  // residential clients. Multi-location commercial accounts use
  // account_rate_cards instead — see KNOWN_BUGS.md.
  commercial_hourly_rate: numeric("commercial_hourly_rate", { precision: 10, scale: 2 }),
  // [PR #60] Per-client hourly rate. Drives the recurring-schedule editor's
  // Schedule Rate auto-calc (hourly_rate × allowed_hours = schedule_rate).
  // Distinct from commercial_hourly_rate (which is consumed by the
  // commission engine / edit-job modal commercial branch). Set for both
  // residential and commercial clients. Backfilled at cold-start from
  // base_fee / allowed_hours when null.
  hourly_rate: numeric("hourly_rate", { precision: 10, scale: 2 }),
  // Per-client parking-fee default. Schedule-level (recurring_schedules.
  // parking_fee_amount) and per-occurrence (job_add_ons.unit_price) overrides
  // both win over this. Enabled flag drives the pre-fill behavior in the
  // recurring-schedule editor and edit-job modal — actual stamping is gated
  // by recurring_schedules.parking_fee_enabled or a manual modal toggle.
  parking_fee_enabled: boolean("parking_fee_enabled").notNull().default(false),
  parking_fee_amount: numeric("parking_fee_amount", { precision: 10, scale: 2 }),
  // Cutover 1C — per-client opt-in/out for on-my-way SMS. Tenant-level
  // gating via companies.sms_on_my_way_enabled still wins; this is the
  // client's per-record preference. Default true (most clients want
  // the heads-up); office flips false when a specific client asks not
  // to receive them.
  wants_on_my_way_notifications: boolean("wants_on_my_way_notifications").notNull().default(true),
  // Cancellation policy overrides — NULL means "use the tenant default
  // from companies.default_{cancel,lockout}_fee_pct". Office can set per
  // client when negotiating exceptions (e.g. anchor commercial accounts
  // with a 0% no-fault clause).
  cancel_fee_pct: numeric("cancel_fee_pct", { precision: 5, scale: 2 }),
  lockout_fee_pct: numeric("lockout_fee_pct", { precision: 5, scale: 2 }),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertClientSchema = createInsertSchema(clientsTable).omit({ id: true, created_at: true });
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clientsTable.$inferSelect;
