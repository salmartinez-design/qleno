import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// Per-tenant message template store. Used by the follow-up cadence engine and
// quotes. Seeded from each tenant's imported defaults (e.g. Phes's MaidCentral
// templates) but fully editable/cloneable. Merge fields use {{token}}.
export const messageTemplatesTable = pgTable("message_templates", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  channel: text("channel").notNull(), // 'email' | 'sms'
  subject: text("subject"),           // email only
  body: text("body").notNull(),
  category: text("category"),         // e.g. 'quote_followup', 'survey', 'imported'
  is_default: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertMessageTemplateSchema = createInsertSchema(messageTemplatesTable).omit({ id: true, created_at: true, updated_at: true });
export type InsertMessageTemplate = z.infer<typeof insertMessageTemplateSchema>;
export type MessageTemplate = typeof messageTemplatesTable.$inferSelect;
