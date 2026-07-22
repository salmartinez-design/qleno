import { pgTable, serial, integer, text, numeric, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { referralSourceEnum } from "./clients";

// [lead-pipeline-foundation 2026-06-25] Drizzle definitions for the lead
// pipeline. These tables were previously created ONLY by the boot-time raw-SQL
// migrations (phes-data-migration.ts), so they had no typed Drizzle model and
// drifted from what routes/leads.ts actually reads. This file makes the schema
// the source of truth and matches the live production columns exactly.
//
// No FK constraints exist on these tables in prod (company_id scoping is
// enforced in the routes, mirroring the `quotes`/`estimates` pattern). The
// .references() below are schema-level documentation only — the migrations
// never emit the constraints — and are kept minimal to reflect that reality.
//
// Canonical lead stages (leads.status): needs_contacted, contacted, quoted,
// follow_up, booked, no_response, not_interested.
export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  // Contact
  first_name: text("first_name"),
  last_name: text("last_name"),
  phone: text("phone"),
  email: text("email"),
  // Property / intake
  sqft: integer("sqft"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  scope: text("scope"),
  bedrooms: integer("bedrooms"),
  bathrooms: integer("bathrooms"),
  message: text("message"),
  condition_flag: text("condition_flag"),
  construction_type: text("construction_type"),
  completion_date: text("completion_date"),
  lead_type: text("lead_type").default("standard"),
  notes: text("notes"),
  // [quote-details-carry 2026-07-07] Snapshot of the widget quote form
  // (bedrooms/bathrooms/sqft/frequency/add_ons/referral_source/step_reached)
  // merged in by upsertWidgetLead. Live column added via ADD COLUMN IF NOT
  // EXISTS in runStartupMigrations.
  details: jsonb("details"),
  // Pipeline state
  status: text("status").default("needs_contacted"),
  source: text("source"),
  // [lead-referral-source 2026-07-22] HOW they heard about us (discovery),
  // distinct from `source` above which is HOW THEY ENTERED (entry channel).
  // Reuses the existing referral_source enum already on clients — the booking
  // widget has been collecting this into details.referral_source all along.
  referral_source: referralSourceEnum("referral_source"),
  assigned_to: integer("assigned_to"),
  referral_partner_id: integer("referral_partner_id"),
  quote_amount: numeric("quote_amount", { precision: 10, scale: 2 }),
  // Lifecycle stamps
  contacted_at: timestamp("contacted_at"),
  contacted_by: integer("contacted_by"),
  quoted_at: timestamp("quoted_at"),
  booked_at: timestamp("booked_at"),
  closed_reason: text("closed_reason"),
  agreement_signed: boolean("agreement_signed"),
  job_id: integer("job_id"),
  // [lead-booked-wiring 2026-07-08] The client this lead became when its quote
  // converted. Lets the lead panel link to the customer + surface their comms
  // once booked. Stamped by advanceLeadStage(..., { clientId }).
  client_id: integer("client_id"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at"),
});

// Per-lead activity timeline (status changes, notes, calls). Written by
// routes/leads.ts and lib/lead-sync.ts.
export const leadActivityLogTable = pgTable("lead_activity_log", {
  id: serial("id").primaryKey(),
  lead_id: integer("lead_id").references(() => leadsTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  action_type: text("action_type").notNull(),
  note: text("note"),
  performed_by: integer("performed_by"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertLeadSchema = createInsertSchema(leadsTable).omit({ id: true, created_at: true, updated_at: true });
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
export type LeadActivity = typeof leadActivityLogTable.$inferSelect;
