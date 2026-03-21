import { pgTable, serial, text, integer, timestamp, boolean, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const documentCategoryEnum = pgEnum("document_category", [
  "employee_onboarding",
  "employee_operational",
  "client_residential",
  "client_commercial",
]);

export const documentTemplatesTable = pgTable("document_templates", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  category: documentCategoryEnum("category").notNull(),
  content: text("content").notNull().default(""),
  is_required: boolean("is_required").notNull().default(false),
  is_active: boolean("is_active").notNull().default(true),
  requires_signature: boolean("requires_signature").notNull().default(false),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export const insertDocumentTemplateSchema = createInsertSchema(documentTemplatesTable).omit({ id: true, created_at: true, updated_at: true });
export type InsertDocumentTemplate = z.infer<typeof insertDocumentTemplateSchema>;
export type DocumentTemplate = typeof documentTemplatesTable.$inferSelect;
