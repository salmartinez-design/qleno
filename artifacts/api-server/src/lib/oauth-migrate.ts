import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [ai-access-oauth 2026-08-16] Schema for OAuth 2.1 sign-in, the credential
// path the chat apps require. Design: docs/AI_ACCESS_OAUTH_DESIGN.md §8.
//
// Fully idempotent (IF NOT EXISTS throughout) — runs on every cold start. No
// backfill and no data sweep: the tables start empty by definition. A
// fixed-past-date sweep on the boot path is exactly what resurrected 55 deleted
// visits in the June-fill incident, and nothing here goes near existing rows.
//
// This turns nothing on for anyone. The same companies.api_access_enabled gate
// that guards API keys guards grants, so a company that is off stays off.
export async function ensureOAuthSchema(): Promise<void> {
  // ── Registered clients ─────────────────────────────────────────────────────
  // Written by Dynamic Client Registration (RFC 7591), which is unauthenticated
  // by specification. That is safe here because registration alone grants
  // nothing: a row in this table cannot read a single job until a human has
  // signed in and approved it at the consent screen.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id                 SERIAL PRIMARY KEY,
      client_id          TEXT NOT NULL,
      client_secret_hash TEXT,
      client_name        TEXT NOT NULL,
      client_uri         TEXT,
      redirect_uris      TEXT[] NOT NULL DEFAULT '{}',
      grant_types        TEXT[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
      registered_via     TEXT NOT NULL DEFAULT 'dcr',
      registered_ip      TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at       TIMESTAMPTZ
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_clients_client_id ON oauth_clients (client_id)
  `);

  // ── Authorization codes ────────────────────────────────────────────────────
  // The code itself is never stored, only its SHA-256 — same reasoning as
  // api_keys.secret_hash. A 60-second single-use code is still a bearer
  // credential for that minute, and a leaked database should not hand anyone a
  // usable one.
  //
  // consumed_at exists rather than deleting the row on exchange: a SECOND
  // exchange of the same code has to be detectable, because it means the code
  // leaked, and the response to that is revoking the grant it produced.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      code_hash      TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL,
      company_id     INTEGER NOT NULL REFERENCES companies(id),
      user_id        INTEGER NOT NULL REFERENCES users(id),
      scopes         TEXT[] NOT NULL DEFAULT '{}',
      redirect_uri   TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      resource       TEXT,
      expires_at     TIMESTAMPTZ NOT NULL,
      consumed_at    TIMESTAMPTZ,
      issued_grant_id INTEGER,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry ON oauth_authorization_codes (expires_at)
  `);

  // ── Grants ─────────────────────────────────────────────────────────────────
  // One row per approved connection. user_id is the identity the grant acts as;
  // role is NOT copied here on purpose — it is resolved live from users on every
  // request, which is what makes "deactivate the user" an instant kill switch
  // for their grants exactly as it already is for their keys.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oauth_grants (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER NOT NULL REFERENCES companies(id),
      user_id            INTEGER NOT NULL REFERENCES users(id),
      client_id          TEXT NOT NULL,
      client_name        TEXT NOT NULL,
      scopes             TEXT[] NOT NULL DEFAULT '{}',
      access_token_hash  TEXT NOT NULL,
      access_expires_at  TIMESTAMPTZ NOT NULL,
      refresh_token_hash TEXT,
      refresh_expires_at TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at       TIMESTAMPTZ,
      last_used_ip       TEXT,
      revoked_at         TIMESTAMPTZ,
      revoked_reason     TEXT
    )
  `);
  // UNIQUE for the same reason api_keys.key_id is: this hash is the lookup
  // handle at the door, and two grants sharing one would be indistinguishable.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_grants_access ON oauth_grants (access_token_hash)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_grants_refresh ON oauth_grants (refresh_token_hash)
      WHERE refresh_token_hash IS NOT NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_grants_company ON oauth_grants (company_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants (user_id)
  `);

  // ── Audit bridge ───────────────────────────────────────────────────────────
  // api_request_log already logs every call made with a key. A grant is the
  // other credential type reaching the same doors, so it logs to the same table
  // rather than a parallel one the tenant would have to know to look at.
  //
  // api_key_id was created NOT NULL-free (it is already nullable), so adding a
  // sibling column is purely additive — no existing row changes.
  await db.execute(sql`
    ALTER TABLE api_request_log
      ADD COLUMN IF NOT EXISTS oauth_grant_id INTEGER REFERENCES oauth_grants(id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_req_grant_time ON api_request_log (oauth_grant_id, created_at)
  `);
}

/**
 * Delete expired authorization codes and long-dead grants.
 *
 * Codes live 60 seconds and are worthless after that; grants whose refresh
 * token expired months ago cannot be revived. Neither is referenced by anything
 * that survives them, so this is pure housekeeping — it is NOT a sweep over
 * business data and must never be extended into one.
 *
 * Returns the counts so a caller can log them; a failure here is not worth
 * failing anything else over.
 */
export async function pruneOAuthExpired(): Promise<{ codes: number; grants: number }> {
  const codes = await db.execute(sql`
    DELETE FROM oauth_authorization_codes
     WHERE expires_at < now() - INTERVAL '1 day'
  `);
  // Only rows that are BOTH revoked/expired AND old. A revoked grant is kept
  // for 90 days so "what was connected, and when did it stop" stays answerable
  // after an incident.
  const grants = await db.execute(sql`
    DELETE FROM oauth_grants
     WHERE (revoked_at IS NOT NULL AND revoked_at < now() - INTERVAL '90 days')
        OR (refresh_expires_at IS NOT NULL AND refresh_expires_at < now() - INTERVAL '90 days')
  `);
  return {
    codes: (codes as any).rowCount ?? 0,
    grants: (grants as any).rowCount ?? 0,
  };
}
