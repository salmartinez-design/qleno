/**
 * [commercial-workflow 2026-04-29] Hierarchical service types.
 *
 * Replaces three separate sources of truth: hardcoded SERVICE_TYPES /
 * COMMERCIAL_SERVICE_TYPES arrays in job-wizard.tsx, and the
 * commercial-only commercial_service_types table. All UI surfaces
 * read from this table, filtered by parent_slug ('residential' or
 * 'commercial') and the consumer's client_type / is_hybrid_client
 * signal.
 *
 * `slug` matches a value in jobs.service_type (the Postgres enum),
 * so historical jobs continue to FK / type-check correctly. The
 * Postgres enum stays append-only — we cannot remove legacy values
 * (e.g. 'recurring') without a multi-step rewrite, so the migration
 * strategy is: stop *displaying* legacy slugs by leaving them out of
 * service_types (or marking is_active=false), while historical jobs
 * keep their stored value.
 *
 * `default_allowed_hours` lets the picker pre-fill the stepper for
 * residential service types (e.g. Standard Clean = 2.5h). NULL on
 * commercial — those are explicitly negotiated per-account, no
 * default.
 *
 * `commercial_service_types` will be soft-deprecated in a follow-up
 * PR. During the transition both tables coexist; new UI consumers
 * read from `service_types`, the legacy edit-job-modal commercial
 * path keeps reading from `commercial_service_types` until #9 in
 * the implementation order lands.
 */
import { pgTable, serial, integer, text, boolean, numeric, timestamp } from "drizzle-orm/pg-core";

export const serviceTypesTable = pgTable("service_types", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").notNull(),
  parent_slug: text("parent_slug").notNull(),         // 'residential' | 'commercial' (CHECK constraint enforced in migration)
  slug: text("slug").notNull(),                       // matches jobs.service_type enum value
  name: text("name").notNull(),                       // display label
  description: text("description"),
  is_active: boolean("is_active").notNull().default(true),
  display_order: integer("display_order").notNull().default(100),
  default_allowed_hours: numeric("default_allowed_hours", { precision: 5, scale: 2 }),
  // [paytype-parity 2026-06-05] Per-service-type fee-split commission %
  // (0.35 = 35%). NULL falls back to the company tier (res 35 / deep 32 /
  // move 32). Lets a service set carry its own rate like MaidCentral —
  // e.g. "Hourly Deep Clean" pays 35%, not the global deep-clean 32%.
  commission_pct: numeric("commission_pct", { precision: 6, scale: 4 }),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type ServiceType = typeof serviceTypesTable.$inferSelect;
export type InsertServiceType = typeof serviceTypesTable.$inferInsert;
