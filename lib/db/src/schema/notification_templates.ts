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
  // [per-package-confirmation 2026-07-17] Optional service-type variant. NULL is
  // the default template used for every job; a non-null value (a jobs.service_type
  // slug like 'deep_clean' / 'move_out') is a package-specific override. The send
  // path picks the most-specific match (exact service_type, else the NULL default).
  service_type: text("service_type"),
  subject: text("subject"),
  body: text("body").notNull().default(""),
  body_html: text("body_html"),
  body_text: text("body_text"),
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
  error_message: text("error_message"),
  metadata: jsonb("metadata"),
  sent_at: timestamp("sent_at").notNull().defaultNow(),
});

export const insertNotificationTemplateSchema = createInsertSchema(notificationTemplatesTable).omit({ id: true, created_at: true });
export type InsertNotificationTemplate = z.infer<typeof insertNotificationTemplateSchema>;
export type NotificationTemplate = typeof notificationTemplatesTable.$inferSelect;
