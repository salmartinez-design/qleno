import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

// [engagement-tracking-phase4 2026-06-25] Native engagement layer for the
// estimate workflow — no external analytics. Two tables:
//
//  - engagement_events: the unified, append-only timeline that every source
//    fans into (cadence sends, our own click-redirect + open-pixel, the public
//    estimate page views/accept/decline, and inbound SMS replies). One row per
//    event; the Phase-5 dashboard reads straight from here.
//  - tracked_links: our own click-redirect + open-pixel tokens so clicks/opens
//    are recorded natively (not just via Resend), each tied to estimate +
//    enrollment for attribution.
//
// No FK constraints beyond company_id (mirrors the estimate/cadence tables);
// scoping is enforced in code. Additive + idempotent.

export const engagementEventsTable = pgTable("engagement_events", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  // What the event is about (any may be null for non-estimate sources).
  estimate_id: integer("estimate_id"),
  enrollment_id: integer("enrollment_id"),
  // sent | delivered | opened | clicked | replied | viewed | accepted |
  // declined | bounced | failed
  event_type: text("event_type").notNull(),
  channel: text("channel"), // email | sms | web
  recipient: text("recipient"),
  // Free-form details: clicked url, message id, step number, source table, etc.
  meta: jsonb("meta"),
  occurred_at: timestamp("occurred_at").notNull().defaultNow(),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const trackedLinksTable = pgTable("tracked_links", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  estimate_id: integer("estimate_id"),
  enrollment_id: integer("enrollment_id"),
  kind: text("kind").notNull().default("click"), // click | open
  target_url: text("target_url"), // null for open pixels
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type EngagementEvent = typeof engagementEventsTable.$inferSelect;
export type TrackedLink = typeof trackedLinksTable.$inferSelect;
