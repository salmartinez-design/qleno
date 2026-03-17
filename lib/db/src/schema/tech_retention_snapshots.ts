import { pgTable, serial, integer, numeric, date, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

export const techRetentionSnapshotsTable = pgTable("tech_retention_snapshots", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  employee_id: integer("employee_id").references(() => usersTable.id).notNull(),
  snapshot_date: date("snapshot_date").notNull(),
  tenure_days: integer("tenure_days"),
  jobs_completed_30d: integer("jobs_completed_30d"),
  avg_rating_30d: numeric("avg_rating_30d", { precision: 3, scale: 2 }),
  cancellations_30d: integer("cancellations_30d"),
  attendance_score: numeric("attendance_score", { precision: 5, scale: 2 }),
  flight_risk_score: integer("flight_risk_score").notNull().default(0),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type TechRetentionSnapshot = typeof techRetentionSnapshotsTable.$inferSelect;
