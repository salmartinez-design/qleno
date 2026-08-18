import { pgTable, serial, integer, timestamp, numeric, text, pgEnum, date } from "drizzle-orm/pg-core";
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

  // [pay-day 2026-08-17] WHICH DAY THIS MONEY BELONGS TO — the payroll filter.
  //
  // created_at is an audit stamp: `timestamp WITHOUT time zone` holding a UTC
  // instant (Drizzle defaultNow() on a UTC server). Payroll windowed on
  // created_at::date, which reads that UTC wall clock as if it were a local
  // calendar day, so a tip recorded at 8pm Central filed on tomorrow. The
  // MaidCentral import made it worse in the other direction: those rows carry
  // a date at literal midnight, so converting them UTC->Central would push
  // them BACK a day. One column cannot mean both things.
  //
  // So it doesn't. created_at keeps meaning "when the row was typed" and this
  // means "the day it pays out on" — set from the tenant's own calendar, or to
  // whatever day the office chooses when they record something after the fact.
  // Every payroll and report window filters on this; none filter on created_at.
  effective_date: date("effective_date"),
});

export const insertAdditionalPaySchema = createInsertSchema(additionalPayTable).omit({ id: true, created_at: true });
export type InsertAdditionalPay = z.infer<typeof insertAdditionalPaySchema>;
export type AdditionalPay = typeof additionalPayTable.$inferSelect;
