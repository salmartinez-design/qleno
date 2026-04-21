import { pgTable, serial, integer, text, boolean, numeric, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const pricingScopesTable = pgTable("pricing_scopes", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  scope_group: text("scope_group").notNull().default("Residential"),
  pricing_method: text("pricing_method").notNull().default("sqft"),
  hourly_rate: numeric("hourly_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  minimum_bill: numeric("minimum_bill", { precision: 10, scale: 2 }).notNull().default("0"),
  displayed_for_office: boolean("displayed_for_office").notNull().default(true),
  show_online: boolean("show_online").notNull().default(true),
  is_active: boolean("is_active").notNull().default(true),
  sort_order: integer("sort_order").notNull().default(0),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const pricingTiersTable = pgTable("pricing_tiers", {
  id: serial("id").primaryKey(),
  scope_id: integer("scope_id").references(() => pricingScopesTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  min_sqft: integer("min_sqft").notNull(),
  max_sqft: integer("max_sqft").notNull(),
  hours: numeric("hours", { precision: 6, scale: 2 }).notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const pricingFrequenciesTable = pgTable("pricing_frequencies", {
  id: serial("id").primaryKey(),
  scope_id: integer("scope_id").references(() => pricingScopesTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  frequency: text("frequency").notNull(),
  rate_override: numeric("rate_override", { precision: 10, scale: 2 }),
  multiplier: numeric("multiplier", { precision: 6, scale: 4 }).notNull().default("1.0000"),
  label: text("label").notNull(),
  show_office: boolean("show_office").notNull().default(true),
  sort_order: integer("sort_order").notNull().default(0),
});

export const pricingAddonsTable = pgTable("pricing_addons", {
  id: serial("id").primaryKey(),
  scope_id: integer("scope_id").references(() => pricingScopesTable.id),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  addon_type: text("addon_type").notNull().default("cleaning_extras"),
  scope_ids: text("scope_ids").notNull().default("[]"),
  price: numeric("price", { precision: 10, scale: 2 }),
  price_type: text("price_type").notNull().default("flat"),
  price_value: numeric("price_value", { precision: 10, scale: 2 }).notNull().default("0"),
  percent_of_base: numeric("percent_of_base", { precision: 6, scale: 2 }),
  time_add_minutes: integer("time_add_minutes").notNull().default(0),
  time_unit: text("time_unit").notNull().default("each"),
  unit: text("unit").notNull().default("each"),
  is_itemized: boolean("is_itemized").notNull().default(true),
  is_taxed: boolean("is_taxed").notNull().default(false),
  show_office: boolean("show_office").notNull().default(true),
  show_online: boolean("show_online").notNull().default(true),
  show_portal: boolean("show_portal").notNull().default(true),
  is_active: boolean("is_active").notNull().default(true),
  sort_order: integer("sort_order").notNull().default(0),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const pricingDiscountsTable = pgTable("pricing_discounts", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  code: text("code").notNull(),
  description: text("description").notNull().default(""),
  discount_type: text("discount_type").notNull().default("flat"),
  discount_value: numeric("discount_value", { precision: 10, scale: 2 }).notNull(),
  scope_ids: text("scope_ids").notNull().default("[]"),
  frequency: text("frequency").notNull().default("one_time"),
  availability_office: boolean("availability_office").notNull().default(true),
  is_active: boolean("is_active").notNull().default(true),
  is_online: boolean("is_online").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const pricingFeeRulesTable = pgTable("pricing_fee_rules", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  rule_type: text("rule_type").notNull().default("custom"),
  label: text("label").notNull(),
  charge_percent: numeric("charge_percent", { precision: 6, scale: 2 }).notNull().default("100"),
  tech_split_percent: numeric("tech_split_percent", { precision: 6, scale: 2 }).notNull().default("0"),
  window_hours: integer("window_hours"),
  is_active: boolean("is_active").notNull().default(true),
});

export type PricingScope = typeof pricingScopesTable.$inferSelect;
export type PricingTier = typeof pricingTiersTable.$inferSelect;
export type PricingFrequency = typeof pricingFrequenciesTable.$inferSelect;
export type PricingAddon = typeof pricingAddonsTable.$inferSelect;
export type PricingDiscount = typeof pricingDiscountsTable.$inferSelect;
export type PricingFeeRule = typeof pricingFeeRulesTable.$inferSelect;
