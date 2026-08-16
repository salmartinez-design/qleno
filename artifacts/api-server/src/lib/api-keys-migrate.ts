import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [ai-access 2026-08-15] Schema for the machine credentials behind Qleno
// Connect (/api/v1) and Qleno Agent (/mcp). Design: docs/AI_ACCESS_DESIGN.md §8.
//
// Fully idempotent (IF NOT EXISTS throughout) — this runs on every cold start.
// No data sweep, no backfill: there is nothing to migrate, the feature starts
// empty by definition, and a fixed-date sweep on the boot path is exactly the
// mistake that resurrected 55 deleted visits in the June-fill incident.
//
// api_access_enabled defaults FALSE, so shipping this turns nothing on for
// anyone. The feature stays inert until a company is explicitly switched on.
export async function ensureApiKeysSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS api_keys (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER NOT NULL REFERENCES companies(id),
      user_id       INTEGER NOT NULL REFERENCES users(id),
      key_id        TEXT NOT NULL,
      secret_hash   TEXT NOT NULL,
      name          TEXT NOT NULL,
      scopes        TEXT[] NOT NULL DEFAULT '{}',
      last_used_at  TIMESTAMPTZ,
      last_used_ip  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by    INTEGER NOT NULL REFERENCES users(id),
      expires_at    TIMESTAMPTZ,
      revoked_at    TIMESTAMPTZ,
      revoked_by    INTEGER REFERENCES users(id),
      rotated_from  INTEGER
    )
  `);

  // UNIQUE, not just an index: key_id is the lookup handle for verification, and
  // a collision would make two credentials indistinguishable at the door.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_key_id ON api_keys (key_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_keys_company ON api_keys (company_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS api_request_log (
      id           SERIAL PRIMARY KEY,
      company_id   INTEGER NOT NULL REFERENCES companies(id),
      api_key_id   INTEGER REFERENCES api_keys(id),
      user_id      INTEGER,
      kind         TEXT NOT NULL,
      route        TEXT NOT NULL,
      method       TEXT,
      status       INTEGER,
      duration_ms  INTEGER,
      bytes_out    INTEGER,
      ip           TEXT,
      user_agent   TEXT,
      arg_digest   JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_req_company_time ON api_request_log (company_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_req_key_time ON api_request_log (api_key_id, created_at)
  `);

  // The gate. See the column comment in lib/db/src/schema/companies.ts: the plan
  // is what SETS this, but this is what's READ, so a design-partner grant or an
  // incident kill switch never has to touch anyone's billing.
  await db.execute(sql`
    ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS api_access_enabled BOOLEAN NOT NULL DEFAULT false
  `);
}
