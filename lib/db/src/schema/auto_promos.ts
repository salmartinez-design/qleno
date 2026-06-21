import { pgTable, serial, integer, timestamp, text, numeric, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// [auto-promos 2026-06-21] Tenant-scoped, automatically-applied promotional
// discounts. These are NOT manual coupon codes (those live in pricing_discounts)
// — they fire on their own when the rule matches, so the advertised offer is
// always honored without the office or customer entering anything.
//
// Two kinds ship initially (the `kind` column is the rule selector):
//   second_recurring — 15% off the SECOND visit of a customer's recurring plan
//                       (ordinal 2 within a recurring_schedule). Stamped onto
//                       that visit as a job_discounts row at invoice build time.
//   deep_clean       — 15% off ANY deep clean (jobs.service_type='deep_clean'),
//                       year-round. Shown at checkout (runCalculate) and stamped
//                       as a job_discounts row at invoice build time.
//
// Multi-tenant: every row is company-scoped. The realized discount always lands
// in job_discounts (the existing per-job snapshot table the invoice builder
// already itemizes), so promos are auditable + traceable per job and never
// recomputed after the fact. `discount_pct` is the percent off (e.g. 15.00).
export const autoPromoKinds = ["second_recurring", "deep_clean"] as const;
export type AutoPromoKind = (typeof autoPromoKinds)[number];

export const autoPromosTable = pgTable("auto_promos", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  // One of autoPromoKinds. Kept as text (not a pg enum) so adding a new promo
  // rule later is an INSERT, never a fragile ALTER TYPE.
  kind: text("kind").notNull(),
  discount_pct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull(),
  is_active: boolean("is_active").notNull().default(true),
  // Human label stamped onto the job_discounts.reason so it reads cleanly on the
  // invoice (e.g. "Second Visit Promo (15% off)").
  label: text("label"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertAutoPromoSchema = createInsertSchema(autoPromosTable).omit({ id: true, created_at: true });
export type InsertAutoPromo = z.infer<typeof insertAutoPromoSchema>;
export type AutoPromo = typeof autoPromosTable.$inferSelect;
