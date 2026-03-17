import { pgTable, serial, integer, text, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";

export const cancelReasonEnum = pgEnum("cancel_reason", [
  "customer_request", "no_show", "weather", "emergency", "other",
]);

export const cancellationLogTable = pgTable("cancellation_log", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  job_id: integer("job_id").references(() => jobsTable.id).notNull(),
  customer_id: integer("customer_id").references(() => clientsTable.id).notNull(),
  cancelled_by: integer("cancelled_by").references(() => usersTable.id),
  cancel_reason: cancelReasonEnum("cancel_reason").notNull(),
  cancelled_at: timestamp("cancelled_at").notNull().defaultNow(),
  rescheduled_to_job_id: integer("rescheduled_to_job_id").references(() => jobsTable.id),
  notes: text("notes"),
  refund_issued: boolean("refund_issued").notNull().default(false),
});

export type CancellationLog = typeof cancellationLogTable.$inferSelect;
