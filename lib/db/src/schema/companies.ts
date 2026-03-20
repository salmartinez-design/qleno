import { pgTable, serial, text, integer, timestamp, pgEnum, boolean } from "drizzle-orm/pg-core";
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
  pay_cadence: payCadenceEnum("pay_cadence").notNull().default("biweekly"),
  geo_fence_threshold_ft: integer("geo_fence_threshold_ft").notNull().default(500),
  geofence_enabled: boolean("geofence_enabled").notNull().default(true),
  geofence_clockin_radius_ft: integer("geofence_clockin_radius_ft").notNull().default(500),
  geofence_clockout_radius_ft: integer("geofence_clockout_radius_ft").notNull().default(1000),
  geofence_override_allowed: boolean("geofence_override_allowed").notNull().default(true),
  geofence_soft_mode: boolean("geofence_soft_mode").notNull().default(false),
  brand_color: text("brand_color").notNull().default("#00C9A7"),
  sms_on_my_way_enabled: boolean("sms_on_my_way_enabled").notNull().default(true),
  sms_arrived_enabled: boolean("sms_arrived_enabled").notNull().default(false),
  sms_paused_enabled: boolean("sms_paused_enabled").notNull().default(false),
  sms_complete_enabled: boolean("sms_complete_enabled").notNull().default(true),
  twilio_from_number: text("twilio_from_number"),
  default_payment_terms_residential: text("default_payment_terms_residential").default("due_on_receipt"),
  default_payment_terms_commercial: text("default_payment_terms_commercial").default("net_30"),
  default_invoice_notes_residential: text("default_invoice_notes_residential"),
  default_invoice_notes_commercial: text("default_invoice_notes_commercial"),
  auto_send_invoices: boolean("auto_send_invoices").notNull().default(false),
  auto_charge_on_invoice: boolean("auto_charge_on_invoice").notNull().default(false),
  annual_revenue_goal: integer("annual_revenue_goal"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, created_at: true });
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;
