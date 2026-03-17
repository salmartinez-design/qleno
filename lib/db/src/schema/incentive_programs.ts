import { pgTable, serial, integer, text, boolean, numeric, date, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const incentiveTypeEnum = pgEnum("incentive_type", [
  "performance", "attendance", "retention", "referral", "custom",
]);
export const incentiveRewardTypeEnum = pgEnum("incentive_reward_type", [
  "cash", "gift_card", "pto", "other",
]);

export const incentiveProgramsTable = pgTable("incentive_programs", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  name: text("name").notNull(),
  type: incentiveTypeEnum("type").notNull(),
  trigger_metric: text("trigger_metric"),
  threshold_value: numeric("threshold_value", { precision: 10, scale: 2 }),
  reward_amount: numeric("reward_amount", { precision: 10, scale: 2 }).notNull(),
  reward_type: incentiveRewardTypeEnum("reward_type").notNull(),
  monthly_budget_cap: numeric("monthly_budget_cap", { precision: 10, scale: 2 }),
  is_active: boolean("is_active").notNull().default(true),
  effective_date: date("effective_date"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type IncentiveProgram = typeof incentiveProgramsTable.$inferSelect;
