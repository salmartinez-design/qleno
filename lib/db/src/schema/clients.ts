import { pgTable, serial, text, integer, timestamp, numeric, boolean, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

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
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertClientSchema = createInsertSchema(clientsTable).omit({ id: true, created_at: true });
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clientsTable.$inferSelect;
