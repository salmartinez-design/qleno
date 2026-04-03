import { pgTable, serial, integer, text, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";

export const commDirectionEnum = pgEnum("comm_direction", ["inbound", "outbound"]);
export const commChannelEnum = pgEnum("comm_channel", [
  "phone", "email", "sms", "in_person", "other",
]);

export const communicationLogTable = pgTable("communication_log", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  customer_id: integer("customer_id").references(() => clientsTable.id).notNull(),
  job_id: integer("job_id").references(() => jobsTable.id),
  direction: commDirectionEnum("direction").notNull(),
  channel: commChannelEnum("channel").notNull(),
  summary: text("summary").notNull(),
  body: text("body"),
  subject: text("subject"),
  source: text("source").default("staff"),
  sent_by: text("sent_by"),
  recipient: text("recipient"),
  twilio_message_sid: text("twilio_message_sid"),
  resend_email_id: text("resend_email_id"),
  delivery_status: text("delivery_status").default("pending"),
  opened_at: timestamp("opened_at", { withTimezone: true }),
  clicked_at: timestamp("clicked_at", { withTimezone: true }),
  logged_by: integer("logged_by").references(() => usersTable.id),
  logged_at: timestamp("logged_at").notNull().defaultNow(),
  tags: text("tags").array(),
});

export const communicationEventsTable = pgTable("communication_events", {
  id: serial("id").primaryKey(),
  communication_log_id: integer("communication_log_id").references(() => communicationLogTable.id, { onDelete: "cascade" }),
  event_type: text("event_type").notNull(),
  event_data: jsonb("event_data"),
  occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CommunicationLog = typeof communicationLogTable.$inferSelect;
export type CommunicationEvent = typeof communicationEventsTable.$inferSelect;
