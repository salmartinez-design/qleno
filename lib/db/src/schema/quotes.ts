import { pgTable, serial, text, integer, timestamp, numeric, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";
import { quoteScopesTable } from "./quote_scopes";

export const quotesTable = pgTable("quotes", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id),
  lead_name: text("lead_name"),
  lead_email: text("lead_email"),
  lead_phone: text("lead_phone"),
  address: text("address"),
  service_type: text("service_type"),
  frequency: text("frequency"),
  estimated_hours: numeric("estimated_hours", { precision: 4, scale: 2 }),
  base_price: numeric("base_price", { precision: 10, scale: 2 }),
  status: text("status").notNull().default("draft"),
  sent_at: timestamp("sent_at"),
  viewed_at: timestamp("viewed_at"),
  accepted_at: timestamp("accepted_at"),
  booked_job_id: integer("booked_job_id").references(() => jobsTable.id),
  notes: text("notes"),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
  scope_id: integer("scope_id").references(() => quoteScopesTable.id),
  pricing_method: text("pricing_method"),
  addons: jsonb("addons").default([]),
  discount_code: text("discount_code"),
  discount_amount: numeric("discount_amount", { precision: 10, scale: 2 }).default("0"),
  total_price: numeric("total_price", { precision: 10, scale: 2 }),
  bedrooms: integer("bedrooms"),
  bathrooms: integer("bathrooms"),
  half_baths: integer("half_baths"),
  sqft: integer("sqft"),
  dirt_level: text("dirt_level").default("standard"),
  pets: integer("pets").default(0),
  special_instructions: text("special_instructions"),
  internal_memo: text("internal_memo"),
  client_notes: text("client_notes"),
  manual_hours: numeric("manual_hours", { precision: 6, scale: 2 }),
  expires_at: timestamp("expires_at"),
  sign_token: text("sign_token"),
});

export const insertQuoteSchema = createInsertSchema(quotesTable).omit({ id: true, created_at: true });
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotesTable.$inferSelect;
