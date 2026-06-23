import { pgTable, serial, text, integer, timestamp, pgEnum, boolean, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active", "past_due", "canceled", "trialing"
]);

export const planEnum = pgEnum("plan", [
  "starter", "growth", "enterprise"
]);

export const payCadenceEnum = pgEnum("pay_cadence", [
  "weekly", "biweekly", "semimonthly"
]);

export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo_url: text("logo_url"),
  stripe_customer_id: text("stripe_customer_id"),
  stripe_subscription_id: text("stripe_subscription_id"),
  square_oauth_token: text("square_oauth_token"),
  subscription_status: subscriptionStatusEnum("subscription_status").notNull().default("trialing"),
  plan: planEnum("plan").notNull().default("starter"),
  employee_count: integer("employee_count").notNull().default(0),
  pay_cadence: payCadenceEnum("pay_cadence").notNull().default("weekly"),
  geo_fence_threshold_ft: integer("geo_fence_threshold_ft").notNull().default(500),
  geofence_enabled: boolean("geofence_enabled").notNull().default(true),
  geofence_clockin_radius_ft: integer("geofence_clockin_radius_ft").notNull().default(500),
  geofence_clockout_radius_ft: integer("geofence_clockout_radius_ft").notNull().default(1000),
  geofence_override_allowed: boolean("geofence_override_allowed").notNull().default(true),
  geofence_soft_mode: boolean("geofence_soft_mode").notNull().default(false),
  // [after-photo-gate 2026-06-09] When true, a tech cannot clock out of a job
  // until at least one "after" photo is uploaded. Default OFF — most shops
  // don't want to block clock-out on photos. Owner toggles in Clock In/Out
  // settings; enforced both client-side (my-jobs) and server-side (clock-out).
  require_after_photo_for_clockout: boolean("require_after_photo_for_clockout").notNull().default(false),
  // [gps-flag] When true, the dispatch panel flags clock punches that captured
  // no GPS coordinates ("GPS unavailable"). Office can turn it off here.
  flag_missing_gps: boolean("flag_missing_gps").notNull().default(true),
  brand_color: text("brand_color").notNull().default("#00C9A7"),
  sms_on_my_way_enabled: boolean("sms_on_my_way_enabled").notNull().default(true),
  sms_arrived_enabled: boolean("sms_arrived_enabled").notNull().default(false),
  sms_paused_enabled: boolean("sms_paused_enabled").notNull().default(false),
  sms_complete_enabled: boolean("sms_complete_enabled").notNull().default(true),
  twilio_from_number: text("twilio_from_number"),
  // [ghl-estimate-bridge 2026-06-10] GoHighLevel inbound-webhook URLs for the
  // estimate follow-up drip. Opt-in: the bridge only fires when a URL is set
  // (pasting the URL IS the explicit enable). Sent fires on estimate send;
  // outcome fires on accept/decline so GHL can stop the drip. These are
  // outbound integration events to the tenant's own CRM — Qleno's
  // COMMS_ENABLED gate (Twilio/Resend suppression) does not apply.
  ghl_estimate_sent_webhook: text("ghl_estimate_sent_webhook"),
  ghl_estimate_outcome_webhook: text("ghl_estimate_outcome_webhook"),
  default_payment_terms_residential: text("default_payment_terms_residential").default("due_on_receipt"),
  default_payment_terms_commercial: text("default_payment_terms_commercial").default("net_30"),
  // [pay-matrix 2026-04-29] Tenant defaults inherited by every new
  // employee's per-employee pay matrix. type is 'commission' or
  // 'hourly'; rate is fraction (0.35) when commission, dollars/hour
  // (20.00) when hourly. Phes defaults: residential commission 0.35,
  // commercial hourly $20.
  default_residential_pay_type: text("default_residential_pay_type").default("commission"),
  default_residential_pay_rate: numeric("default_residential_pay_rate", { precision: 8, scale: 4 }).default("0.35"),
  default_commercial_pay_type:  text("default_commercial_pay_type").default("hourly"),
  default_commercial_pay_rate:  numeric("default_commercial_pay_rate",  { precision: 8, scale: 4 }).default("20.0000"),
  default_invoice_notes_residential: text("default_invoice_notes_residential"),
  default_invoice_notes_commercial: text("default_invoice_notes_commercial"),
  // [invoice-branding 2026-06-23] Per-tenant invoice header/footer/terms content.
  invoice_business_name: text("invoice_business_name"),
  invoice_tagline: text("invoice_tagline"),
  invoice_address: text("invoice_address"),
  invoice_footer_message: text("invoice_footer_message"),
  invoice_payment_instructions: text("invoice_payment_instructions"),
  invoice_guarantee: text("invoice_guarantee"),
  invoice_terms: text("invoice_terms"),
  auto_send_invoices: boolean("auto_send_invoices").notNull().default(false),
  auto_charge_on_invoice: boolean("auto_charge_on_invoice").notNull().default(false),
  annual_revenue_goal: integer("annual_revenue_goal"),
  payment_terms_days: integer("payment_terms_days").notNull().default(0),
  mileage_rate: numeric("mileage_rate", { precision: 6, scale: 4 }).notNull().default("0.7250"),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  business_hours: text("business_hours"),
  booking_policies: text("booking_policies"),
  online_booking_lead_hours: integer("online_booking_lead_hours").notNull().default(48),
  dispatch_start_hour: integer("dispatch_start_hour").notNull().default(8),
  dispatch_end_hour: integer("dispatch_end_hour").notNull().default(18),
  invoice_sequence_start: integer("invoice_sequence_start").notNull().default(1),
  qb_access_token: text("qb_access_token"),
  qb_refresh_token: text("qb_refresh_token"),
  qb_realm_id: text("qb_realm_id"),
  qb_token_expires_at: timestamp("qb_token_expires_at"),
  qb_connected: boolean("qb_connected").notNull().default(false),
  qb_last_sync_at: timestamp("qb_last_sync_at"),
  qb_company_name: text("qb_company_name"),
  overhead_rate_pct: numeric("overhead_rate_pct", { precision: 5, scale: 2 }).default("10.00"),
  recurring_engine_enabled: boolean("recurring_engine_enabled").notNull().default(true),
  // Cancellation policy — per-tenant defaults. Both expressed as a
  // percentage of the cancelled job's effective amount (billed_amount ||
  // base_fee). Phes default is 100% on both — a true cancellation or
  // lockout charges the full visit fee. Per-client overrides live on
  // clients.cancel_fee_pct / clients.lockout_fee_pct.
  default_cancel_fee_pct: numeric("default_cancel_fee_pct", { precision: 5, scale: 2 }).notNull().default("100.00"),
  default_lockout_fee_pct: numeric("default_lockout_fee_pct", { precision: 5, scale: 2 }).notNull().default("100.00"),
  // [cancel-fee-flat 2026-06-17] Optional FLAT cancellation/lockout fee ($).
  // When > 0 it overrides the percentage above, so a tenant can bill either a
  // flat rate or a % of the job cost. 0 = use the percentage.
  default_cancel_fee_flat: numeric("default_cancel_fee_flat", { precision: 10, scale: 2 }).notNull().default("0"),
  default_lockout_fee_flat: numeric("default_lockout_fee_flat", { precision: 10, scale: 2 }).notNull().default("0"),
  // Tech-pay-on-cancellation policy. When a charging action (cancel /
  // lockout) fires we still owe the assigned tech(s) something — they
  // showed up. Two modes:
  //   'flat'    — fixed dollar amount per cancellation, regardless of job
  //               size. Phes default $60 (matches the cleanup-trip fee
  //               techs were historically paid in the old MC system).
  //   'percent' — percentage of the customer charge_amount. Lets a tenant
  //               say "tech keeps 40% of whatever we collected".
  // The amount field is interpreted by the mode: dollars when 'flat',
  // percentage (0-100) when 'percent'. Total pay is split equally across
  // the assigned tech(s); proportional-by-clock-in doesn't apply because
  // nobody worked.
  cancellation_tech_pay_mode: text("cancellation_tech_pay_mode").notNull().default("flat"),
  cancellation_tech_pay_amount: numeric("cancellation_tech_pay_amount", { precision: 10, scale: 4 }).notNull().default("60.0000"),
  // [overtime 2026-06-04] Jurisdiction-aware overtime config. Out of the box
  // every tenant runs the federal/most-state baseline (weekly-40, 1.5×), so
  // Qleno is compliant by default no matter where they operate. Daily-overtime
  // states (CA/AK/CO/NV…) are opt-in via the state preset seeded from
  // companies.state on cold-start, and any field is owner-overridable here.
  // null daily columns = "no daily overtime" (the common case). See
  // lib/overtime.ts + docs/OVERTIME_COMPLIANCE_DESIGN.md. Computed overtime is
  // a REVIEW SIGNAL — it never auto-moves money.
  //   ot_rules_source: null = not yet configured → fall back to state preset;
  //     'preset:<state>' = seeded from state; 'custom' = owner-edited.
  ot_rules_source: text("ot_rules_source"),
  ot_weekly_threshold_hours: numeric("ot_weekly_threshold_hours", { precision: 5, scale: 2 }).default("40.00"),
  ot_daily_threshold_hours: numeric("ot_daily_threshold_hours", { precision: 5, scale: 2 }),
  ot_daily_doubletime_hours: numeric("ot_daily_doubletime_hours", { precision: 5, scale: 2 }),
  ot_seventh_day_rule: boolean("ot_seventh_day_rule").notNull().default(false),
  ot_multiplier: numeric("ot_multiplier", { precision: 4, scale: 2 }).notNull().default("1.50"),
  ot_doubletime_multiplier: numeric("ot_doubletime_multiplier", { precision: 4, scale: 2 }).notNull().default("2.00"),
  // ── Post-job customer survey (scorecard input) — Company Settings → Customer
  //    Comms. Per-tenant. The SMS send is Twilio-gated and OFF until go-live. ──
  survey_enabled: boolean("survey_enabled").notNull().default(false),
  survey_message_template: text("survey_message_template").default(
    "Hi {{first_name}}, thanks for choosing us! How was your cleaning today? Tap to rate: {{survey_link}}",
  ),
  survey_send_after_hours: integer("survey_send_after_hours").notNull().default(0),
  // Per-tenant Twilio connection (Settings → Integrations). twilio_from_number
  // already exists above. twilio_enabled is the go-live gate — surveys/SMS only
  // actually send when this is true AND creds are set AND COMMS_ENABLED=true.
  twilio_enabled: boolean("twilio_enabled").notNull().default(false),
  // Per-TENANT comms master. ALL automatic send paths (follow-up cadence +
  // legacy reminder/review/survey notifications) require the SENDING record's
  // company.comms_enabled AND the global COMMS_ENABLED. Default OFF so enabling
  // one tenant can never message another tenant's customers.
  comms_enabled: boolean("comms_enabled").notNull().default(false),
  // Per-tenant send-from identity for outbound email (must be on a Resend-verified
  // domain). Falls back to a default when null. e.g. Schaumburg = schaumburg@phes.io.
  email_from_address: text("email_from_address"),
  // Internal/comped account — excluded from SaaS MRR/ARR/revenue metrics. Net $0,
  // no Stripe. Used for owner-comped tenants (e.g. PHES Schaumburg).
  is_internal: boolean("is_internal").notNull().default(false),
  // Per-tenant routing for the internal "New Lead" office alert. The alert is
  // sent TO lead_notify_email (FROM email_from_address) and, when set, an SMS
  // TO lead_notify_phone (FROM the tenant's own number via resolveSender).
  // Distinct from companies.email (the tenant's public/from inbox) so alerts can
  // route to an owner's personal inbox without landing in the public mailbox.
  lead_notify_email: text("lead_notify_email"),
  lead_notify_phone: text("lead_notify_phone"),
  twilio_account_sid: text("twilio_account_sid"),
  twilio_auth_token: text("twilio_auth_token"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, created_at: true });
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
