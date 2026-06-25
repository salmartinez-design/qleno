import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { createInsertSchema } from "drizzle-zod";
import { companiesTable } from "./companies";

// [cadence-foundation 2026-06-25] Drizzle definitions for the multi-touch
// follow-up cadence engine (services/followUpService.ts). These tables were
// created ONLY by raw-SQL migrations (phes-data-migration.ts for the four core
// tables; cutover-data-migration.ts for follow_up_enrollments.abandoned_booking_id)
// and had no typed model. Definitions below match the live production columns
// exactly so a fresh DB and prod converge and the engine is extendable in
// later estimate-drip phases.
//
// FK constraints are intentionally absent in prod (scoping enforced in code);
// .references() here is minimal schema documentation only.

// A named cadence template per tenant (e.g. quote_followup, post_job_retention).
export const followUpSequencesTable = pgTable("follow_up_sequences", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  sequence_type: text("sequence_type").notNull(),
  name: text("name").notNull(),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

// The ordered touches within a sequence (delay, channel, message body).
export const followUpStepsTable = pgTable("follow_up_steps", {
  id: serial("id").primaryKey(),
  sequence_id: integer("sequence_id").references(() => followUpSequencesTable.id).notNull(),
  step_number: integer("step_number").notNull(),
  delay_hours: integer("delay_hours").notNull(),
  channel: text("channel").notNull(), // email | sms
  subject: text("subject"),
  message_template: text("message_template").notNull(),
  template_id: integer("template_id"), // optional link to message_templates
  created_at: timestamp("created_at").notNull().defaultNow(),
});

// A subject's enrollment in a sequence. Keyed to whatever entity started the
// cadence — quote, client, lead, or an abandoned booking. processDueEnrollments()
// advances current_step / next_fire_at; accept/reply/booking stops it.
export const followUpEnrollmentsTable = pgTable("follow_up_enrollments", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  sequence_id: integer("sequence_id").references(() => followUpSequencesTable.id).notNull(),
  quote_id: integer("quote_id"),
  client_id: integer("client_id"),
  lead_id: integer("lead_id"),
  abandoned_booking_id: integer("abandoned_booking_id"),
  // [estimate-drip-phase3 2026-06-25] commercial estimate follow-up enrollments
  estimate_id: integer("estimate_id"),
  current_step: integer("current_step").notNull().default(1),
  enrolled_at: timestamp("enrolled_at").notNull().defaultNow(),
  next_fire_at: timestamp("next_fire_at").notNull(),
  completed_at: timestamp("completed_at"),
  stopped_at: timestamp("stopped_at"),
  stopped_reason: text("stopped_reason"),
});

// Audit trail of every cadence touch actually sent (or suppressed).
export const messageLogTable = pgTable("message_log", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  enrollment_id: integer("enrollment_id").references(() => followUpEnrollmentsTable.id).notNull(),
  client_id: integer("client_id"),
  channel: text("channel").notNull(),
  recipient_phone: text("recipient_phone"),
  recipient_email: text("recipient_email"),
  subject: text("subject"),
  body: text("body").notNull(),
  status: text("status").notNull(),
  sequence_name: text("sequence_name"),
  step_number: integer("step_number"),
  sent_at: timestamp("sent_at").notNull().defaultNow(),
});

export const insertFollowUpSequenceSchema = createInsertSchema(followUpSequencesTable).omit({ id: true, created_at: true });
export type FollowUpSequence = typeof followUpSequencesTable.$inferSelect;
export type FollowUpStep = typeof followUpStepsTable.$inferSelect;
export type FollowUpEnrollment = typeof followUpEnrollmentsTable.$inferSelect;
export type MessageLogEntry = typeof messageLogTable.$inferSelect;
