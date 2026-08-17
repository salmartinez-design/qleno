import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [ai-access-write 2026-08-16] Schema for Phase 5 — write access.
// Design: docs/AI_ACCESS_WRITE_DESIGN.md §4, §5.
//
// Fully idempotent (IF NOT EXISTS throughout); runs on every cold start. No
// backfill and no date sweep — every table here starts empty by definition, and
// a fixed-past-date sweep on the boot path is the mistake that resurrected 55
// deleted visits in the June-fill incident.
//
// Nothing here turns anything on. Write scopes still have to be granted per
// credential, and the tools still have to be advertised.
export async function ensureAiWriteSchema(): Promise<void> {
  // ── Attribution ────────────────────────────────────────────────────────────
  // The audit tables record WHO by user id. That is correct for a browser and
  // wrong for an assistant: the credential belongs to a person, so a write made
  // by Maribel's Claude connection would land in the activity feed reading
  // "Maribel Vega" — indistinguishable from Maribel doing it herself. A blank
  // prompts a question; a wrong name ends the investigation.
  //
  // actor_kind is null for every row written before this and for every ordinary
  // browser write after it, so "null means a human at a keyboard" stays true
  // retroactively without touching a single historical row.
  for (const table of ["app_audit_log", "job_audit_log", "client_audit_log"]) {
    await db.execute(sql`
      ALTER TABLE ${sql.raw(table)}
        ADD COLUMN IF NOT EXISTS actor_kind TEXT,
        ADD COLUMN IF NOT EXISTS actor_credential_id INTEGER,
        ADD COLUMN IF NOT EXISTS actor_label TEXT
    `);
  }

  // ── The undo ledger ────────────────────────────────────────────────────────
  // One row per assistant write, carrying the prior values of exactly the
  // columns it touched. This is what makes "it can move a job" a reversible
  // statement rather than a promise: the office sees the change and presses
  // Revert, rather than reconstructing what Tuesday looked like.
  //
  // prior_values is deliberately a partial row, not a whole one. Restoring a
  // full snapshot would clobber every column another person edited in between —
  // an undo that quietly reverses somebody else's unrelated correction is worse
  // than no undo.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_write_log (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL REFERENCES companies(id),
      -- The person whose credential acted. Not the same claim as "who decided":
      -- they approved the connection, the model chose the moment.
      user_id             INTEGER REFERENCES users(id),
      credential          TEXT NOT NULL,          -- 'key' | 'oauth'
      credential_id       INTEGER NOT NULL,
      credential_name     TEXT,                   -- 'Claude', 'Dispatch bot'
      tool                TEXT NOT NULL,          -- 'reschedule_job'
      target_table        TEXT NOT NULL,
      target_id           TEXT NOT NULL,
      prior_values        JSONB,                  -- only the touched columns
      new_values          JSONB,
      summary             TEXT,                   -- one human line for the list
      idempotency_key     TEXT,
      reverted_at         TIMESTAMPTZ,
      reverted_by         INTEGER REFERENCES users(id),
      revert_error        TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_ai_write_company_time
      ON ai_write_log (company_id, created_at DESC)
  `);
  // The budget query reads "how many writes has this credential made in the
  // last hour", so credential_id leads and time follows.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_ai_write_credential_time
      ON ai_write_log (credential_id, created_at DESC)
  `);

  // ── Idempotency ────────────────────────────────────────────────────────────
  // A tool call that times out on the wire has still run. Without this, the
  // model's retry books the job a second time and the office finds a duplicate
  // nobody asked for. UNIQUE per credential rather than globally, so two
  // tenants generating the same key cannot collide.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_write_idempotency (
      id             SERIAL PRIMARY KEY,
      credential_id  INTEGER NOT NULL,
      credential     TEXT NOT NULL,
      key            TEXT NOT NULL,
      tool           TEXT NOT NULL,
      -- The response we gave the first time, replayed verbatim on a retry. A
      -- retry that gets a DIFFERENT answer is how a model concludes something
      -- changed and starts compensating for a problem that does not exist.
      response       JSONB,
      status         INTEGER,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_write_idem
      ON ai_write_idempotency (credential, credential_id, key)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_ai_write_idem_time
      ON ai_write_idempotency (created_at)
  `);

  // ── The approval queue ─────────────────────────────────────────────────────
  // Group B tools that reach a customer do not act; they propose. The row sits
  // here until a person in Qleno presses Send or Discard.
  //
  // This is also what keeps COMMS_ENABLED honest: a proposal is not a send, so
  // nothing here bypasses the gate. The actual send goes out through the normal
  // office flow, which respects it exactly as it does today.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_write_proposals (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER NOT NULL REFERENCES companies(id),
      user_id           INTEGER REFERENCES users(id),
      credential        TEXT NOT NULL,
      credential_id     INTEGER NOT NULL,
      credential_name   TEXT,
      tool              TEXT NOT NULL,
      payload           JSONB NOT NULL,
      summary           TEXT,
      status            TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|discarded|expired
      decided_at        TIMESTAMPTZ,
      decided_by        INTEGER REFERENCES users(id),
      result            JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_ai_proposals_company_status
      ON ai_write_proposals (company_id, status, created_at DESC)
  `);
}
