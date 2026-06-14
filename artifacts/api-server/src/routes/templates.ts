import { Router } from "express";
import { db } from "@workspace/db";
import { messageTemplatesTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";

const router = Router();

// Convert MaidCentral ##Token## merge fields to Qleno's {{token}} convention.
const convertTokens = (s: string | null | undefined): string =>
  (s ?? "").replace(/##([A-Za-z0-9_]+)##/g, (_m, t) => `{{${t}}}`);

// GET /api/templates?channel=email|sms — list this tenant's templates.
router.get("/", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const conds: any[] = [eq(messageTemplatesTable.company_id, companyId)];
    if (req.query.channel) conds.push(eq(messageTemplatesTable.channel, String(req.query.channel)));
    const rows = await db.select().from(messageTemplatesTable).where(and(...conds)).orderBy(desc(messageTemplatesTable.updated_at));
    res.json(rows);
  } catch (err) { console.error("templates list", err); res.status(500).json({ error: "Failed to list templates" }); }
});

// POST /api/templates — create.
router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { name, channel, subject, body, category } = req.body;
    if (!name || !channel || !body) return res.status(400).json({ error: "name, channel, body required" });
    const [row] = await db.insert(messageTemplatesTable).values({
      company_id: req.auth!.companyId!, name, channel, subject: subject ?? null, body, category: category ?? null,
    }).returning();
    res.status(201).json(row);
  } catch (err) { console.error("templates create", err); res.status(500).json({ error: "Failed to create template" }); }
});

// PATCH /api/templates/:id — edit.
router.patch("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    const allowed = ["name", "channel", "subject", "body", "category", "active"];
    const updates: Record<string, unknown> = { updated_at: new Date() };
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const [row] = await db.update(messageTemplatesTable).set(updates)
      .where(and(eq(messageTemplatesTable.id, id), eq(messageTemplatesTable.company_id, companyId))).returning();
    if (!row) return res.status(404).json({ error: "Template not found" });
    res.json(row);
  } catch (err) { console.error("templates patch", err); res.status(500).json({ error: "Failed to update template" }); }
});

// POST /api/templates/:id/clone — duplicate (name + " (copy)").
router.post("/:id/clone", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const id = parseInt(req.params.id);
    const [src] = await db.select().from(messageTemplatesTable)
      .where(and(eq(messageTemplatesTable.id, id), eq(messageTemplatesTable.company_id, companyId))).limit(1);
    if (!src) return res.status(404).json({ error: "Template not found" });
    const [row] = await db.insert(messageTemplatesTable).values({
      company_id: companyId, name: `${src.name} (copy)`, channel: src.channel,
      subject: src.subject, body: src.body, category: src.category, is_default: false,
    }).returning();
    res.status(201).json(row);
  } catch (err) { console.error("templates clone", err); res.status(500).json({ error: "Failed to clone template" }); }
});

// DELETE /api/templates/:id.
router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    await db.delete(messageTemplatesTable)
      .where(and(eq(messageTemplatesTable.id, parseInt(req.params.id)), eq(messageTemplatesTable.company_id, companyId)));
    res.json({ ok: true });
  } catch (err) { console.error("templates delete", err); res.status(500).json({ error: "Failed to delete template" }); }
});

// POST /api/templates/import — bulk-seed a tenant's templates (e.g. the crawled
// MaidCentral set). Converts ##Token##→{{token}}. Upserts by (name, channel).
// Body: { templates: [{ name, channel, subject?, body, category? }], replace? }
router.post("/import", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId!;
    const { templates = [], replace = false } = req.body ?? {};
    if (!Array.isArray(templates) || !templates.length) return res.status(400).json({ error: "templates[] required" });

    if (replace) {
      await db.delete(messageTemplatesTable).where(eq(messageTemplatesTable.company_id, companyId));
    }
    const existing = replace ? [] : await db.select({ id: messageTemplatesTable.id, name: messageTemplatesTable.name, channel: messageTemplatesTable.channel })
      .from(messageTemplatesTable).where(eq(messageTemplatesTable.company_id, companyId));
    const byKey = new Map(existing.map(e => [`${e.name}|${e.channel}`, e.id]));

    let created = 0, updated = 0, skipped = 0;
    for (const t of templates) {
      if (!t?.name || !t?.channel || !t?.body) { skipped++; continue; }
      const subject = convertTokens(t.subject);
      const body = convertTokens(t.body);
      const key = `${t.name}|${t.channel}`;
      const existingId = byKey.get(key);
      if (existingId) {
        await db.update(messageTemplatesTable).set({ subject: subject || null, body, category: t.category ?? "imported", updated_at: new Date() })
          .where(eq(messageTemplatesTable.id, existingId));
        updated++;
      } else {
        await db.insert(messageTemplatesTable).values({
          company_id: companyId, name: t.name, channel: t.channel, subject: subject || null, body,
          category: t.category ?? "imported", is_default: true,
        });
        created++;
      }
    }
    res.json({ ok: true, created, updated, skipped });
  } catch (err) { console.error("templates import", err); res.status(500).json({ error: "Failed to import templates" }); }
});

export default router;
