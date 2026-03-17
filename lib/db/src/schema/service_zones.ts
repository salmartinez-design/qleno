import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const serviceZonesTable = pgTable("service_zones", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  color: text("color").notNull().default("#5B9BD5"),
  zip_codes: text("zip_codes").array().notNull().default([]),
  is_active: boolean("is_active").notNull().default(true),
  sort_order: integer("sort_order").notNull().default(0),
  created_at: timestamp("created_at").notNull().defaultNow(),
});
