import { Router } from "express";
import { db } from "@workspace/db";
import { agreementTemplatesTable, clientAgreementsTable, clientsTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import crypto from "crypto";
import { renderAgreementCertificate } from "../lib/agreement-certificate.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const templates = await db
      .select()
      .from(agreementTemplatesTable)
      .where(eq(agreementTemplatesTable.company_id, req.auth!.companyId))
      .orderBy(desc(agreementTemplatesTable.created_at));
    res.json(templates);
  } catch (e: any) {
    console.error("List templates error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const { name, body } = req.body;
    if (!name || !body) return res.status(400).json({ error: "name and body required" });
    const [t] = await db.insert(agreementTemplatesTable).values({
      company_id: req.auth!.companyId,
      name, body,
      created_by: req.auth!.userId,
      is_active: true,
    }).returning();
    res.status(201).json(t);
  } catch (e: any) {
    console.error("Create template error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.patch("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, body, is_active } = req.body;
    const updates: any = { updated_at: new Date() };
    if (name !== undefined) updates.name = name;
    if (body !== undefined) updates.body = body;
    if (is_active !== undefined) updates.is_active = is_active;
    const [t] = await db
      .update(agreementTemplatesTable)
      .set(updates)
      .where(and(eq(agreementTemplatesTable.id, id), eq(agreementTemplatesTable.company_id, req.auth!.companyId)))
      .returning();
    if (!t) return res.status(404).json({ error: "Not found" });
    res.json(t);
  } catch (e: any) {
    console.error("Update template error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.delete("/:id", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(agreementTemplatesTable).where(
      and(eq(agreementTemplatesTable.id, id), eq(agreementTemplatesTable.company_id, req.auth!.companyId))
    );
    res.json({ success: true });
  } catch (e: any) {
    console.error("Delete template error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/:id/send", requireAuth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const templateId = parseInt(req.params.id);
    const { client_id, client_home_id } = req.body;
    if (!client_id) return res.status(400).json({ error: "client_id required" });
    const [template] = await db.select().from(agreementTemplatesTable)
      .where(and(eq(agreementTemplatesTable.id, templateId), eq(agreementTemplatesTable.company_id, req.auth!.companyId)));
    if (!template) return res.status(404).json({ error: "Template not found" });
    const contentHash = crypto.createHash("sha256").update(template.body).digest("hex");
    const [agreement] = await db.insert(clientAgreementsTable).values({
      company_id: req.auth!.companyId,
      client_id: parseInt(client_id),
      template_name: template.name,
      template_id: templateId,
      content_hash: contentHash,
      client_home_id: client_home_id ? parseInt(client_home_id) : null,
      sent_at: new Date(),
    } as any).returning();
    // [agreement-esign] Tokenize + record the audit "sent" event.
    const token = crypto.randomUUID();
    const signerEmail = req.body.signer_email || null;
    await db.execute(sql`UPDATE client_agreements SET token = ${token}, signer_email = ${signerEmail} WHERE id = ${agreement.id}`);
    await db.execute(sql`INSERT INTO agreement_events (company_id, agreement_id, event_type, actor_email, meta)
      VALUES (${req.auth!.companyId}, ${agreement.id}, 'sent', ${signerEmail}, ${JSON.stringify({ by_user: req.auth!.userId })}::jsonb)`);
    res.status(201).json({ success: true, agreement: { ...agreement, token } });
  } catch (e: any) {
    console.error("Send agreement error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/agreements/:id/sign", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { typed_name, agreed } = req.body;
    // Consent (agreed) is required — ESIGN/UETA: the signer must affirm intent.
    if (!typed_name || !agreed) return res.status(400).json({ error: "typed_name and consent required" });
    const ip_address = (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || "";
    const ua = (req.headers["user-agent"] as string) || "";
    const ex = await db.execute(sql`SELECT company_id, signer_email, accepted_at FROM client_agreements WHERE id = ${id} LIMIT 1`);
    const row: any = (ex as any).rows[0];
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.accepted_at) return res.status(409).json({ error: "Agreement already signed" });
    const [agreement] = await db
      .update(clientAgreementsTable)
      .set({ accepted_at: new Date(), typed_name, ip_address } as any)
      .where(eq(clientAgreementsTable.id, id))
      .returning();
    // Capture consent + device, then record the tamper-evident audit events.
    await db.execute(sql`UPDATE client_agreements SET consent_at = now(), user_agent = ${ua} WHERE id = ${id}`);
    await db.execute(sql`INSERT INTO agreement_events (company_id, agreement_id, event_type, actor_email, ip_address, user_agent)
      VALUES (${row.company_id}, ${id}, 'signed', ${row.signer_email ?? null}, ${ip_address}, ${ua})`);
    await db.execute(sql`INSERT INTO agreement_events (company_id, agreement_id, event_type) VALUES (${row.company_id}, ${id}, 'sealed')`);
    res.json({ success: true, agreement });
  } catch (e: any) {
    console.error("Sign agreement error:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

// Certificate of Completion (audit trail) for a signed agreement.
router.get("/agreements/:id/certificate.pdf", requireAuth, async (req, res) => {
  try {
    const companyId = req.auth!.companyId;
    const id = parseInt(req.params.id);
    const rows = await db.execute(sql`
      SELECT ca.id, ca.template_name, ca.content_hash, ca.token, ca.typed_name, ca.signer_email,
             ca.accepted_at, ca.consent_at, c.name AS company_name
      FROM client_agreements ca JOIN companies c ON c.id = ca.company_id
      WHERE ca.id = ${id} AND ca.company_id = ${companyId} LIMIT 1
    `);
    const ag: any = (rows as any).rows[0];
    if (!ag) return res.status(404).json({ error: "Not Found" });
    const evs = await db.execute(sql`
      SELECT event_type, created_at, ip_address, user_agent, actor_email, meta
      FROM agreement_events WHERE agreement_id = ${id} AND company_id = ${companyId} ORDER BY created_at ASC, id ASC
    `);
    const pdf = await renderAgreementCertificate({
      companyName: ag.company_name || "Qleno",
      agreementTitle: ag.template_name || "Service Agreement",
      envelopeId: ag.token ? `QL-${String(ag.token).slice(0, 8).toUpperCase()}` : `QL-${ag.id}`,
      signerName: ag.typed_name, signerEmail: ag.signer_email,
      status: ag.accepted_at ? "completed" : "sent",
      contentHash: ag.content_hash || "—",
      consent: !!ag.consent_at,
      events: ((evs as any).rows || []).map((e: any) => ({
        type: e.event_type, at: e.created_at, ip: e.ip_address, userAgent: e.user_agent,
        email: e.actor_email, by: e.meta?.by_user ? `user #${e.meta.by_user}` : null,
      })),
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="certificate-${ag.id}.pdf"`);
    return res.end(pdf);
  } catch (e: any) {
    console.error("Agreement certificate error:", e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
