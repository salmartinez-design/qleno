import { pgTable, serial, integer, text, boolean, numeric, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const supplyUnitEnum = pgEnum("supply_unit", ["oz", "lb", "each", "gallon", "liter", "bag"]);
export const supplyCategoryEnum = pgEnum("supply_category", [
  "chemical", "equipment", "consumable", "other",
]);

export const supplyItemsTable = pgTable("supply_items", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  unit: supplyUnitEnum("unit").notNull().default("each"),
  unit_cost: numeric("unit_cost", { precision: 10, scale: 4 }).notNull(),
  category: supplyCategoryEnum("category").notNull().default("other"),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type SupplyItem = typeof supplyItemsTable.$inferSelect;
