import { pgTable, serial, integer, numeric } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const offerSettingsTable = pgTable("offer_settings", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").notNull().unique().references(() => companiesTable.id, { onDelete: "cascade" }),
  overrun_threshold_percent: numeric("overrun_threshold_percent", { precision: 5, scale: 2 }).default("20"),
  overrun_jobs_trigger: integer("overrun_jobs_trigger").default(2),
  service_gap_days: integer("service_gap_days").default(60),
  rate_lock_duration_months: integer("rate_lock_duration_months").default(24),
  renewal_alert_days: integer("renewal_alert_days").default(30),
});

export type OfferSettings = typeof offerSettingsTable.$inferSelect;
