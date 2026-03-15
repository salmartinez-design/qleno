import { pgTable, serial, text, integer, boolean, numeric, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const quoteScopesTable = pgTable("quote_scopes", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  category: text("category").notNull().default("house_cleaning"),
  pricing_method: text("pricing_method").notNull().default("sqft"),
  base_hourly_rate: numeric("base_hourly_rate", { precision: 10, scale: 2 }).notNull().default("65"),
  min_bill_rate: numeric("min_bill_rate", { precision: 10, scale: 2 }).notNull().default("180"),
  available_office: boolean("available_office").notNull().default(true),
  available_online: boolean("available_online").notNull().default(false),
  sort_order: integer("sort_order").notNull().default(0),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const quoteScopeFrequenciesTable = pgTable("quote_scope_frequencies", {
  id: serial("id").primaryKey(),
  scope_id: integer("scope_id").references(() => quoteScopesTable.id, { onDelete: "cascade" }).notNull(),
  frequency: text("frequency").notNull(),
  factor: numeric("factor", { precision: 6, scale: 3 }).notNull().default("1"),
  min_cost: numeric("min_cost", { precision: 10, scale: 2 }),
  hourly_rate_override: numeric("hourly_rate_override", { precision: 10, scale: 2 }),
  available_office: boolean("available_office").notNull().default(true),
  available_online: boolean("available_online").notNull().default(false),
  sort_order: integer("sort_order").notNull().default(0),
});

export const quoteSqftTableEntry = pgTable("quote_sqft_table", {
  id: serial("id").primaryKey(),
  scope_id: integer("scope_id").references(() => quoteScopesTable.id, { onDelete: "cascade" }).notNull(),
  sqft_min: integer("sqft_min").notNull(),
  sqft_max: integer("sqft_max"),
  estimated_hours: numeric("estimated_hours", { precision: 6, scale: 2 }).notNull(),
});

export const quoteAddonsTable = pgTable("quote_addons", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  scope_id: integer("scope_id").references(() => quoteScopesTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  addon_type: text("addon_type").notNull().default("cleaning_extra"),
  price_type: text("price_type").notNull().default("flat"),
  price_value: numeric("price_value", { precision: 10, scale: 2 }).notNull().default("0"),
  time_minutes: integer("time_minutes").notNull().default(0),
  tech_pay: boolean("tech_pay").notNull().default(true),
  available_office: boolean("available_office").notNull().default(true),
  available_portal: boolean("available_portal").notNull().default(false),
  sort_order: integer("sort_order").notNull().default(0),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type QuoteScope = typeof quoteScopesTable.$inferSelect;
export type QuoteScopeFrequency = typeof quoteScopeFrequenciesTable.$inferSelect;
export type QuoteSqftEntry = typeof quoteSqftTableEntry.$inferSelect;
export type QuoteAddon = typeof quoteAddonsTable.$inferSelect;
