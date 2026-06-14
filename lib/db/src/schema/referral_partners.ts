import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";

// First-class referral partner per tenant — the people/orgs who send leads
// (realtors, property managers, past clients, chambers, etc.). Leads attribute
// to a partner via leads.referral_partner_id; leads.source stays the generic
// channel. A past-client partner can link to a client_id to fold the existing
// customer-referral data in.
export const referralPartnersTable = pgTable("referral_partners", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  type: text("type").notNull().default("other"), // realtor|property_mgr|past_client|chamber|other
  contact_name: text("contact_name"),
  contact_email: text("contact_email"),
  contact_phone: text("contact_phone"),
  client_id: integer("client_id").references(() => clientsTable.id),
  notes: text("notes"),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertReferralPartnerSchema = createInsertSchema(referralPartnersTable).omit({ id: true, created_at: true });
export type InsertReferralPartner = z.infer<typeof insertReferralPartnerSchema>;
export type ReferralPartner = typeof referralPartnersTable.$inferSelect;
