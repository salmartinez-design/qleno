import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const clientCommunicationsTable = pgTable("client_communications", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id).notNull(),
  type: text("type").notNull(),
  direction: text("direction"),
  subject: text("subject"),
  body: text("body").notNull(),
  from_name: text("from_name"),
  to_contact: text("to_contact"),
  has_attachment: boolean("has_attachment").notNull().default(false),
  attachment_url: text("attachment_url"),
  sent_by: integer("sent_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertClientCommSchema = createInsertSchema(clientCommunicationsTable).omit({ id: true, created_at: true });
export type InsertClientComm = z.infer<typeof insertClientCommSchema>;
export type ClientCommunication = typeof clientCommunicationsTable.$inferSelect;
