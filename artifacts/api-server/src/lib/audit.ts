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
