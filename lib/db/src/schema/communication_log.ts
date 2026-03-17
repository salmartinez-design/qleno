import { pgTable, serial, integer, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
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
  logged_by: integer("logged_by").references(() => usersTable.id),
  logged_at: timestamp("logged_at").notNull().defaultNow(),
  tags: text("tags").array(),
});

export type CommunicationLog = typeof communicationLogTable.$inferSelect;
