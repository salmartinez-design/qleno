import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { jobsTable } from "./jobs";

export const satisfactionSurveysTable = pgTable("satisfaction_surveys", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  job_id: integer("job_id").references(() => jobsTable.id).notNull(),
  customer_id: integer("customer_id").references(() => clientsTable.id).notNull(),
  token: text("token").notNull().unique(),
  sent_at: timestamp("sent_at"),
  responded_at: timestamp("responded_at"),
  nps_score: integer("nps_score"),
  rating: integer("rating"),
  // MaidCentral 0–4 satisfaction scale (4 Thrilled … 0 Considering Another
  // Company) — the scorecard input. Replaces nps/rating going forward; old
  // columns kept for back-compat with any legacy responses.
  survey_score: integer("survey_score"),
  comment: text("comment"),
  follow_up_required: boolean("follow_up_required").notNull().default(false),
  suppressed: boolean("suppressed").notNull().default(false),
  suppressed_reason: text("suppressed_reason"),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export type SatisfactionSurvey = typeof satisfactionSurveysTable.$inferSelect;
