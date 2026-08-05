// [customer-portal 2026-08-05] Identity for the customer-facing portal.
// Design: docs/CUSTOMER_PORTAL_DESIGN.md — read it before changing these tables.
//
// The governing rule is "one identity system, two capability sets": residential
// and commercial customers share ONE signup / login / reset / impersonation
// surface, and differ only in what they may see and do. So a portal user is a
// person who logs in, and what they can reach is an ATTACHMENT on that person —
// never part of their identity, and never taken from a request body.
//
// Portal identity deliberately lives here rather than on `clients` (where the
// 2026-07-01 portal put it), because a commercial customer is not a client: it's
// an account_contact belonging to an account that owns many buildings.
import { pgTable, serial, text, integer, timestamp, boolean, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { clientsTable } from "./clients";
import { accountContactsTable } from "./account_contacts";
import { usersTable } from "./users";

export const portalProviderEnum = pgEnum("portal_provider", ["google", "apple"]);

// Single-use, short-lived secrets. 'magic' is reserved — the password flow is
// the floor and magic-link sign-in may ride the same table later.
export const portalTokenKindEnum = pgEnum("portal_token_kind", [
  "verify", "reset", "magic", "impersonation",
]);

export const portalUsersTable = pgTable("portal_users", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  email: text("email").notNull(),
  name: text("name"),
  // NULL for social-only accounts — someone who only ever signs in with Google
  // has no password, and that is not an error state.
  password_hash: text("password_hash"),

  // Exactly ONE of these is set. This column is what every portal query scopes
  // by; it is the whole authorization story for a portal session. Enforced by a
  // CHECK constraint in the migration, not just by convention.
  client_id: integer("client_id").references(() => clientsTable.id),
  account_contact_id: integer("account_contact_id").references(() => accountContactsTable.id),

  is_active: boolean("is_active").notNull().default(true),
  email_verified_at: timestamp("email_verified_at"),
  last_login_at: timestamp("last_login_at"),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  // Unique per COMPANY, not globally: the same person can be a customer of two
  // tenants, and lowercased so "Bob@" and "bob@" cannot become two accounts.
  emailPerCompany: uniqueIndex("portal_users_company_email_key").on(t.company_id, t.email),
  byClient: index("portal_users_client_idx").on(t.client_id),
  byContact: index("portal_users_contact_idx").on(t.account_contact_id),
}));

// One row per linked sign-in provider, so a user can have BOTH a password and
// Google without either being the "real" account.
export const portalIdentitiesTable = pgTable("portal_identities", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  portal_user_id: integer("portal_user_id").references(() => portalUsersTable.id, { onDelete: "cascade" }).notNull(),
  provider: portalProviderEnum("provider").notNull(),
  // The provider's stable subject id — NOT the email, which users can change at
  // the provider and which Apple lets them hide behind a relay address.
  subject: text("subject").notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  providerSubject: uniqueIndex("portal_identities_provider_subject_key").on(t.company_id, t.provider, t.subject),
  byUser: index("portal_identities_user_idx").on(t.portal_user_id),
}));

export const portalTokensTable = pgTable("portal_tokens", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  portal_user_id: integer("portal_user_id").references(() => portalUsersTable.id, { onDelete: "cascade" }).notNull(),
  kind: portalTokenKindEnum("kind").notNull(),
  // HASHED at rest. A leaked database row must not be a usable reset link — the
  // raw value exists only in the email that was sent.
  token_hash: text("token_hash").notNull(),
  expires_at: timestamp("expires_at").notNull(),
  used_at: timestamp("used_at"),
  // Set only for 'impersonation': which STAFF user opened this session, so the
  // audit trail names a person and the portal can render its exit banner.
  issued_by_user_id: integer("issued_by_user_id").references(() => usersTable.id),
  created_at: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  hashLookup: uniqueIndex("portal_tokens_hash_key").on(t.token_hash),
  byUser: index("portal_tokens_user_idx").on(t.portal_user_id),
}));

export const insertPortalUserSchema = createInsertSchema(portalUsersTable).omit({ id: true, created_at: true });
export type InsertPortalUser = z.infer<typeof insertPortalUserSchema>;
export type PortalUser = typeof portalUsersTable.$inferSelect;
export type PortalIdentity = typeof portalIdentitiesTable.$inferSelect;
export type PortalToken = typeof portalTokensTable.$inferSelect;
