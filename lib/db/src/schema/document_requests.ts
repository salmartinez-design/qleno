import { pgTable, serial, text, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { documentTemplatesTable } from "./document_templates";
import { usersTable } from "./users";
import { clientsTable } from "./clients";

export const documentRequestStatusEnum = pgEnum("document_request_status", [
  "pending",
  "viewed",
  "signed",
  "expired",
]);

export const documentRequestsTable = pgTable("document_requests", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  template_id: integer("template_id").references(() => documentTemplatesTable.id).notNull(),
  employee_id: integer("employee_id").references(() => usersTable.id),
  client_id: integer("client_id").references(() => clientsTable.id),
  token: text("token").notNull().unique(),
  status: documentRequestStatusEnum("status").notNull().default("pending"),
  sent_at: timestamp("sent_at").notNull().defaultNow(),
  expires_at: timestamp("expires_at").notNull(),
  signed_at: timestamp("signed_at"),
  reminder_sent_at: timestamp("reminder_sent_at"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertDocumentRequestSchema = createInsertSchema(documentRequestsTable).omit({ id: true, created_at: true });
export type InsertDocumentRequest = z.infer<typeof insertDocumentRequestSchema>;
export type DocumentRequest = typeof documentRequestsTable.$inferSelect;
