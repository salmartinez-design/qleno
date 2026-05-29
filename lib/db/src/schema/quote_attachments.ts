import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { quotesTable } from "./quotes";
import { usersTable } from "./users";

// [quote-attachments 2026-05-26] Files attached to a quote's Call Notes
// (client-supplied photos, office screenshots, PDFs). Office-only on the
// quote screen. When the quote converts to a job, techs assigned to the
// job can read them via GET /api/jobs/:id/attachments — which resolves
// back through quotes.booked_job_id. Customers never see these.
export const quoteAttachmentsTable = pgTable("quote_attachments", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  quote_id: integer("quote_id").references(() => quotesTable.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  file_url: text("file_url").notNull(),
  file_type: text("file_type"),
  file_size: integer("file_size"),
  uploaded_by: integer("uploaded_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertQuoteAttachmentSchema = createInsertSchema(quoteAttachmentsTable).omit({ id: true, created_at: true });
export type InsertQuoteAttachment = z.infer<typeof insertQuoteAttachmentSchema>;
export type QuoteAttachment = typeof quoteAttachmentsTable.$inferSelect;
