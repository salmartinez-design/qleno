import { pgTable, serial, text, integer, timestamp, boolean, numeric, date, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const userRoleEnum = pgEnum("user_role", [
  "owner", "admin", "office", "technician", "super_admin"
]);

export const payTypeEnum = pgEnum("pay_type", [
  "hourly", "per_job", "fee_split"
]);

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("technician"),
  first_name: text("first_name").notNull(),
  last_name: text("last_name").notNull(),
  avatar_url: text("avatar_url"),
  phone: text("phone"),
  address: text("address"),
  dob: date("dob"),
  hire_date: date("hire_date"),
  pay_rate: numeric("pay_rate", { precision: 10, scale: 2 }),
  pay_type: payTypeEnum("pay_type"),
  fee_split_pct: numeric("fee_split_pct", { precision: 5, scale: 2 }),
  allowed_hours_per_week: numeric("allowed_hours_per_week", { precision: 6, scale: 2 }),
  skills: text("skills").array(),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, created_at: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
