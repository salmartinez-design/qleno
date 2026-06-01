import { pgTable, serial, integer, text, boolean, timestamp, numeric, pgEnum } from "drizzle-orm/pg-core";
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
  // Action picker matching MaidCentral's vocabulary so the operator can
  // pick the right SEMANTIC outcome without us pre-categorizing it as
  // "customer fault" vs "tech fault". Drives whether a fee is charged
  // and what status the job ends up in.
  //   move          customer reschedule — free
  //   bump          we reschedule       — free
  //   skip          customer one-time   — free
  //   cancel        customer late cancel — CHARGES (per company default)
  //   lockout       crew couldn't get in — CHARGES (per company default)
  //   cancel_service terminate recurring schedule — free
  // Text not enum: the action vocabulary is small and stable, but we
  // also want tenants to add their own (e.g. "weather_cancel") without a
  // migration. Caller validates against a small allowlist.
  cancel_action: text("cancel_action"),
  // Dollars charged to the customer for this cancellation. 0 when the
  // action is free. Populated for cancel + lockout per the per-company
  // default × job amount (or per-client override).
  customer_charge_amount: numeric("customer_charge_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  // Cancel Service terminates the recurring schedule. Flag set so reports
  // can split "single visit cancelled" from "service lost" attribution.
  affects_future_jobs: boolean("affects_future_jobs").notNull().default(false),
});

export type CancellationLog = typeof cancellationLogTable.$inferSelect;
