import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// test_sends — the dedicated ledger for the "Send Test" feature.
//
// Test sends are deliberately kept OUT of the customer-facing communication log
// (notification_log / "Recent Sends") and never touch any client/appointment
// record. Every test attempt — success OR failure — writes exactly one row here
// so the office has an auditable trail that is isolated from real customer
// comms. The send path that writes these rows does NOT call sendNotification(),
// so none of the downstream automations (review-request cron, follow-up
// enrollment, scorecard capture) can fire off a test.
// ─────────────────────────────────────────────────────────────────────────────
export const testSendsTable = pgTable("test_sends", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").notNull().references(() => companiesTable.id),
  // Null when the active branch was "all" or couldn't be resolved — the send
  // then uses the company-level / primary-branch sender.
  branch_id: integer("branch_id").references(() => branchesTable.id),
  user_id: integer("user_id").references(() => usersTable.id),
  // The customer-message catalog key, e.g. "job_scheduled", "reminder_3day".
  template_key: text("template_key").notNull(),
  channel: text("channel").notNull(), // "email" | "sms"
  recipient: text("recipient"),
  subject: text("subject"), // null for sms
  body: text("body"),
  // The merge data used to render this test ("sample" fixture or appointment).
  merge_data_json: jsonb("merge_data_json"),
  fixture_source: text("fixture_source"), // "sample" | "appointment:<id>"
  status: text("status").notNull(), // "queued" | "sent" | "failed"
  provider_message_id: text("provider_message_id"),
  error: text("error"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TestSend = typeof testSendsTable.$inferSelect;
