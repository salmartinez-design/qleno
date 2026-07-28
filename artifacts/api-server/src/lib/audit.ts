import { Request } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

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

    await db.execute(sql`
      INSERT INTO app_audit_log
        (company_id, performed_by, action, target_type, target_id,
         old_value, new_value, ip_address, user_agent, performed_at)
      VALUES
        (${companyId}, ${userId}, ${action}, ${targetType}, ${String(targetId ?? "")},
         ${oldValue ? JSON.stringify(oldValue) : null}::jsonb,
         ${newValue ? JSON.stringify(newValue) : null}::jsonb,
         ${ip}, ${userAgent}, now())
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
    const newVal: Record<string, unknown> = { value: opts.newStatus, source: opts.source };
    if (opts.note) newVal.note = opts.note;
    await exec.execute(sql`
      INSERT INTO job_audit_log
        (job_id, company_id, user_id, user_name, user_email,
         field_name, old_value, new_value, cascade_scope)
      VALUES
        (${opts.jobId}, ${opts.companyId}, ${userId}, ${name}, ${email},
         'status',
         ${JSON.stringify({ value: opts.priorStatus })}::jsonb,
         ${JSON.stringify(newVal)}::jsonb,
         'this_job')
    `);
  } catch (err) {
    // Never let audit logging crash a completion / revert.
    console.error("[audit] logJobStatusChange failed:", err);
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
    await db.execute(sql`
      INSERT INTO client_audit_log
        (client_id, company_id, user_id, user_name, user_email, field_name, old_value, new_value, edited_at)
      VALUES
        (${clientId}, ${companyId}, ${userId}, ${name}, ${email}, ${fieldName},
         ${oldValue ? JSON.stringify(oldValue) : null}::jsonb,
         ${newValue ? JSON.stringify(newValue) : null}::jsonb, now())
    `);
  } catch (err) {
    console.error("[audit] Failed to write client_audit_log:", err);
  }
}
