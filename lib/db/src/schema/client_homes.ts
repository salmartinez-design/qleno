import { pgTable, serial, text, integer, timestamp, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";

export const clientHomesTable = pgTable("client_homes", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id).notNull(),
  name: text("name"),
  address: text("address").notNull(),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  lat: numeric("lat", { precision: 10, scale: 8 }),
  lng: numeric("lng", { precision: 11, scale: 8 }),
  sq_footage: integer("sq_footage"),
  bedrooms: integer("bedrooms"),
  bathrooms: integer("bathrooms"),
  access_notes: text("access_notes"),
  alarm_code: text("alarm_code"),
  has_pets: boolean("has_pets").default(false),
  pet_notes: text("pet_notes"),
  parking_notes: text("parking_notes"),
  is_primary: boolean("is_primary").default(true),
  base_fee: numeric("base_fee", { precision: 10, scale: 2 }),
  allowed_hours: numeric("allowed_hours", { precision: 6, scale: 2 }),
  frequency: text("frequency"),
  service_type: text("service_type"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertClientHomeSchema = createInsertSchema(clientHomesTable).omit({ id: true, created_at: true });
export type InsertClientHome = z.infer<typeof insertClientHomeSchema>;
export type ClientHome = typeof clientHomesTable.$inferSelect;
