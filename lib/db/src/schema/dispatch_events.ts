import { pgTable, serial, integer, text, boolean, timestamp, date, time } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { branchesTable } from "./branches";
import { usersTable } from "./users";
import { clientsTable } from "./clients";

// [dispatch-events 2026-07-14] Non-job entries the office drops onto the
// dispatch board. One table, three kinds chosen at creation time:
//   - 'tech_block'   : a block on one technician's timeline row (meeting,
//                      training, personal block). assigned_user_id required;
//                      client_id null. Renders as a chip on that tech's row.
//   - 'company_day'  : a company-wide day marker (holiday, all-hands, no-service
//                      day). Not tied to a tech; renders as a banner lane across
//                      the top of the board. May be all_day or a time window.
//   - 'client_visit' : a non-job appointment tied to a client but with no
//                      service/price (estimate walkthrough, drop-off).
//                      assigned_user_id + client_id both set; renders as a chip
//                      on the tech's row.
// Deliberately NOT a job: no service_type, pricing, commission, invoicing, or
// comms. Purely a visibility entry on the board. branch_id scopes it to a
// location (null = all locations, mirrors how the board's branch filter treats
// unbranded rows).
export const dispatchEventsTable = pgTable("dispatch_events", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  branch_id: integer("branch_id").references(() => branchesTable.id),
  kind: text("kind").notNull().default("tech_block"), // tech_block | company_day | client_visit
  title: text("title").notNull(),
  assigned_user_id: integer("assigned_user_id").references(() => usersTable.id),
  client_id: integer("client_id").references(() => clientsTable.id),
  event_date: date("event_date").notNull(),
  start_time: time("start_time"), // "HH:MM:SS" — null when all_day
  end_time: time("end_time"),
  all_day: boolean("all_day").notNull().default(false),
  // [event-address 2026-07-15] Freeform location for the event (defaults to the
  // office in the create modal; editable). Shown to the assigned tech.
  address: text("address"),
  notes: text("notes"),
  color: text("color"),
  created_by_user_id: integer("created_by_user_id").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
});

export const insertDispatchEventSchema = createInsertSchema(dispatchEventsTable).omit({ id: true, created_at: true });
export type InsertDispatchEvent = z.infer<typeof insertDispatchEventSchema>;
export type DispatchEvent = typeof dispatchEventsTable.$inferSelect;
