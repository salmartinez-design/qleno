import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

// Per-tenant configurable headline cards for the lead dashboard.
// Default: leads / lead_to_book / close_rate (Sal's locked defaults).
export const leadReportSettingsTable = pgTable("lead_report_settings", {
  company_id: integer("company_id").primaryKey().references(() => companiesTable.id),
  headline_cards: text("headline_cards").array().notNull().default(["leads", "lead_to_book", "close_rate"]),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});

export type LeadReportSettings = typeof leadReportSettingsTable.$inferSelect;
