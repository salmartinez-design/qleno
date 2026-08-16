import { pgTable, serial, text, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// [ai-access 2026-08-15] Machine credentials for Qleno Connect (the versioned
// REST API at /api/v1) and Qleno Agent (the MCP server at /mcp). One credential
// type serves both — separate auth per product would double the security
// surface for no benefit. Source of truth: docs/AI_ACCESS_DESIGN.md.
//
// WHY NOT REUSE THE LOGIN JWT:
//   A JWT is a session — 30 days, no scopes, no revocation list, minted by
//   typing a password, and it identifies a human. An API key is a machine
//   credential and needs six things the session token cannot give it:
//   independent revocation, per-key rate limits, per-key audit, scope
//   narrowing, a last-used record, and rotation with overlap. Overloading the
//   session token for machines gives up all six.
//
// TOKEN FORMAT: qlno_live_<key_id>_<secret>   (qlno_test_ reserved for a future
// sandbox tenant). key_id is public and indexed so verification is ONE index
// hit; without it every request would have to hash against every row.
//
// THE PREFIX IS LOAD-BEARING: it is fixed and greppable specifically so GitHub
// secret scanning and similar tools can pattern-match a leaked key. Do not make
// it configurable or tenant-specific.
export const apiKeysTable = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),

  // The human this key acts as. Role is NOT copied onto this row — it is
  // resolved live from the user on every request, so deactivating someone or
  // reducing their role immediately follows through to their keys. A frozen
  // role snapshot here would let an offboarded manager's key keep manager
  // powers forever.
  user_id: integer("user_id").references(() => usersTable.id).notNull(),

  // Public half of the token. Shown in the UI forever (qlno_live_a1b2c3d4…) so
  // a key is identifiable in logs and activity without ever revealing a secret.
  key_id: text("key_id").notNull(),

  // SHA-256 hex of the secret half. Deliberately NOT bcrypt: bcrypt's cost is a
  // defense against brute-forcing LOW-entropy human passwords, and this secret
  // is 32 CSPRNG bytes — unbruteforceable by construction. At 300 req/min a
  // bcrypt verify per request would burn real CPU for zero added safety. This
  // is the same trade Stripe and GitHub make, for the same reason.
  secret_hash: text("secret_hash").notNull(),

  // Tenant-chosen label: "Francisco's Gemini", "Zapier — invoice sync".
  // Surfaced in the activity feed as the actor, so it must read like a thing a
  // person would recognise, not an opaque id.
  name: text("name").notNull(),

  // Least privilege. See docs/AI_ACCESS_DESIGN.md §2 for the full list.
  // Minting defaults every *:read scope ON and every write scope OFF; comms:send
  // and payments:charge additionally require an explicit second confirmation in
  // the UI. Effective permission is always plan ∩ user role ∩ these scopes —
  // a scope can only ever NARROW what the minting user could already do.
  scopes: text("scopes").array().notNull().default([]),

  last_used_at: timestamp("last_used_at", { withTimezone: true }),
  // Surfaced to the tenant so an unfamiliar caller is visible without a support
  // ticket — the cheapest leak detector we have.
  last_used_ip: text("last_used_ip"),

  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  created_by: integer("created_by").references(() => usersTable.id).notNull(),

  // Null = no expiry. Present so a tenant can issue a short-lived key to a
  // contractor without relying on remembering to revoke it.
  expires_at: timestamp("expires_at", { withTimezone: true }),
  revoked_at: timestamp("revoked_at", { withTimezone: true }),
  revoked_by: integer("revoked_by").references(() => usersTable.id),

  // Rotation lineage. "Roll key" mints a replacement pointing back here and
  // leaves this row valid for a 24h overlap, so a live integration can be
  // updated without downtime. Without the overlap, rotation means an outage,
  // which means nobody rotates.
  rotated_from: integer("rotated_from"),
}, (t) => ({
  // The verification path: split the token, look up key_id, compare hashes.
  uqKeyId: uniqueIndex("uq_api_keys_key_id").on(t.key_id),
  // The Settings list: a tenant's keys, newest first.
  byCompany: index("idx_api_keys_company").on(t.company_id, t.created_at),
  // Cascade on user deactivation / role change.
  byUser: index("idx_api_keys_user").on(t.user_id),
}));

// [ai-access 2026-08-15] Every API and MCP call, for rate accounting, tenant-
// visible activity, and incident forensics.
//
// WHAT IS DELIBERATELY NOT STORED: request and response BODIES. This table
// would otherwise become the largest uncontrolled store of customer PII in the
// system — every client address and phone number that ever crossed the API,
// retained indefinitely, outside the RLS that protects the source tables.
// arg_digest keeps SHAPE only (which filters were used, how many rows came
// back) — enough to debug a misbehaving integration, never enough to
// reconstruct a customer record.
//
// Pruned at 90 days. Writes are fire-and-forget: a logging failure must never
// fail the caller's request, but it IS reported to the startup/error channel
// rather than swallowed silently.
export const apiRequestLogTable = pgTable("api_request_log", {
  id: serial("id").primaryKey(),
  company_id: integer("company_id").references(() => companiesTable.id).notNull(),
  api_key_id: integer("api_key_id").references(() => apiKeysTable.id),
  // [ai-access-oauth 2026-08-16] The other credential type. A call arrives with
  // EITHER a minted key or an approved OAuth grant, so exactly one of these two
  // columns is set and the other is null. Deliberately not a FK reference here:
  // oauth_grants is created by the boot migration in lib/oauth-migrate.ts rather
  // than declared in this schema package, and pointing a Drizzle reference at a
  // table this file cannot see would not compile. The database-level foreign key
  // is added there, where the table exists.
  oauth_grant_id: integer("oauth_grant_id"),
  user_id: integer("user_id"),

  // 'rest' | 'mcp' — the two front doors share this table so per-company rate
  // accounting and the tenant activity view don't have to union two sources.
  kind: text("kind").notNull(),
  // For rest: the matched ROUTE PATTERN (/api/v1/jobs/:id), never the raw path.
  // Raw paths carry record ids, which turns the log into a browsing history.
  // For mcp: the tool name.
  route: text("route").notNull(),
  method: text("method"),
  status: integer("status"),

  duration_ms: integer("duration_ms"),
  bytes_out: integer("bytes_out"),
  ip: text("ip"),
  user_agent: text("user_agent"),

  // Shape only — filter keys used, result counts, confirm flag. No values that
  // could identify a customer. See the note above.
  arg_digest: jsonb("arg_digest"),

  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // The tenant activity view and the 90-day prune both scan this way.
  byCompanyTime: index("idx_api_req_company_time").on(t.company_id, t.created_at),
  // Per-key activity in Settings.
  byKeyTime: index("idx_api_req_key_time").on(t.api_key_id, t.created_at),
}));

export const insertApiKeySchema = createInsertSchema(apiKeysTable).omit({ id: true, created_at: true });
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeysTable.$inferSelect;
export type ApiRequestLog = typeof apiRequestLogTable.$inferSelect;
