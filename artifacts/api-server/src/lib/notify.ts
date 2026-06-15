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
    // Resolve the recipient's per-category prefs once (role-defaulted). Types
    // without a category mapping always deliver in-app and never email.
    // Broadcasts (userId null) always insert in-app, no email.
    let inappOk = true, emailOk = false;
    if (a.userId != null) {
      const { getEffectivePrefs, TYPE_TO_CATEGORY } = await import("./notify-prefs.js");
      const prefs = await getEffectivePrefs(a.userId) as any;
      const cat = TYPE_TO_CATEGORY[a.type];
      inappOk = !cat || prefs[`${cat}_inapp`] === true;
      emailOk = !!cat && prefs[`${cat}_email`] === true;
    }
    if (inappOk) {
      await db.execute(sql`
        INSERT INTO notifications (company_id, user_id, type, title, body, link, meta, read, created_at)
        VALUES (${a.companyId}, ${a.userId}, ${a.type}, ${a.title}, ${a.body ?? null},
                ${a.link ?? null}, ${a.meta ? JSON.stringify(a.meta) : null}::jsonb, false, NOW())`);
    }
    if (emailOk && a.userId != null) {
      await sendStaffAlertEmail(a.companyId, a.userId, a);
    }
  } catch (e) {
    // Never let an alert failure break the triggering action.
    console.error("[notify] insert failed:", e);
  }
}

// Internal staff-alert email. TRANSACTIONAL/UNGATED — bypasses COMMS_ENABLED and
// the per-tenant customer-comms gate (it's an internal staff notification, never
// customer-facing) and is sent to the staff user's OWN email. From the tenant's
// verified send-from address.
async function sendStaffAlertEmail(companyId: number, userId: number, a: NotifyArgs): Promise<void> {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) return;
    const ur = await db.execute(sql`SELECT email, first_name FROM users WHERE id = ${userId} LIMIT 1`);
    const to = (ur.rows[0] as any)?.email;
    if (!to) return;
    const cr = await db.execute(sql`SELECT name, email_from_address FROM companies WHERE id = ${companyId} LIMIT 1`);
    const c: any = cr.rows[0] ?? {};
    const fromName = c.name || "Qleno";
    const from = `${fromName} <${c.email_from_address || "noreply@phes.io"}>`;
    const { appBaseUrl } = await import("./app-url.js");
    const url = a.link ? `${appBaseUrl()}${a.link.startsWith("/") ? a.link : "/" + a.link}` : appBaseUrl();
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1A1917">
<p style="font-size:16px;font-weight:700;margin:0 0 8px">${a.title}</p>
${a.body ? `<p style="font-size:14px;line-height:1.5;margin:0 0 16px">${a.body}</p>` : ""}
<p style="margin:0 0 20px"><a href="${url}" style="background:#00C9A0;color:#04241d;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:8px;display:inline-block">Open in ${fromName}</a></p>
<p style="font-size:12px;color:#9E9B94;margin:0">This is an internal staff alert from ${fromName}. Manage your alerts in Notification settings.</p>
</div>`;
    const { Resend } = await import("resend");
    const resend = new Resend(key);
    const r: any = await resend.emails.send({ from, to: [to], subject: a.title, html });
    if (r?.error) console.error("[notify] staff email error:", r.error?.message ?? r.error);
  } catch (e) {
    console.error("[notify] staff email failed:", e);
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
