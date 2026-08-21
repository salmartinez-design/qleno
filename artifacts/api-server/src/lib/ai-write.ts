import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AssistantActor } from "./audit.js";

// [ai-access-write 2026-08-16] The machinery every assistant write goes through.
// Design: docs/AI_ACCESS_WRITE_DESIGN.md §4.
//
// The organising idea: NONE of the safety here is a question asked of the model.
// A `confirm: true` argument is not a defence — the model supplies it, and a
// model that has been talked into cancelling tomorrow will happily also supply
// the confirmation. Everything in this file is enforced server-side, on facts
// the model cannot author: how many writes this credential has already made,
// whether these exact arguments have been seen before, and what the row looked
// like beforehand.

// ── Budgets ──────────────────────────────────────────────────────────────────
// Reads are capped at 600/min per company. Writes are capped four orders of
// magnitude lower, and for a different reason: the read limit is about load, the
// write limit is about blast radius. "Cancel everything tomorrow" is not one
// catastrophic call, it is forty ordinary ones — so the ceiling is set where a
// runaway loop trips it long before it finishes, while a real afternoon of
// dispatch help never comes close.
export const WRITE_BUDGET_PER_HOUR = 20;
export const WRITE_BUDGET_PER_DAY = 60;

export type BudgetVerdict =
  | { ok: true; hourUsed: number; dayUsed: number }
  | { ok: false; message: string; hourUsed: number; dayUsed: number };

/**
 * How many writes this credential has already made, against both ceilings.
 *
 * Counted per CREDENTIAL, not per company: one runaway connection should not be
 * able to spend the whole company's allowance and lock out a colleague's, and a
 * tenant with three connections legitimately does three times the work.
 *
 * Reverted writes still count. They happened, somebody had to notice them, and
 * a limiter that forgives whatever was undone is a limiter that can be reset by
 * causing more work for the office.
 */
export async function checkWriteBudget(actor: AssistantActor): Promise<BudgetVerdict> {
  const r = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour_used,
      count(*) FILTER (WHERE created_at > now() - interval '1 day')  AS day_used
    FROM ai_write_log
    WHERE credential = ${actor.kind} AND credential_id = ${actor.credentialId}
  `);
  const row = (r.rows?.[0] as any) ?? {};
  const hourUsed = Number(row.hour_used ?? 0);
  const dayUsed = Number(row.day_used ?? 0);

  // The message names the ceiling and says the work is not lost. An assistant
  // told only "denied" will retry; one told "the office can still do this in
  // Qleno" reports something the operator can act on.
  if (hourUsed >= WRITE_BUDGET_PER_HOUR) {
    return {
      ok: false, hourUsed, dayUsed,
      message:
        `This connection has made ${hourUsed} changes in the last hour, which is its limit. ` +
        `Nothing is broken and nothing was lost — the change can still be made in Qleno directly, ` +
        `and the limit clears as the hour rolls forward. Do not retry.`,
    };
  }
  if (dayUsed >= WRITE_BUDGET_PER_DAY) {
    return {
      ok: false, hourUsed, dayUsed,
      message:
        `This connection has made ${dayUsed} changes today, which is its daily limit. ` +
        `The change can still be made in Qleno directly. Do not retry.`,
    };
  }
  return { ok: true, hourUsed, dayUsed };
}

// ── Idempotency ──────────────────────────────────────────────────────────────

/** How long a completed write answers a repeat with its original response. */
export const IDEMPOTENCY_WINDOW_MINUTES = 10;

/**
 * A stable key for one tool call, derived server-side.
 *
 * NOT taken from the model. A key the model chooses is a key it can vary on a
 * retry, which is the same as having none — and the failure it is meant to stop
 * (a timed-out call that actually ran, retried into a duplicate) is precisely
 * the moment a model would generate a fresh one.
 *
 * Arguments are canonicalised by sorting keys, so `{a,b}` and `{b,a}` are the
 * same call. Two genuinely different requests a minute apart differ in at least
 * one argument and get different keys; two identical requests a minute apart
 * are, as far as anyone can tell from here, a retry.
 */
export function writeIdempotencyKey(req: Request, tool: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args, Object.keys(args).sort());
  const cred = `${req.apiKey?.credential ?? "none"}:${req.apiKey?.keyId ?? 0}`;
  return createHash("sha256").update(`${cred}|${tool}|${canonical}`).digest("base64url").slice(0, 32);
}

export type IdempotentHit = { status: number; body: any };

/**
 * The response this exact call already produced, if it is inside the window.
 *
 * Replaying the ORIGINAL response matters more than it looks. A retry that gets
 * a different answer — "already rescheduled" instead of "rescheduled" — is how
 * a model concludes the world changed underneath it and starts compensating for
 * a problem that does not exist.
 */
export async function findIdempotent(
  actor: AssistantActor, key: string,
): Promise<IdempotentHit | null> {
  const r = await db.execute(sql`
    SELECT status, response FROM ai_write_idempotency
    WHERE credential = ${actor.kind} AND credential_id = ${actor.credentialId} AND key = ${key}
      AND created_at > now() - (${IDEMPOTENCY_WINDOW_MINUTES} * interval '1 minute')
    LIMIT 1
  `);
  const row = (r.rows?.[0] as any) ?? null;
  if (!row) return null;
  return { status: Number(row.status ?? 200), body: row.response ?? null };
}

export async function recordIdempotent(
  actor: AssistantActor, key: string, tool: string, status: number, body: any,
): Promise<void> {
  try {
    // ON CONFLICT DO UPDATE, never a plain INSERT (house rule) — and here it
    // also resets the window, so a genuine repeat an hour later is treated as a
    // fresh call rather than silently replaying a stale answer.
    await db.execute(sql`
      INSERT INTO ai_write_idempotency (credential, credential_id, key, tool, status, response, created_at)
      VALUES (${actor.kind}, ${actor.credentialId}, ${key}, ${tool}, ${status}, ${JSON.stringify(body ?? null)}::jsonb, now())
      ON CONFLICT (credential, credential_id, key)
      DO UPDATE SET status = EXCLUDED.status, response = EXCLUDED.response, created_at = now()
    `);
  } catch (err) {
    // A failed idempotency record must not fail the write that already
    // succeeded. The cost of losing it is one possible duplicate on a retry;
    // the cost of throwing is telling the caller a completed change failed.
    console.error("[ai-write] recordIdempotent failed:", err);
  }
}

// ── The undo ledger ──────────────────────────────────────────────────────────

export type WriteRecord = {
  companyId: number;
  userId: number | null;
  actor: AssistantActor;
  tool: string;
  targetTable: string;
  targetId: string | number;
  /** ONLY the columns this write touched, as they were before. */
  priorValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  /** One plain line for the "Recent assistant changes" list. */
  summary: string;
  idempotencyKey?: string;
};

/**
 * Record an assistant write so it can be seen and undone.
 *
 * priorValues is a PARTIAL row on purpose. Restoring a full snapshot would
 * clobber every column somebody else edited in between — an undo that quietly
 * reverses an unrelated correction made by a colleague is worse than no undo at
 * all, because nobody is looking for it.
 *
 * Returns the ledger row id, or null if the ledger write itself failed. A
 * failure here is logged and swallowed for the same reason logAudit swallows:
 * the business change already committed, and throwing now would report a
 * completed write as an error and invite a retry that duplicates it.
 */
export async function recordAssistantWrite(rec: WriteRecord): Promise<number | null> {
  try {
    const r = await db.execute(sql`
      INSERT INTO ai_write_log
        (company_id, user_id, credential, credential_id, credential_name,
         tool, target_table, target_id, prior_values, new_values, summary, idempotency_key)
      VALUES
        (${rec.companyId}, ${rec.userId}, ${rec.actor.kind}, ${rec.actor.credentialId}, ${rec.actor.label},
         ${rec.tool}, ${rec.targetTable}, ${String(rec.targetId)},
         ${rec.priorValues ? JSON.stringify(rec.priorValues) : null}::jsonb,
         ${rec.newValues ? JSON.stringify(rec.newValues) : null}::jsonb,
         ${rec.summary}, ${rec.idempotencyKey ?? null})
      RETURNING id
    `);
    const id = (r.rows?.[0] as any)?.id;
    return id != null ? Number(id) : null;
  } catch (err) {
    console.error("[ai-write] recordAssistantWrite failed:", err);
    return null;
  }
}

// ── The shape a write tool answers with ──────────────────────────────────────

/**
 * Every write answers with what changed, in the caller's own vocabulary, plus
 * how to undo it.
 *
 * Naming the undo path in the response is not decoration. The model reports
 * this text to the operator, and an operator who is told where the Revert
 * button is will check the change; one who is only told "done" will not.
 */
export function writeResult(opts: {
  summary: string;
  changed: Record<string, unknown>;
  writeId: number | null;
}): Record<string, unknown> {
  return {
    ok: true,
    summary: opts.summary,
    changed: opts.changed,
    undo: opts.writeId
      ? "This change is listed under Settings → AI & API Access → Recent assistant changes, where it can be reverted."
      : null,
    note: "Tell the person what changed, in full, including anything they did not ask about.",
  };
}

/** Read the idempotency key off a dispatched request, if the caller set one. */
export function idempotencyKeyOf(req: Request): string | undefined {
  const v = req.headers["idempotency-key"];
  const s = Array.isArray(v) ? v[0] : v;
  return s && String(s).length > 0 ? String(s) : undefined;
}

/** Refuse a write, in the v1 error shape, with a message written for a model. */
export function refuseWrite(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

// ── Reading the ledger back ──────────────────────────────────────────────────

export type LedgerEntry = {
  id: number;
  tool: string;
  summary: string | null;
  connection: string | null;
  person: string | null;
  target_table: string;
  target_id: string;
  created_at: string | null;
  reverted_at: string | null;
  reverted_by_name: string | null;
  revert_error: string | null;
  revertable: boolean;
};

/**
 * Recent assistant changes for one company, newest first.
 *
 * Scoped by company_id like everything else, and joined to users so the list
 * reads as sentences rather than ids — the office is scanning this to answer
 * "did something move that I did not move", and an id column does not answer it.
 */
export async function listAssistantWrites(companyId: number, limit = 50): Promise<LedgerEntry[]> {
  const r = await db.execute(sql`
    SELECT w.id, w.tool, w.summary, w.credential_name, w.target_table, w.target_id,
           w.created_at, w.reverted_at, w.revert_error,
           TRIM(CONCAT(u.first_name, ' ', u.last_name))   AS person,
           TRIM(CONCAT(ru.first_name, ' ', ru.last_name)) AS reverted_by_name
      FROM ai_write_log w
      LEFT JOIN users u  ON u.id = w.user_id
      LEFT JOIN users ru ON ru.id = w.reverted_by
     WHERE w.company_id = ${companyId}
     ORDER BY w.created_at DESC
     LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `);
  return (r.rows ?? []).map((row: any) => ({
    id: Number(row.id),
    tool: String(row.tool),
    summary: row.summary ?? null,
    connection: row.credential_name ?? null,
    person: row.person || null,
    target_table: String(row.target_table),
    target_id: String(row.target_id),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    reverted_at: row.reverted_at ? new Date(row.reverted_at).toISOString() : null,
    reverted_by_name: row.reverted_by_name || null,
    revert_error: row.revert_error ?? null,
    revertable: row.reverted_at == null && REVERTABLE_TABLES.has(String(row.target_table)),
  }));
}

// ── Revert ───────────────────────────────────────────────────────────────────

/**
 * What may be put back, column by column.
 *
 * A whitelist rather than "write prior_values back wherever it came from",
 * because prior_values is JSON that reached the ledger from a handler, and a
 * generic writer would turn any future bug in any handler into arbitrary column
 * writes. Adding a revertable field is a deliberate edit here.
 */
const REVERTABLE: Record<string, readonly string[]> = {
  jobs: ["scheduled_date", "scheduled_time", "assigned_user_id", "office_notes"],
  clients: ["email", "phone"],
  // [owner-only-deactivate 2026-08-19] Deactivating a person is the one Group-C
  // write that undoes cleanly, because it never destroyed anything: is_active
  // flipped, future work fell to Unassigned, completed jobs kept their
  // assignment. Putting the flag back restores the account. It does NOT put the
  // released jobs back on that person — that is a dispatch decision, and
  // silently re-assigning work the office has since given to somebody else
  // would be the reverting-somebody-else's-fix mistake this whole file guards
  // against. The revert message below says so rather than leaving it implied.
  users: ["is_active"],
};
const REVERTABLE_TABLES = new Set(Object.keys(REVERTABLE));

// What to tell the office when a change is on a table Revert does not drive.
// The generic line ("make the correction in Qleno directly") is true but
// unhelpful when the correction has an obvious name and place.
const NOT_REVERTABLE_HINT: Record<string, string> = {
  quotes:
    "A quote cannot be un-sent — the customer already has the email. Open the quote in Qleno " +
    "to edit and re-send it, or mark it lost.",
  recurring_schedules:
    "A recurring schedule cannot be reverted automatically, because visits have already been " +
    "generated from it. Open the client's schedule in Qleno to change the cadence or cancel it, " +
    "which also decides what happens to the visits already on the board.",
};

export type RevertOutcome =
  | { ok: true; summary: string }
  | { ok: false; status: number; error: string; message: string };

const asText = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);

/**
 * Put one assistant change back.
 *
 * THE CHECK THAT MATTERS is not "was this reverted already" — it is "does the
 * row still look the way the assistant left it". If somebody has edited the job
 * since, reverting would silently throw their work away, and they would have no
 * reason to look. So a changed field refuses and names what it found, and the
 * office decides.
 *
 * The revert is attributed to the PERSON who pressed the button, with no actor,
 * because a human undid it. The original assistant row stays exactly as it was —
 * the trail shows both the change and the reversal, not an edited history.
 */
export async function revertAssistantWrite(opts: {
  writeId: number;
  companyId: number;
  userId: number | null;
}): Promise<RevertOutcome> {
  const { writeId, companyId, userId } = opts;
  const r = await db.execute(sql`
    SELECT id, target_table, target_id, prior_values, new_values, summary, reverted_at
      FROM ai_write_log WHERE id = ${writeId} AND company_id = ${companyId} LIMIT 1
  `);
  const row = (r.rows?.[0] as any) ?? null;
  if (!row) {
    return { ok: false, status: 404, error: "not_found", message: "No such change." };
  }
  if (row.reverted_at) {
    return { ok: false, status: 409, error: "already_reverted", message: "That change has already been reverted." };
  }

  const table = String(row.target_table);
  const allowed = REVERTABLE[table];
  if (!allowed) {
    return {
      ok: false, status: 400, error: "not_revertable",
      message: NOT_REVERTABLE_HINT[table]
        ?? `Changes to ${table} cannot be reverted automatically. Make the correction in Qleno directly.`,
    };
  }

  const prior = (row.prior_values ?? {}) as Record<string, unknown>;
  const applied = (row.new_values ?? {}) as Record<string, unknown>;
  const fields = Object.keys(prior).filter((f) => allowed.includes(f));
  if (fields.length === 0) {
    return {
      ok: false, status: 400, error: "not_revertable",
      message: "This change did not record anything that can be put back.",
    };
  }

  const targetId = Number(row.target_id);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return { ok: false, status: 400, error: "not_revertable", message: "This change points at a row that cannot be located." };
  }

  // Current state, as text, so a DATE column and the JSON string it was recorded
  // as compare as the same thing rather than as Date vs "2026-08-20".
  const cols = table === "jobs"
    ? sql`to_char(scheduled_date, 'YYYY-MM-DD') AS scheduled_date, scheduled_time, assigned_user_id, office_notes`
    : table === "users"
    ? sql`is_active`
    : sql`email, phone`;
  const cur = await db.execute(sql`
    SELECT ${cols} FROM ${sql.raw(table)} WHERE id = ${targetId} AND company_id = ${companyId} LIMIT 1
  `);
  const live = (cur.rows?.[0] as any) ?? null;
  if (!live) {
    return {
      ok: false, status: 404, error: "not_found",
      message: "The record this change touched no longer exists, so there is nothing to put back.",
    };
  }

  for (const f of fields) {
    const nowVal = asText(live[f]);
    const wasSetTo = asText(applied[f]);
    if (nowVal !== wasSetTo) {
      return {
        ok: false, status: 409, error: "changed_since",
        message:
          `This cannot be reverted automatically: ${f.replace(/_/g, " ")} has been changed again since ` +
          `(it now reads "${nowVal ?? "empty"}", not "${wasSetTo ?? "empty"}"). ` +
          `Reverting would undo that later edit as well. Make the correction in Qleno directly.`,
      };
    }
  }

  // One UPDATE, only the whitelisted columns this write actually touched.
  const sets = fields.map((f) => {
    const v = prior[f];
    if (f === "scheduled_date") return sql`scheduled_date = ${asText(v)}::date`;
    if (f === "assigned_user_id") return sql`assigned_user_id = ${v == null ? null : Number(v)}`;
    // A text parameter against a boolean column is a type error in Postgres,
    // not a coercion — bind the boolean itself.
    if (f === "is_active") return sql`is_active = ${v === true || v === "true"}`;
    return sql`${sql.raw(f)} = ${asText(v)}`;
  });
  await db.execute(sql`
    UPDATE ${sql.raw(table)} SET ${sql.join(sets, sql`, `)}
     WHERE id = ${targetId} AND company_id = ${companyId}
  `);

  // The mirror again. Reverting an assignment without it leaves the board and
  // the job card disagreeing, which is the exact split-brain the invariant in
  // CLAUDE.md exists to prevent — and it would be blamed on the assistant.
  if (table === "jobs" && fields.includes("assigned_user_id")) {
    const back = prior.assigned_user_id == null ? null : Number(prior.assigned_user_id);
    if (back === null) {
      await db.execute(sql`UPDATE job_technicians SET is_primary = false WHERE job_id = ${targetId} AND is_primary = true`);
    } else {
      await db.execute(sql`
        UPDATE job_technicians SET is_primary = false
         WHERE job_id = ${targetId} AND is_primary = true AND user_id <> ${back}
      `);
      await db.execute(sql`
        INSERT INTO job_technicians (job_id, user_id, company_id, is_primary)
        VALUES (${targetId}, ${back}, ${companyId}, true)
        ON CONFLICT (job_id, user_id) DO UPDATE SET is_primary = true
      `);
    }
  }

  const changes = fields.map((f) => ({ field: f, from: applied[f] ?? null, to: prior[f] ?? null }));
  const { logJobFieldChanges, logClientFieldChanges } = await import("./audit.js");
  if (table === "jobs") {
    await logJobFieldChanges({ companyId, jobId: targetId, userId, actor: null, changes });
  } else {
    await logClientFieldChanges({ companyId, clientId: targetId, userId, actor: null, changes });
  }

  await db.execute(sql`
    UPDATE ai_write_log SET reverted_at = now(), reverted_by = ${userId}, revert_error = NULL
     WHERE id = ${writeId} AND company_id = ${companyId}
  `);

  return { ok: true, summary: `Reverted: ${row.summary ?? `change #${writeId}`}` };
}
