import { pgTable, serial, text, integer, timestamp, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { accountsTable } from "./accounts";
import { accountPropertiesTable } from "./account_properties";
import { clientsTable } from "./clients";

// [commercial-estimate-tool 2026-06-09] Dedicated estimate model, kept SEPARATE
// from the residential `quotes` builder (beds/baths/sqft/pets) so neither
// regresses the other. An estimate is a line-item document for commercial /
// common-area work: pick an account + property (or type a contact), add line
// items (flat / hourly / one-time), send via a hosted link + PDF, and follow up
// through GoHighLevel. Line items live in their own table; reusable templates
// mirror the same shape so an on-site walkthrough can start from a saved set.
export const estimatesTable = pgTable("estimates", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id"),
  // Recipient — a commercial account/property, an existing client, or a
  // free-typed contact (the property manager you met on a walkthrough).
  account_id: integer("account_id").references(() => accountsTable.id),
  account_property_id: integer("account_property_id").references(() => accountPropertiesTable.id),
  client_id: integer("client_id").references(() => clientsTable.id),
  contact_name: text("contact_name"),
  contact_email: text("contact_email"),       // primary recipient (To)
  // [multi-recipient-estimates 2026-06-25] Additional recipient emails (CC),
  // comma-separated + normalized. Every drip EMAIL touch goes To contact_email
  // and CCs all of these. SMS still goes to the primary mobile only.
  cc_emails: text("cc_emails"),
  contact_phone: text("contact_phone"),
  property_name: text("property_name"),
  service_address: text("service_address"),
  // Document body
  estimate_number: text("estimate_number"),
  title: text("title"),
  intro_note: text("intro_note"),
  terms: text("terms"),
  internal_notes: text("internal_notes"),
  status: text("status").notNull().default("draft"), // draft|sent|viewed|accepted|declined|expired
  // [estimate-flat-mode 2026-06-26] How the estimate is priced/shown:
  //   'itemized' (default) — line items each carry a price; total = sum.
  //   'flat'     — one price for the whole job; line items are scope only
  //                (name + frequency, no per-line price) and total = flat_price.
  billing_mode: text("billing_mode").notNull().default("itemized"),
  flat_price: numeric("flat_price", { precision: 12, scale: 2 }).notNull().default("0"),
  // [estimate-flat-clarity 2026-06-26] What the flat price is per (visit / week /
  // month / …) so the client sees "$150 / visit", and an optional free-text scope
  // paragraph for when the office would rather describe the work than itemize it.
  flat_price_unit: text("flat_price_unit").notNull().default("visit"),
  scope_note: text("scope_note"),
  // [estimate-industry 2026-06-26] Facility type for win-rate-by-industry reporting.
  facility_type: text("facility_type"),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull().default("0"),
  discount_amount: numeric("discount_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 12, scale: 2 }).notNull().default("0"),
  valid_until: timestamp("valid_until"),
  // Public hosted view (tokenized, no login) + lifecycle stamps
  public_token: text("public_token"),
  sent_at: timestamp("sent_at"),
  viewed_at: timestamp("viewed_at"),
  accepted_at: timestamp("accepted_at"),
  declined_at: timestamp("declined_at"),
  accepted_name: text("accepted_name"),
  // DEPRECATED [native-estimate-workflow 2026-06-25]: the GoHighLevel outbound
  // bridge was removed — the estimate workflow is now 100% native to Qleno.
  // Retained (harmless) for historical rows but no longer written or read.
  ghl_synced_at: timestamp("ghl_synced_at"),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const estimateLineItemsTable = pgTable("estimate_line_items", {
  id: serial("id").primaryKey(),
  estimate_id: integer("estimate_id").references(() => estimatesTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  sort_order: integer("sort_order").notNull().default(0),
  name: text("name"),
  description: text("description"),
  pricing_type: text("pricing_type").notNull().default("flat"), // flat|hourly|one_time
  frequency: text("frequency"), // "2x/week", "Monthly", "One-time", ...
  // quantity = hours when pricing_type='hourly', else a plain quantity (default 1)
  quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull().default("1"),
  unit_rate: numeric("unit_rate", { precision: 12, scale: 2 }).notNull().default("0"),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const estimateTemplatesTable = pgTable("estimate_templates", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  // [estimate-templates-phase2 2026-06-25] Optional vertical so the builder can
  // offer a one-click picker (common_areas | office | retail | medical | null).
  // null = a user-saved template with no fixed vertical.
  category: text("category"),
  title: text("title"),
  intro_note: text("intro_note"),
  terms: text("terms"),
  // [estimate-packages 2026-06-26] A "package" is a flat-price template: one
  // price + scope-only items. billing_mode mirrors estimates.billing_mode so
  // applying a package drops straight into the flat-price view.
  billing_mode: text("billing_mode").notNull().default("itemized"),
  flat_price: numeric("flat_price", { precision: 12, scale: 2 }).notNull().default("0"),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const estimateTemplateItemsTable = pgTable("estimate_template_items", {
  id: serial("id").primaryKey(),
  template_id: integer("template_id").references(() => estimateTemplatesTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  sort_order: integer("sort_order").notNull().default(0),
  name: text("name"),
  description: text("description"),
  pricing_type: text("pricing_type").notNull().default("flat"),
  frequency: text("frequency"),
  quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull().default("1"),
  unit_rate: numeric("unit_rate", { precision: 12, scale: 2 }).notNull().default("0"),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertEstimateSchema = createInsertSchema(estimatesTable).omit({ id: true, created_at: true, updated_at: true });
export type InsertEstimate = z.infer<typeof insertEstimateSchema>;
export type Estimate = typeof estimatesTable.$inferSelect;
export type EstimateLineItem = typeof estimateLineItemsTable.$inferSelect;
export type EstimateTemplate = typeof estimateTemplatesTable.$inferSelect;
