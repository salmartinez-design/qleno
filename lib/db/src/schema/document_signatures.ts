import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { documentTemplatesTable } from "./document_templates";
import { usersTable } from "./users";
import { clientsTable } from "./clients";

export const documentSignaturesTable = pgTable("document_signatures", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  template_id: integer("template_id").references(() => documentTemplatesTable.id).notNull(),
  employee_id: integer("employee_id").references(() => usersTable.id),
  client_id: integer("client_id").references(() => clientsTable.id),
  signed_at: timestamp("signed_at").notNull().defaultNow(),
  signer_name: text("signer_name").notNull(),
  signer_email: text("signer_email"),
  signature_data: text("signature_data"),
  ip_address: text("ip_address"),
  user_agent: text("user_agent"),
  document_snapshot: text("document_snapshot").notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertDocumentSignatureSchema = createInsertSchema(documentSignaturesTable).omit({ id: true, created_at: true });
export type InsertDocumentSignature = z.infer<typeof insertDocumentSignatureSchema>;
export type DocumentSignature = typeof documentSignaturesTable.$inferSelect;
