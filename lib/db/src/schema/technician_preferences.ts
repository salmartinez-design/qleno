import { pgTable, serial, text, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const techPrefEnum = pgEnum("tech_preference", ["preferred", "do_not_schedule", "neutral"]);

export const technicianPreferencesTable = pgTable("technician_preferences", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  // [tech-pref-accounts 2026-07-21] A preference is scoped to EITHER a client
  // (residential) OR a commercial account — exactly one is set. client_id was
  // NOT NULL originally; relaxed to nullable so an account-scoped row (the
  // "only send Rossy to this account" case) can carry account_id instead.
  client_id: integer("client_id").references(() => clientsTable.id),
  account_id: integer("account_id"),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  preference: techPrefEnum("preference").notNull(),
  notes: text("notes"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertTechPrefSchema = createInsertSchema(technicianPreferencesTable).omit({ id: true, created_at: true });
export type InsertTechPref = z.infer<typeof insertTechPrefSchema>;
export type TechnicianPreference = typeof technicianPreferencesTable.$inferSelect;
