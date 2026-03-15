import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";

export const clientNotificationsTable = pgTable("client_notifications", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id).notNull(),
  contact_value: text("contact_value").notNull(),
  contact_type: text("contact_type").notNull(),
  triggers: text("triggers").array().notNull().default([]),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertClientNotificationSchema = createInsertSchema(clientNotificationsTable).omit({ id: true, created_at: true });
export type InsertClientNotification = z.infer<typeof insertClientNotificationSchema>;
export type ClientNotification = typeof clientNotificationsTable.$inferSelect;
