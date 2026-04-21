import { pgTable, serial, integer, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const userSavedViewsTable = pgTable("user_saved_views", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  page: text("page").notNull(),
  name: text("name").notNull(),
  filter_json: text("filter_json").notNull().default("{}"),
  column_config_json: text("column_config_json").notNull().default("[]"),
  is_default: boolean("is_default").notNull().default(false),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const userColumnPreferencesTable = pgTable("user_column_preferences", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  page: text("page").notNull(),
  column_key: text("column_key").notNull(),
  visible: boolean("visible").notNull().default(true),
  sort_order: integer("sort_order").notNull().default(0),
}, (table) => [
  unique("uq_user_page_column").on(table.user_id, table.page, table.column_key),
]);

export type UserSavedView = typeof userSavedViewsTable.$inferSelect;
export type UserColumnPreference = typeof userColumnPreferencesTable.$inferSelect;
