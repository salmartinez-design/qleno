import { Request } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [ai-access-write 2026-08-16] Assistant attribution.
// Design: docs/AI_ACCESS_WRITE_DESIGN.md §5.
//
// A credential belongs to a person, so without this an assistant's write lands
// in the activity feed under that person's name — Maribel's Claude connection
// moving a job would read exactly like Maribel moving it. That is worse than no
// record at all: a blank prompts a question, a wrong name ends the
// investigation before it starts.
//
// The person is still recorded, because they are still accountable — they
// approved the connection. What changes is that the row also says the request
// came through it. `null` means a human at a keyboard, which is what every
// historical row and every ordinary browser write is.
export type AssistantActor = {
  kind: "key" | "oauth";
  credentialId: number;
  /** The credential's own name: "Claude", "ChatGPT", "Dispatch bot". */
  label: string;
};

/**
 * The assistant behind this request, or null for a browser.
 *
 * Reads req.apiKey, which only exists on routes mounted behind requireApiKey —
 * so an internal route can call this freely and always get null.
 */
export function assistantActor(req: Request): AssistantActor | null {
  const k = req.apiKey;
  if (!k) return null;
  return { kind: k.credential, credentialId: k.keyId, label: k.name };
}

/**
 * The name to show in a feed.
 *
 * Composed at WRITE time, into the same user_name column every existing feed
 * already renders. Storing the structured columns and composing at read time
 * would be tidier and would also mean every surface that forgot to join them
 * keeps showing the bare human name — there are five such surfaces today and
 * new ones get added without reading this file. One string, everywhere, now.
 */
export function actorDisplayName(person: string | null | undefined, actor: AssistantActor | null): string {
  const who = (person ?? "").trim();
  if (!actor) return who || "Unknown";
  return who ? `${who} via ${actor.label}` : actor.label;
}

export async function logAudit(
  req: Request,
  action: string,
  targetType: string,
  targetId: string | number | null,
  oldValue?: Record<string, unknown> | null,
  newValue?: Record<string, unknown> | null
): Promise<void> {
  try {
    const userId = req.auth?.userId ?? null;
    const companyId = req.auth?.companyId ?? null;
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
      ?? req.socket?.remoteAddress
      ?? null;
    const userAgent = req.headers["user-agent"] ?? null;
    const actor = assistantActor(req);

    await db.execute(sql`
      INSERT INTO app_audit_log
        (company_id, performed_by, action, target_type, target_id,
         old_value, new_value, ip_address, user_agent, performed_at,
         actor_kind, actor_credential_id, actor_label)
      VALUES
        (${companyId}, ${userId}, ${action}, ${targetType}, ${String(targetId ?? "")},
         ${oldValue ? JSON.stringify(oldValue) : null}::jsonb,
         ${newValue ? JSON.stringify(newValue) : null}::jsonb,
         ${ip}, ${userAgent}, now(),
         ${actor?.kind ?? null}, ${actor?.credentialId ?? null}, ${actor?.label ?? null})
    `);
  } catch (err) {
    // Never let audit logging crash a request
    console.error("[audit] Failed to write audit log:", err);
  }
}

// [completion-audit 2026-07-28] Records a job status change into job_audit_log
// so it surfaces automatically in the Customer profile → Activity feed and the
// Account console (both read job_audit_log per-field rows via field_name — see
// clients.ts:1422 / accounts.ts:614). Used at every path that flips a job to
// 'complete' (office Mark Complete, field/office clock-out, GPS clock-out, bulk,
// charged cancel, recurring back-fill) and by the ghost-completion auto-revert.
//
// old_value/new_value use the { value } shape the activity feed's describeEdit
// already unwraps; new_value also carries a human-readable `source` (the path)
// and optional `note` so the feed renders "Marked complete — clock-out" etc.
//
// Pass `exec` = a transaction handle when the job row was created/updated inside
// an as-yet-uncommitted tx (recurring back-fill, charged cancel) — a separate
// connection can't see the uncommitted job and the FK insert would fail.
// System actors (no single user) pass actorUserId=null with actorName set.
export async function logJobStatusChange(
  opts: {
    companyId: number | null;
    jobId: number;
    actorUserId: number | null;
    actorName?: string | null;
    priorStatus: string | null;
    newStatus: string;
    source: string;
    note?: string | null;
    /** Set when an assistant made this change — see assistantActor(). */
    actor?: AssistantActor | null;
  },
  exec: { execute: (q: ReturnType<typeof sql>) => Promise<any> } = db,
): Promise<void> {
  // company_id is NOT NULL on job_audit_log; skip (non-fatal) if we somehow
  // have no tenant context rather than throwing inside a completion path.
  if (opts.companyId == null) return;
  try {
    let userId: number | null = opts.actorUserId ?? null;
    let name = opts.actorName ?? "Qleno";
    let email = "system";
    if (userId != null) {
      const u = await exec.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1`);
      const row = (u.rows?.[0] as any) ?? null;
      if (row) {
        name = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || (opts.actorName ?? "Unknown");
        email = row.email ?? "";
      }
    }
    const actor = opts.actor ?? null;
    const newVal: Record<string, unknown> = { value: opts.newStatus, source: opts.source };
    if (opts.note) newVal.note = opts.note;
    await exec.execute(sql`
      INSERT INTO job_audit_log
        (job_id, company_id, user_id, user_name, user_email,
         field_name, old_value, new_value, cascade_scope,
         actor_kind, actor_credential_id, actor_label)
      VALUES
        (${opts.jobId}, ${opts.companyId}, ${userId}, ${actorDisplayName(name, actor)}, ${email},
         'status',
         ${JSON.stringify({ value: opts.priorStatus })}::jsonb,
         ${JSON.stringify(newVal)}::jsonb,
         'this_job',
         ${actor?.kind ?? null}, ${actor?.credentialId ?? null}, ${actor?.label ?? null})
    `);
  } catch (err) {
    // Never let audit logging crash a completion / revert.
    console.error("[audit] logJobStatusChange failed:", err);
  }
}

// [ai-access-write 2026-08-16] Per-FIELD job history rows — the ones the
// customer profile → Activity feed and the Account console actually read
// (clients.ts / accounts.ts select job_audit_log by field_name).
//
// This exists because app_audit_log is not the feed. A change written only
// there is invisible on the customer's timeline, which is the difference
// between "the office can see who moved this visit" and "the office can see it
// moved". Sal's condition on assistant write access was specifically that it
// still lands in the audit trail, and the trail he means is this one.
export async function logJobFieldChanges(
  opts: {
    companyId: number;
    jobId: number;
    userId: number | null;
    /** Falls back to a users lookup when omitted. */
    userName?: string | null;
    userEmail?: string | null;
    actor?: AssistantActor | null;
    changes: Array<{ field: string; from: unknown; to: unknown }>;
  },
  exec: { execute: (q: ReturnType<typeof sql>) => Promise<any> } = db,
): Promise<void> {
  if (opts.changes.length === 0) return;
  try {
    let name = opts.userName ?? null;
    let email = opts.userEmail ?? null;
    if ((name === null || email === null) && opts.userId != null) {
      const u = await exec.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${opts.userId} LIMIT 1`);
      const row = (u.rows?.[0] as any) ?? null;
      if (row) {
        name = name ?? (`${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Unknown");
        email = email ?? (row.email ?? "");
      }
    }
    const display = actorDisplayName(name, opts.actor ?? null);
    for (const c of opts.changes) {
      await exec.execute(sql`
        INSERT INTO job_audit_log
          (job_id, company_id, user_id, user_name, user_email,
           field_name, old_value, new_value, cascade_scope, schedule_id,
           actor_kind, actor_credential_id, actor_label)
        VALUES
          (${opts.jobId}, ${opts.companyId}, ${opts.userId}, ${display}, ${String(email ?? "")},
           ${c.field},
           ${JSON.stringify(c.from ?? null)}::jsonb,
           ${JSON.stringify(c.to ?? null)}::jsonb,
           'this_job', ${null},
           ${opts.actor?.kind ?? null}, ${opts.actor?.credentialId ?? null}, ${opts.actor?.label ?? null})
      `);
    }
  } catch (err) {
    // Non-fatal, like every other helper here: the change already committed,
    // and failing the request now would invite a retry that repeats it.
    console.error("[audit] logJobFieldChanges failed:", err);
  }
}

// [ai-access-write 2026-08-16] The same rows logClientActivity writes, without a
// Request behind them.
//
// Needed because the revert path has no request from the actor whose change is
// being undone — it has a ledger row and the person pressing the button. Leaving
// the revert out of the customer's trail would produce the worst version of an
// audit log: one that records the assistant moving something and stays silent
// about the office moving it back.
export async function logClientFieldChanges(
  opts: {
    companyId: number;
    clientId: number;
    userId: number | null;
    actor?: AssistantActor | null;
    changes: Array<{ field: string; from: unknown; to: unknown }>;
  },
  exec: { execute: (q: ReturnType<typeof sql>) => Promise<any> } = db,
): Promise<void> {
  if (opts.changes.length === 0) return;
  try {
    let name: string | null = null;
    let email = "";
    if (opts.userId != null) {
      const u = await exec.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${opts.userId} LIMIT 1`);
      const row = (u.rows?.[0] as any) ?? null;
      if (row) {
        name = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Unknown";
        email = row.email ?? "";
      }
    }
    const display = actorDisplayName(name, opts.actor ?? null);
    for (const c of opts.changes) {
      await exec.execute(sql`
        INSERT INTO client_audit_log
          (client_id, company_id, user_id, user_name, user_email, field_name, old_value, new_value, edited_at,
           actor_kind, actor_credential_id, actor_label)
        VALUES
          (${opts.clientId}, ${opts.companyId}, ${opts.userId}, ${display}, ${email}, ${c.field},
           ${JSON.stringify({ value: c.from ?? null })}::jsonb,
           ${JSON.stringify({ value: c.to ?? null })}::jsonb, now(),
           ${opts.actor?.kind ?? null}, ${opts.actor?.credentialId ?? null}, ${opts.actor?.label ?? null})
      `);
    }
  } catch (err) {
    console.error("[audit] logClientFieldChanges failed:", err);
  }
}

// Per-client activity trail. Writes to client_audit_log (keyed by client_id) so
// the office can audit ALL activity within a single client — job deletions,
// rate changes, etc. — in one place. No-ops safely when there's no client
// (e.g. account/commercial jobs) or no authenticated actor.
export async function logClientActivity(
  req: Request,
  clientId: number | null | undefined,
  fieldName: string,
  oldValue?: Record<string, unknown> | null,
  newValue?: Record<string, unknown> | null
): Promise<void> {
  const userId = req.auth?.userId ?? null;
  const companyId = req.auth?.companyId ?? null;
  if (clientId == null || userId == null || companyId == null) return;
  try {
    let name = "Unknown", email = "";
    const u = await db.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${userId} LIMIT 1`);
    const row = (u.rows?.[0] as any) ?? null;
    if (row) { name = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Unknown"; email = row.email ?? ""; }
    const actor = assistantActor(req);
    await db.execute(sql`
      INSERT INTO client_audit_log
        (client_id, company_id, user_id, user_name, user_email, field_name, old_value, new_value, edited_at,
         actor_kind, actor_credential_id, actor_label)
      VALUES
        (${clientId}, ${companyId}, ${userId}, ${actorDisplayName(name, actor)}, ${email}, ${fieldName},
         ${oldValue ? JSON.stringify(oldValue) : null}::jsonb,
         ${newValue ? JSON.stringify(newValue) : null}::jsonb, now(),
         ${actor?.kind ?? null}, ${actor?.credentialId ?? null}, ${actor?.label ?? null})
    `);
  } catch (err) {
    console.error("[audit] Failed to write client_audit_log:", err);
  }
}
