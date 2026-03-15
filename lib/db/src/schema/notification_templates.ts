import { pgTable, serial, integer, text, boolean, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const notificationChannelEnum = pgEnum("notification_channel", ["email", "sms", "in_app"]);

export const notificationTemplatesTable = pgTable("notification_templates", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  trigger: text("trigger").notNull(),
  channel: notificationChannelEnum("channel").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const notificationLogTable = pgTable("notification_log", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  recipient: text("recipient").notNull(),
  channel: text("channel"),
  trigger: text("trigger"),
  status: text("status").notNull().default("sent"),
  metadata: jsonb("metadata"),
  sent_at: timestamp("sent_at").notNull().defaultNow(),
});

export const insertNotificationTemplateSchema = createInsertSchema(notificationTemplatesTable).omit({ id: true, created_at: true });
export type InsertNotificationTemplate = z.infer<typeof insertNotificationTemplateSchema>;
export type NotificationTemplate = typeof notificationTemplatesTable.$inferSelect;
