import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── In-app notification emitter ───────────────────────────────────────────────
// Internal staff alerts. Tenant-scoped (company_id) and per-user (user_id). Raw
// SQL so it doesn't couple to regenerated drizzle types for the user_id column.

export interface NotifyArgs {
  companyId: number;
  userId: number | null;          // null = company/office broadcast
  type: string;                   // 'new_message' | 'job_assigned' | 'job_changed' | …
  title: string;
  body?: string | null;
  link?: string | null;           // in-app route, e.g. '/messages' or '/dispatch?job=123'
  meta?: Record<string, any> | null;
}

export async function notifyUser(a: NotifyArgs): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO notifications (company_id, user_id, type, title, body, link, meta, read, created_at)
      VALUES (${a.companyId}, ${a.userId}, ${a.type}, ${a.title}, ${a.body ?? null},
              ${a.link ?? null}, ${a.meta ? JSON.stringify(a.meta) : null}::jsonb, false, NOW())`);
  } catch (e) {
    // Never let an alert failure break the triggering action.
    console.error("[notify] insert failed:", e);
  }
}

// Fan out to every active office/owner/admin user in the tenant (one row each,
// so per-user settings can later filter individually). Used for message alerts.
export async function notifyOfficeUsers(companyId: number, n: Omit<NotifyArgs, "companyId" | "userId">): Promise<void> {
  try {
    // Office users for this tenant = the tenant's own staff (users.company_id)
    // PLUS cross-tenant members granted access via user_companies (e.g. an owner
    // who runs multiple locations). Deduped so each gets exactly one alert.
    const users = await db.execute(sql`
      SELECT DISTINCT u.id FROM users u
       WHERE u.is_active = true AND (
         (u.company_id = ${companyId} AND u.role IN ('owner', 'admin', 'office'))
         OR u.id IN (SELECT user_id FROM user_companies
                      WHERE company_id = ${companyId} AND role IN ('owner', 'admin', 'office'))
       )`);
    for (const u of users.rows as any[]) {
      await notifyUser({ companyId, userId: Number(u.id), ...n });
    }
  } catch (e) {
    console.error("[notify] office fan-out failed:", e);
  }
}
