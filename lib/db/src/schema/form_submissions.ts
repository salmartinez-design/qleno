import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { formTemplatesTable } from "./form_templates";
import { usersTable } from "./users";
import { clientsTable } from "./clients";
import { jobsTable } from "./jobs";

export const formSubmissionsTable = pgTable("form_submissions", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  form_id: integer("form_id").references(() => formTemplatesTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id),
  job_id: integer("job_id").references(() => jobsTable.id),
  responses: jsonb("responses").notNull().default({}),
  submitted_at: timestamp("submitted_at"),
  submitted_by: integer("submitted_by").references(() => usersTable.id),
  ip_address: text("ip_address"),
  signature_name: text("signature_name"),
  signature_at: timestamp("signature_at"),
  pdf_url: text("pdf_url"),
  content_hash: text("content_hash"),
  sign_token: text("sign_token").unique(),
  status: text("status").notNull().default("draft"),
  sent_at: timestamp("sent_at"),
  sent_to: text("sent_to"),
  expires_at: timestamp("expires_at"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertFormSubmissionSchema = createInsertSchema(formSubmissionsTable).omit({ id: true, created_at: true });
export type InsertFormSubmission = z.infer<typeof insertFormSubmissionSchema>;
export type FormSubmission = typeof formSubmissionsTable.$inferSelect;
