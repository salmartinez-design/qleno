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
  client_id: integer("client_id").references(() => clientsTable.id).notNull(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  preference: techPrefEnum("preference").notNull(),
  notes: text("notes"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertTechPrefSchema = createInsertSchema(technicianPreferencesTable).omit({ id: true, created_at: true });
export type InsertTechPref = z.infer<typeof insertTechPrefSchema>;
export type TechnicianPreference = typeof technicianPreferencesTable.$inferSelect;
