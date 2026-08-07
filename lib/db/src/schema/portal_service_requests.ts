// [portal-request-service 2026-08-07] A work request a CUSTOMER submits from
// the portal. Sal: "for some clients who we do a lot of work for we need the
// ability to give them better self serve options for PPM for example."
//
// Deliberately NOT a job. A request is an ASK; a job is a commitment we've made,
// with a price, a cleaner and a slot on the dispatch board. Letting a customer
// write directly into `jobs` would put unpriced, unassigned work on the board
// and into revenue. So requests land here, the office reviews them, and the
// office creates the job — the existing, correct path.
import { pgTable, serial, text, integer, timestamp, date, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { accountsTable } from "./accounts";
import { clientsTable } from "./clients";
import { accountPropertiesTable } from "./account_properties";
import { portalUsersTable } from "./portal";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";

export const portalServiceRequestStatusEnum = pgEnum("portal_service_request_status", [
  "pending", "scheduled", "declined",
]);

export const portalServiceRequestsTable = pgTable("portal_service_requests", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),

  // Who it's for. Exactly one of these, mirroring portal_users' attachment —
  // the request inherits the requester's scope and can never be filed against
  // an account they don't belong to.
  account_id: integer("account_id").references(() => accountsTable.id),
  client_id: integer("client_id").references(() => clientsTable.id),
  // Which building, for a commercial account. Validated against the account.
  account_property_id: integer("account_property_id").references(() => accountPropertiesTable.id),

  requested_by_portal_user_id: integer("requested_by_portal_user_id")
    .references(() => portalUsersTable.id).notNull(),

  // Free text, not the service_type enum: a customer asking for "turnover on
  // 4B" should not be forced to guess our internal slugs, and a bad guess would
  // be worse than plain words the office can read.
  service_description: text("service_description").notNull(),
  preferred_date: date("preferred_date"),
  notes: text("notes"),

  status: portalServiceRequestStatusEnum("status").notNull().default("pending"),
  // Set when the office turns a request into real work, so the request stops
  // being actionable and can be traced to what it became.
  resulting_job_id: integer("resulting_job_id").references(() => jobsTable.id),
  reviewed_by_user_id: integer("reviewed_by_user_id").references(() => usersTable.id),
  reviewed_at: timestamp("reviewed_at"),
  office_note: text("office_note"),

  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  byCompanyStatus: index("portal_service_requests_company_status_idx").on(t.company_id, t.status),
  byAccount: index("portal_service_requests_account_idx").on(t.account_id),
}));

export const insertPortalServiceRequestSchema =
  createInsertSchema(portalServiceRequestsTable).omit({ id: true, created_at: true });
export type InsertPortalServiceRequest = z.infer<typeof insertPortalServiceRequestSchema>;
export type PortalServiceRequest = typeof portalServiceRequestsTable.$inferSelect;
