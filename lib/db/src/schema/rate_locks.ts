import { pgTable, serial, integer, text, numeric, date, boolean, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";

export const rateLocksTable = pgTable("rate_locks", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  client_id: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  recurring_schedule_id: integer("recurring_schedule_id"),
  locked_rate: numeric("locked_rate", { precision: 10, scale: 2 }).notNull(),
  cadence: text("cadence"),
  lock_start_date: date("lock_start_date"),
  lock_expires_at: date("lock_expires_at"),
  active: boolean("active").notNull().default(true),
  void_reason: text("void_reason"),
  voided_at: timestamp("voided_at"),
  renewal_alert_30_sent: boolean("renewal_alert_30_sent").notNull().default(false),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type RateLock = typeof rateLocksTable.$inferSelect;
