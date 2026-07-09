import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { jobsTable } from "./jobs";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

// [team-photo-notes] Pictures + notes the team attaches so everyone sees the
// same field context (gate codes, where to park, pet/alarm warnings, supply
// closet). Two scopes, set by `is_sticky`:
//   • job-specific  → job_id set, is_sticky=false. One-off for that visit.
//   • sticky        → is_sticky=true + a customer scope so it re-surfaces on
//                     EVERY job for that customer: client_id (residential) OR
//                     account_property_id (a specific building) OR account_id
//                     (whole commercial account). job_id may still record where
//                     the note was first added.
// account_id / account_property_id are loose integers (no FK) to match how the
// dispatch layer treats account linkage; company_id scopes every read.
export const teamPhotoNotesTable = pgTable("team_photo_notes", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  job_id: integer("job_id").references(() => jobsTable.id),
  client_id: integer("client_id").references(() => clientsTable.id),
  account_id: integer("account_id"),
  account_property_id: integer("account_property_id"),
  is_sticky: boolean("is_sticky").notNull().default(false),
  image_url: text("image_url"),
  note: text("note"),
  uploaded_by: integer("uploaded_by").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertTeamPhotoNoteSchema = createInsertSchema(teamPhotoNotesTable).omit({ id: true, created_at: true });
export type InsertTeamPhotoNote = z.infer<typeof insertTeamPhotoNoteSchema>;
export type TeamPhotoNote = typeof teamPhotoNotesTable.$inferSelect;
