import { Router } from "express";
import { db } from "@workspace/db";
import { notificationTemplatesTable, notificationLogTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

const DEFAULT_TEMPLATES = [
  {
    trigger: "job_scheduled",
    channel: "email" as const,
    subject: "Your cleaning appointment is confirmed",
    body: "Hi {{client_name}},\n\nYour {{service_type}} appointment is scheduled for {{date}} at {{time}}.\n\nThank you for choosing {{company_name}}!\n\nBest,\nThe {{company_name}} Team",
    is_active: true,
  },
  {
    trigger: "job_reminder_24h",
    channel: "email" as const,
    subject: "Reminder: Cleaning tomorrow at {{time}}",
    body: "Hi {{client_name}},\n\nJust a reminder that your {{service_type}} is tomorrow, {{date}} at {{time}}.\n\nQuestions? Call us anytime.\n\n{{company_name}}",
    is_active: true,
  },
  {
    trigger: "invoice_sent",
    channel: "email" as const,
    subject: "Invoice #{{invoice_number}} from {{company_name}}",
    body: "Hi {{client_name}},\n\nPlease find your invoice for ${{amount}} attached.\n\nThank you for your business!\n\n{{company_name}}",
    is_active: true,
  },
  {
    trigger: "job_complete",
    channel: "in_app" as const,
    subject: null,
    body: "Job for {{client_name}} has been marked complete by {{employee_name}}.",
    is_active: true,
  },
  {
    trigger: "employee_clock_in",
    channel: "in_app" as const,
    subject: null,
    body: "{{employee_name}} clocked in for {{client_name}}'s job.",
    is_active: false,
  },
  {
    trigger: "payment_received",
    channel: "email" as const,
    subject: "Payment confirmed — Thank you!",
    body: "Hi {{client_name}},\n\nWe received your payment of ${{amount}}. Thank you!\n\n{{company_name}}",
    is_active: true,
  },
];

router.get("/templates", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    let templates = await db.select().from(notificationTemplatesTable)
      .where(eq(notificationTemplatesTable.company_id, companyId))
      .orderBy(notificationTemplatesTable.id);

    if (templates.length === 0) {
      const inserted = await db.insert(notificationTemplatesTable)
        .values(DEFAULT_TEMPLATES.map(t => ({ ...t, company_id: companyId })))
        .returning();
      templates = inserted;
    }

    return res.json({ data: templates });
  } catch (err) {
    console.error("Notifications templates error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/templates/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    const { is_active, subject, body } = req.body;

    const [updated] = await db.update(notificationTemplatesTable)
      .set({ is_active, subject, body })
      .where(and(eq(notificationTemplatesTable.id, id), eq(notificationTemplatesTable.company_id, companyId)))
      .returning();

    return res.json(updated);
  } catch (err) {
    console.error("Update template error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/templates/:id/test", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);

    const [template] = await db.select().from(notificationTemplatesTable)
      .where(and(eq(notificationTemplatesTable.id, id), eq(notificationTemplatesTable.company_id, companyId)));

    if (!template) return res.status(404).json({ error: "Template not found" });

    await db.insert(notificationLogTable).values({
      company_id: companyId,
      recipient: req.auth!.email || "test@example.com",
      channel: template.channel,
      trigger: template.trigger,
      status: "test_sent",
    });

    return res.json({ success: true, message: `Test notification logged for trigger: ${template.trigger}` });
  } catch (err) {
    console.error("Test notification error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/log", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const logs = await db.select().from(notificationLogTable)
      .where(eq(notificationLogTable.company_id, companyId))
      .orderBy(desc(notificationLogTable.sent_at))
      .limit(50);
    return res.json({ data: logs });
  } catch (err) {
    console.error("Notification log error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── In-app notification center ──────────────────────────────────────────────

// Per-user inbox (ALL roles). A user sees notifications targeted at them
// (user_id = me) plus legacy company/office broadcasts (user_id IS NULL) when
// they're office/owner/admin. Techs see only their own targeted alerts.
function inboxScope(userId: number, isOffice: boolean) {
  return isOffice ? sql`(user_id = ${userId} OR user_id IS NULL)` : sql`user_id = ${userId}`;
}

router.get("/inbox", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const isOffice = ["owner", "admin", "office"].includes(String(req.auth!.role));
    const limit = Math.min(parseInt((req.query.limit as string) || "50"), 100);
    const unreadOnly = req.query.unread === "true";
    const scope = inboxScope(userId, isOffice);

    const rows = await db.execute(sql`
      SELECT id, company_id, user_id, type, title, body, link, meta, read, created_at
        FROM notifications
       WHERE company_id = ${companyId} AND ${scope}
       ${unreadOnly ? sql`AND read = false` : sql``}
       ORDER BY created_at DESC
       LIMIT ${limit}`);
    const cnt = await db.execute(sql`
      SELECT count(*)::int AS count FROM notifications
       WHERE company_id = ${companyId} AND ${scope} AND read = false`);
    return res.json({ data: rows.rows, unread_count: (cnt.rows[0] as any)?.count ?? 0 });
  } catch (err) {
    console.error("Inbox fetch error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/inbox/read-all", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const isOffice = ["owner", "admin", "office"].includes(String(req.auth!.role));
    await db.execute(sql`
      UPDATE notifications SET read = true
       WHERE company_id = ${companyId} AND read = false AND ${inboxScope(userId, isOffice)}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Read-all error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/inbox/:id/read", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const userId = req.auth!.userId!;
    const isOffice = ["owner", "admin", "office"].includes(String(req.auth!.role));
    const id = req.params.id;
    await db.execute(sql`
      UPDATE notifications SET read = true
       WHERE id = ${id} AND company_id = ${companyId} AND ${inboxScope(userId, isOffice)}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Mark-read error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── GET /api/notifications/settings — this user's effective prefs ──────────────
router.get("/settings", requireAuth, async (req, res) => {
  try {
    const { getEffectivePrefs } = await import("../lib/notify-prefs.js");
    const prefs = await getEffectivePrefs(req.auth!.userId!);
    return res.json(prefs);
  } catch (err) {
    console.error("GET /notifications/settings:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ── PUT /api/notifications/settings — upsert this user's prefs ─────────────────
router.put("/settings", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId!;
    const companyId = req.auth!.companyId!;
    const b = req.body ?? {};
    const bool = (v: any) => (v === true ? true : v === false ? false : null);
    await db.execute(sql`
      INSERT INTO notification_prefs
        (user_id, company_id, messages_inapp, messages_email, new_jobs_inapp, new_jobs_email, job_changes_inapp, job_changes_email, updated_at)
      VALUES (${userId}, ${companyId}, ${bool(b.messages_inapp)}, ${bool(b.messages_email)},
              ${bool(b.new_jobs_inapp)}, ${bool(b.new_jobs_email)}, ${bool(b.job_changes_inapp)}, ${bool(b.job_changes_email)}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        messages_inapp = EXCLUDED.messages_inapp, messages_email = EXCLUDED.messages_email,
        new_jobs_inapp = EXCLUDED.new_jobs_inapp, new_jobs_email = EXCLUDED.new_jobs_email,
        job_changes_inapp = EXCLUDED.job_changes_inapp, job_changes_email = EXCLUDED.job_changes_email,
        updated_at = NOW()`);
    const { getEffectivePrefs } = await import("../lib/notify-prefs.js");
    return res.json(await getEffectivePrefs(userId));
  } catch (err) {
    console.error("PUT /notifications/settings:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
