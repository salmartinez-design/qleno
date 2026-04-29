import { pgTable, serial, text, integer, timestamp, boolean, numeric, date, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";

export const userRoleEnum = pgEnum("user_role", [
  "owner", "admin", "office", "technician", "team_lead", "super_admin"
]);

export const payTypeEnum = pgEnum("pay_type", [
  "hourly", "per_job", "fee_split"
]);

export const employmentTypeEnum = pgEnum("employment_type", [
  "full_time", "part_time", "contractor"
]);

export const hrStatusEnum = pgEnum("hr_status", [
  "trainee", "active", "quality_probation", "inactive",
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
  personal_email: text("personal_email"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  dob: date("dob"),
  gender: text("gender"),
  hire_date: date("hire_date"),
  termination_date: date("termination_date"),
  employment_type: employmentTypeEnum("employment_type"),
  pay_rate: numeric("pay_rate", { precision: 10, scale: 2 }),
  pay_type: payTypeEnum("pay_type"),
  fee_split_pct: numeric("fee_split_pct", { precision: 5, scale: 2 }),
  allowed_hours_per_week: numeric("allowed_hours_per_week", { precision: 6, scale: 2 }),
  overtime_eligible: boolean("overtime_eligible").default(true),
  w2_1099: text("w2_1099"),
  bank_name: text("bank_name"),
  bank_account_last4: text("bank_account_last4"),
  skills: text("skills").array(),
  tags: text("tags").array(),
  emergency_contact_name: text("emergency_contact_name"),
  emergency_contact_phone: text("emergency_contact_phone"),
  emergency_contact_relation: text("emergency_contact_relation"),
  ssn_last4: text("ssn_last4"),
  notes: text("notes"),
  hr_status: hrStatusEnum("hr_status").default("active"),
  commission_rate_override: numeric("commission_rate_override", { precision: 6, scale: 2 }),
  // [pay-matrix 2026-04-29] Per-employee 4-cell pay matrix. Replaces
  // the company-wide single-rate model. Type can be 'commission' (rate
  // is a fraction 0.00–1.00) or 'hourly' (rate is dollars/hour). The
  // dispatch route routes residential vs commercial off
  // clients.client_type and picks the corresponding pair from this
  // matrix. New employees inherit the tenant defaults from
  // companies.default_{residential,commercial}_pay_{type,rate}.
  residential_pay_type: text("residential_pay_type").default("commission"),
  residential_pay_rate: numeric("residential_pay_rate", { precision: 8, scale: 4 }).default("0.35"),
  commercial_pay_type:  text("commercial_pay_type").default("hourly"),
  commercial_pay_rate:  numeric("commercial_pay_rate",  { precision: 8, scale: 4 }).default("20.0000"),
  benefit_year_start: date("benefit_year_start"),
  leave_balance_hours: numeric("leave_balance_hours", { precision: 8, scale: 2 }).default("0"),
  leave_balance_activated: boolean("leave_balance_activated").default(false),
  invite_token: text("invite_token"),
  invite_sent_at: timestamp("invite_sent_at"),
  invite_accepted_at: timestamp("invite_accepted_at"),
  onboarding_complete: boolean("onboarding_complete").default(false),
  is_active: boolean("is_active").notNull().default(true),
  crew_id: integer("crew_id"),
  home_branch_id: integer("home_branch_id").references(() => branchesTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, created_at: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
