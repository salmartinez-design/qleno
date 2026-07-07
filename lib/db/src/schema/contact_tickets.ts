import { pgTable, serial, integer, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { jobsTable } from "./jobs";

// [time-off-ticket 2026-07-07] 'time_off_request' rows are auto-created when an
// employee submits a leave request, so every request also lands as a durable
// ticket on the employee's profile + the Contact Tickets report (Sal: "the
// office is getting an email of the request as well as an employee ticket").
// Added to the live enum via ALTER TYPE ... ADD VALUE in runStartupMigrations.
export const contactTicketTypeEnum = pgEnum("contact_ticket_type", [
  "breakage", "complaint_poor_cleaning", "complaint_attitude",
  "compliment", "incident", "note", "technician_note", "time_off_request"
]);

export const contactTicketsTable = pgTable("contact_tickets", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  client_id: integer("client_id").references(() => clientsTable.id),
  job_id: integer("job_id").references(() => jobsTable.id),
  ticket_type: contactTicketTypeEnum("ticket_type").notNull(),
  notes: text("notes"),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertContactTicketSchema = createInsertSchema(contactTicketsTable).omit({ id: true, created_at: true });
export type InsertContactTicket = z.infer<typeof insertContactTicketSchema>;
export type ContactTicket = typeof contactTicketsTable.$inferSelect;
