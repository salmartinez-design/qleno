import { pgTable, serial, text, integer, timestamp, numeric, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";

export const propertyTypeEnum = pgEnum("property_type", [
  "apartment", "condo", "office", "common_area", "other",
]);

export const accountPropertiesTable = pgTable("account_properties", {
  id: serial("id").primaryKey(),
  account_id: integer("account_id").references(() => accountsTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  property_name: text("property_name").notNull(),
  address: text("address").notNull(),
  unit_count: integer("unit_count"),
  property_type: propertyTypeEnum("property_type").notNull().default("other"),
  lat: numeric("lat", { precision: 10, scale: 7 }),
  lng: numeric("lng", { precision: 10, scale: 7 }),
  zone_id: integer("zone_id"),
  is_active: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertAccountPropertySchema = createInsertSchema(accountPropertiesTable).omit({ id: true, created_at: true });
export type InsertAccountProperty = z.infer<typeof insertAccountPropertySchema>;
export type AccountProperty = typeof accountPropertiesTable.$inferSelect;
