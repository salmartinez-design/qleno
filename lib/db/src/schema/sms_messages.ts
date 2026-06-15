import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

// Unified two-way SMS conversation store. Holds BOTH inbound and outbound SMS for
// BOTH leads and clients, threaded by the customer's phone number (canonical:
// last-10 digits in contact_phone). Tenant-scoped by company_id. Distinct from
// client_communications (client-only, mixes email/notes) — this is the purpose-
// built SMS conversation table backing the inbox + per-contact thread + reply.
export const smsMessagesTable = pgTable("sms_messages", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  // Canonical thread key — the CUSTOMER's number normalized to last-10 digits.
  // For inbound this is the sender (From); for outbound the recipient (To).
  contact_phone: text("contact_phone").notNull(),
  // Linkage — either/both may be null when the number matches no record yet.
  client_id: integer("client_id").references(() => clientsTable.id),
  lead_id: integer("lead_id"),
  direction: text("direction").notNull(), // 'inbound' | 'outbound'
  body: text("body").notNull(),
  from_number: text("from_number"),
  to_number: text("to_number"),
  provider_id: text("provider_id"),       // Twilio message SID (outbound) / inbound SID
  status: text("status").notNull().default("received"), // received | sent | failed | suppressed
  read_at: timestamp("read_at"),          // null = unread (inbound); outbound stamped on insert
  sent_by: integer("sent_by").references(() => usersTable.id), // staff user for outbound
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  threadIdx: index("sms_messages_thread_idx").on(t.company_id, t.contact_phone, t.created_at),
  unreadIdx: index("sms_messages_unread_idx").on(t.company_id, t.read_at),
}));

export const insertSmsMessageSchema = createInsertSchema(smsMessagesTable).omit({ id: true, created_at: true });
export type InsertSmsMessage = z.infer<typeof insertSmsMessageSchema>;
export type SmsMessage = typeof smsMessagesTable.$inferSelect;
