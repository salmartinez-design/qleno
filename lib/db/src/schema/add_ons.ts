import { pgTable, serial, integer, text, boolean, numeric, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const addonCategoryEnum = pgEnum("addon_category", [
  "deep_clean", "inside_fridge", "inside_oven", "windows", "laundry", "organizing", "other",
]);

export const addOnsTable = pgTable("add_ons", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  category: addonCategoryEnum("category").notNull().default("other"),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type AddOn = typeof addOnsTable.$inferSelect;
