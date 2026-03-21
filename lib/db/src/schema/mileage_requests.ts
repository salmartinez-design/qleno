import { pgTable, serial, text, integer, timestamp, numeric, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";

export const mileageRequestStatusEnum = pgEnum("mileage_request_status", [
  "pending", "approved", "denied"
]);

export const mileageRequestsTable = pgTable("mileage_requests", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  service_date: text("service_date").notNull(),
  from_client_name: text("from_client_name").notNull(),
  to_client_name: text("to_client_name").notNull(),
  from_job_id: integer("from_job_id").references(() => jobsTable.id),
  to_job_id: integer("to_job_id").references(() => jobsTable.id),
  miles: numeric("miles", { precision: 8, scale: 2 }).notNull(),
  rate_per_mile: numeric("rate_per_mile", { precision: 6, scale: 4 }).notNull(),
  reimbursement_amount: numeric("reimbursement_amount", { precision: 10, scale: 2 }).notNull(),
  notes: text("notes"),
  status: mileageRequestStatusEnum("status").notNull().default("pending"),
  denial_reason: text("denial_reason"),
  additional_pay_id: integer("additional_pay_id"),
  reviewed_by: integer("reviewed_by").references(() => usersTable.id),
  reviewed_at: timestamp("reviewed_at"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertMileageRequestSchema = createInsertSchema(mileageRequestsTable).omit({ id: true, created_at: true });
export type InsertMileageRequest = z.infer<typeof insertMileageRequestSchema>;
export type MileageRequest = typeof mileageRequestsTable.$inferSelect;
