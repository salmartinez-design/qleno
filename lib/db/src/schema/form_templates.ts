import { pgTable, serial, text, integer, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const formTemplatesTable = pgTable("form_templates", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  type: text("type").notNull().default("agreement"),
  category: text("category").default("both"),
  schema: jsonb("schema").notNull().default({}),
  terms_body: text("terms_body"),
  requires_sign: boolean("requires_sign").default(false),
  is_active: boolean("is_active").default(true),
  is_default: boolean("is_default").default(false),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertFormTemplateSchema = createInsertSchema(formTemplatesTable).omit({ id: true, created_at: true, updated_at: true });
export type InsertFormTemplate = z.infer<typeof insertFormTemplateSchema>;
export type FormTemplate = typeof formTemplatesTable.$inferSelect;
