/**
 * [scheduling-engine 2026-04-29] Tenant-managed acquisition sources.
 *
 * Replaces the hardcoded SOURCE_LABELS map in customer-profile.tsx.
 * Tenants can now add/remove sources from the UI without a code
 * deploy — per Sal's spec, Phes wants Thumbtack on the list and to
 * add "BNI Networking" mid-conversation without waiting for an
 * engineer.
 *
 * `slug` is the stable persistence key written to clients
 * .referral_source (text); name is the display label. is_active
 * controls visibility in the dropdown without losing historical
 * data on existing clients.
 */
import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const acquisitionSourcesTable = pgTable("acquisition_sources", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").notNull(),
  slug: text("slug").notNull(),       // immutable identifier persisted to clients.referral_source
  name: text("name").notNull(),       // display label, editable
  is_active: boolean("is_active").notNull().default(true),
  display_order: integer("display_order").notNull().default(100),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type AcquisitionSource = typeof acquisitionSourcesTable.$inferSelect;
export type InsertAcquisitionSource = typeof acquisitionSourcesTable.$inferInsert;
