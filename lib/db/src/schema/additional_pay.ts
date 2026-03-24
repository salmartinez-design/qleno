import { pgTable, serial, integer, timestamp, numeric, text, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";

// IMPORTANT: additional_pay_type was removed from this schema.
// The `type` column is plain text — do NOT add a pgEnum for it.
// New pay types are inserted as raw text values; Drizzle must never
// generate DROP TYPE / CREATE TYPE migrations for this column.
// Runtime migrations guard their ALTER TYPE calls with IF EXISTS.

export const additionalPayStatusEnum = pgEnum("additional_pay_status", [
  "pending", "paid", "voided"
]);

export const additionalPayTable = pgTable("additional_pay", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  type: text("type").notNull(),
  notes: text("notes"),
  job_id: integer("job_id").references(() => jobsTable.id),
  status: additionalPayStatusEnum("status").notNull().default("pending"),
  voided_at: timestamp("voided_at"),
  voided_by: integer("voided_by").references(() => usersTable.id),
  paid_at: timestamp("paid_at"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertAdditionalPaySchema = createInsertSchema(additionalPayTable).omit({ id: true, created_at: true });
export type InsertAdditionalPay = z.infer<typeof insertAdditionalPaySchema>;
export type AdditionalPay = typeof additionalPayTable.$inferSelect;
