import { pgTable, serial, integer, text, numeric, date, timestamp, unique } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

/**
 * [mc-revenue-history 2026-08-17] Monthly revenue actuals from MaidCentral,
 * for the period before the tenant moved onto Qleno.
 *
 * Phes ran on MaidCentral until 2026-07-01 and only partially entered work in
 * Qleno before then, so Qleno's own job tables are not a record of pre-cutover
 * trading — the reporting floor (companies.invoice_cutover_date) keeps them out
 * of every money total. That left a hole: ask for the year and the first six
 * months read as nothing. This table fills it with the real figures.
 *
 * It carries MONTH TOTALS ONLY. There is no job, client, or employee detail
 * behind these numbers, so they feed revenue history and nothing else — never
 * payroll, margin, per-client profitability, or commission, all of which need
 * job-level data that does not exist for this period.
 *
 * Why a table and not the old hardcoded array in revenue-history.tsx: these are
 * the company's books for two years of trading, they need to be correctable
 * without a deploy, and the revenue report has to read them server-side.
 *
 * Do NOT re-materialise this as synthetic jobs or invoices. That was tried once
 * — an 80-row "MaidCentral / Historical Import" client — and it double-counted
 * Jan–Mar 2026 in every report because those months were also imported properly
 * per job. Deleted 2026-08-17.
 */
export const mcRevenueHistoryTable = pgTable("mc_revenue_history", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  /** First day of the month the revenue belongs to. */
  month: date("month").notNull(),
  phes_revenue: numeric("phes_revenue", { precision: 12, scale: 2 }).notNull().default("0"),
  schaumburg_revenue: numeric("schaumburg_revenue", { precision: 12, scale: 2 }).notNull().default("0"),
  total_revenue: numeric("total_revenue", { precision: 12, scale: 2 }).notNull(),
  /**
   * actual    — the month closed and MaidCentral reported it. The only type
   *             that counts toward historical revenue.
   * partial   — the month was still running when the figures were captured.
   * projected — MaidCentral's recurring-schedule forecast. Never collected,
   *             never counted; kept only so the original report reconciles.
   */
  revenue_type: text("revenue_type").notNull().default("actual"),
  source: text("source").notNull().default("maidcentral"),
  /** When these figures were pulled out of the source system. */
  captured_at: date("captured_at"),
  note: text("note"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uniqCompanyMonth: unique("mc_revenue_history_company_month_key").on(t.company_id, t.month),
}));

export type McRevenueHistory = typeof mcRevenueHistoryTable.$inferSelect;
