import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

// Outbound SMS scheduled for future delivery. The scheduler cron (every minute)
// queries pending rows whose scheduled_for <= NOW() and fires them via Twilio.
export const scheduledSmsTable = pgTable("scheduled_sms", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  contact_phone: text("contact_phone").notNull(),
  client_id: integer("client_id").references(() => clientsTable.id),
  lead_id: integer("lead_id"),
  message: text("message").notNull(),
  media_urls: text("media_urls").array(),
  scheduled_for: timestamp("scheduled_for").notNull(),
  status: text("status").notNull().default("pending"), // pending | sent | cancelled | failed
  sent_sms_id: integer("sent_sms_id"),  // set once sent (FK to sms_messages.id)
  failure_reason: text("failure_reason"),
  created_by: integer("created_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  pendingIdx: index("scheduled_sms_pending_idx").on(t.company_id, t.scheduled_for, t.status),
  phoneIdx: index("scheduled_sms_phone_idx").on(t.company_id, t.contact_phone),
}));

export type ScheduledSms = typeof scheduledSmsTable.$inferSelect;
