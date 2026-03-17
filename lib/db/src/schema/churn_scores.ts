import { pgTable, serial, integer, text, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";

export const riskLevelEnum = pgEnum("risk_level", ["low", "medium", "high", "critical"]);

export const churnScoresTable = pgTable("churn_scores", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  customer_id: integer("customer_id").references(() => clientsTable.id).notNull(),
  score: integer("score").notNull().default(0),
  risk_level: riskLevelEnum("risk_level").notNull().default("low"),
  signals: jsonb("signals"),
  calculated_at: timestamp("calculated_at").notNull().defaultNow(),
});

export type ChurnScore = typeof churnScoresTable.$inferSelect;
