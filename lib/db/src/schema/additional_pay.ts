import { pgTable, serial, integer, timestamp, numeric, text, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";

export const additionalPayTypeEnum = pgEnum("additional_pay_type", [
  "tips", "sick_pay", "holiday_pay", "bonus", "vacation_pay", "compliment", "amount_owed", "mileage"
]);

export const additionalPayStatusEnum = pgEnum("additional_pay_status", [
  "pending", "paid", "voided"
]);

export const additionalPayTable = pgTable("additional_pay", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  user_id: integer("user_id").references(() => usersTable.id).notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  type: additionalPayTypeEnum("type").notNull(),
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
