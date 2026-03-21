import { Router } from "express";
import { db } from "@workspace/db";
import {
  documentRequestsTable,
  documentTemplatesTable,
  documentSignaturesTable,
  usersTable,
  clientsTable,
} from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { randomUUID } from "crypto";

const router = Router();

function expiresAt72h() {
  const d = new Date();
  d.setHours(d.getHours() + 72);
  return d;
}

function interpolateContent(content: string, vars: Record<string, string>) {
  return content.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || `{{${key}}}`);
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const companyId = (req as any).user.company_id;
    const { employee_id, client_id } = req.query;
    const conditions: any[] = [eq(documentRequestsTable.company_id, companyId)];
    if (employee_id) conditions.push(eq(documentRequestsTable.employee_id, parseInt(employee_id as string)));
    if (client_id) conditions.push(eq(documentRequestsTable.client_id, parseInt(client_id as string)));

    const requests = await db
      .select({
        id: documentRequestsTable.id,
        template_id: documentRequestsTable.template_id,
        employee_id: documentRequestsTable.employee_id,
        client_id: documentRequestsTable.client_id,
        token: documentRequestsTable.token,
        status: documentRequestsTable.status,
        sent_at: documentRequestsTable.sent_at,
        expires_at: documentRequestsTable.expires_at,
        signed_at: documentRequestsTable.signed_at,
        template_name: documentTemplatesTable.name,
        template_category: documentTemplatesTable.category,
        requires_signature: documentTemplatesTable.requires_signature,
        is_required: documentTemplatesTable.is_required,
      })
      .from(documentRequestsTable)
      .leftJoin(documentTemplatesTable, eq(documentRequestsTable.template_id, documentTemplatesTable.id))
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(documentRequestsTable.sent_at);

    return res.json(requests);
  } catch (err) {
    console.error("List document requests error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/send", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = (req as any).user.company_id;
    const { template_ids, employee_id, client_id } = req.body;
    if (!template_ids?.length) return res.status(400).json({ error: "template_ids required" });
    if (!employee_id && !client_id) return res.status(400).json({ error: "employee_id or client_id required" });

    const created = [];
    for (const template_id of template_ids) {
      const [template] = await db
        .select()
        .from(documentTemplatesTable)
        .where(and(
          eq(documentTemplatesTable.id, template_id),
          eq(documentTemplatesTable.company_id, companyId),
        ))
        .limit(1);
      if (!template) continue;

      const token = randomUUID();
      const [request] = await db
        .insert(documentRequestsTable)
        .values({
          company_id: companyId,
          template_id,
          employee_id: employee_id || null,
          client_id: client_id || null,
          token,
          status: "pending",
          sent_at: new Date(),
          expires_at: expiresAt72h(),
        })
        .returning();
      created.push(request);
    }

    return res.status(201).json({ created, count: created.length });
  } catch (err) {
    console.error("Send document requests error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/resend", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = (req as any).user.company_id;
    const [request] = await db
      .update(documentRequestsTable)
      .set({
        token: randomUUID(),
        status: "pending",
        sent_at: new Date(),
        expires_at: expiresAt72h(),
        reminder_sent_at: null,
        signed_at: null,
      })
      .where(and(
        eq(documentRequestsTable.id, parseInt(req.params.id)),
        eq(documentRequestsTable.company_id, companyId),
      ))
      .returning();
    if (!request) return res.status(404).json({ error: "Not found" });
    return res.json(request);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/onboard/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const requests = await db
      .select({
        id: documentRequestsTable.id,
        template_id: documentRequestsTable.template_id,
        employee_id: documentRequestsTable.employee_id,
        status: documentRequestsTable.status,
        expires_at: documentRequestsTable.expires_at,
        signed_at: documentRequestsTable.signed_at,
        template_name: documentTemplatesTable.name,
        template_content: documentTemplatesTable.content,
        requires_signature: documentTemplatesTable.requires_signature,
        company_id: documentRequestsTable.company_id,
        company_name: sql<string>`(select name from companies where id = ${documentRequestsTable.company_id})`,
        company_logo: sql<string | null>`(select logo_url from companies where id = ${documentRequestsTable.company_id})`,
        company_brand: sql<string | null>`(select brand_color from companies where id = ${documentRequestsTable.company_id})`,
        employee_first: usersTable.first_name,
        employee_last: usersTable.last_name,
        employee_email: usersTable.email,
      })
      .from(documentRequestsTable)
      .leftJoin(documentTemplatesTable, eq(documentRequestsTable.template_id, documentTemplatesTable.id))
      .leftJoin(usersTable, eq(documentRequestsTable.employee_id, usersTable.id))
      .where(eq(documentRequestsTable.token, token))
      .orderBy(documentRequestsTable.id);

    if (!requests.length) return res.status(404).json({ error: "Not found" });

    const first = requests[0];
    const now = new Date();
    if (first.status === "expired" || (first.expires_at && now > new Date(first.expires_at))) {
      return res.status(410).json({ error: "expired", company_name: first.company_name });
    }

    const employeeName = `${first.employee_first || ""} ${first.employee_last || ""}`.trim();
    const companyName = first.company_name || "";

    const docs = requests.map(r => ({
      request_id: r.id,
      template_id: r.template_id,
      template_name: r.template_name,
      content: interpolateContent(r.template_content || "", {
        employee_name: employeeName,
        employee_email: r.employee_email || "",
        company_name: companyName,
        date: new Date().toLocaleDateString("en-US"),
      }),
      requires_signature: r.requires_signature,
      status: r.status,
    }));

    return res.json({
      docs,
      employee_name: employeeName,
      employee_email: first.employee_email,
      company_name: companyName,
      company_logo: first.company_logo,
      company_brand: first.company_brand,
      company_id: first.company_id,
      employee_id: first.employee_id,
    });
  } catch (err) {
    console.error("Onboard token error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/onboard/:token/sign", async (req, res) => {
  try {
    const { token } = req.params;
    const { request_id, signature_data, signer_name, signer_email, document_snapshot } = req.body;
    if (!request_id || !signer_name) return res.status(400).json({ error: "request_id and signer_name required" });

    const [request] = await db
      .select({
        id: documentRequestsTable.id,
        template_id: documentRequestsTable.template_id,
        employee_id: documentRequestsTable.employee_id,
        company_id: documentRequestsTable.company_id,
        status: documentRequestsTable.status,
        expires_at: documentRequestsTable.expires_at,
        token: documentRequestsTable.token,
      })
      .from(documentRequestsTable)
      .where(and(
        eq(documentRequestsTable.id, request_id),
        eq(documentRequestsTable.token, token),
      ))
      .limit(1);

    if (!request) return res.status(404).json({ error: "Not found" });
    if (request.status === "signed") return res.status(409).json({ error: "Already signed" });
    if (request.expires_at && new Date() > new Date(request.expires_at)) {
      return res.status(410).json({ error: "Expired" });
    }

    const now = new Date();
    await db
      .update(documentRequestsTable)
      .set({ status: "signed", signed_at: now })
      .where(eq(documentRequestsTable.id, request.id));

    await db
      .insert(documentSignaturesTable)
      .values({
        company_id: request.company_id,
        template_id: request.template_id,
        employee_id: request.employee_id || null,
        client_id: null,
        signed_at: now,
        signer_name,
        signer_email: signer_email || null,
        signature_data: signature_data || null,
        ip_address: req.ip || "unknown",
        user_agent: req.headers["user-agent"] || null,
        document_snapshot: document_snapshot || "",
      });

    return res.json({ success: true });
  } catch (err) {
    console.error("Sign onboard doc error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/client-sign/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const [request] = await db
      .select({
        id: documentRequestsTable.id,
        template_id: documentRequestsTable.template_id,
        client_id: documentRequestsTable.client_id,
        status: documentRequestsTable.status,
        expires_at: documentRequestsTable.expires_at,
        signed_at: documentRequestsTable.signed_at,
        template_name: documentTemplatesTable.name,
        template_content: documentTemplatesTable.content,
        requires_signature: documentTemplatesTable.requires_signature,
        company_id: documentRequestsTable.company_id,
        company_name: sql<string>`(select name from companies where id = ${documentRequestsTable.company_id})`,
        company_logo: sql<string | null>`(select logo_url from companies where id = ${documentRequestsTable.company_id})`,
        company_brand: sql<string | null>`(select brand_color from companies where id = ${documentRequestsTable.company_id})`,
        client_first: clientsTable.first_name,
        client_last: clientsTable.last_name,
        client_email: clientsTable.email,
        client_address: clientsTable.address,
      })
      .from(documentRequestsTable)
      .leftJoin(documentTemplatesTable, eq(documentRequestsTable.template_id, documentTemplatesTable.id))
      .leftJoin(clientsTable, eq(documentRequestsTable.client_id, clientsTable.id))
      .where(eq(documentRequestsTable.token, token))
      .limit(1);

    if (!request) return res.status(404).json({ error: "Not found" });

    if (request.status === "expired" || (request.expires_at && new Date() > new Date(request.expires_at))) {
      return res.status(410).json({ error: "expired", company_name: request.company_name });
    }

    if (request.status === "signed") {
      return res.json({ ...request, already_signed: true });
    }

    const clientName = `${request.client_first || ""} ${request.client_last || ""}`.trim();
    const content = interpolateContent(request.template_content || "", {
      client_name: clientName,
      client_address: request.client_address || "",
      company_name: request.company_name || "",
      date: new Date().toLocaleDateString("en-US"),
    });

    return res.json({
      request_id: request.id,
      template_id: request.template_id,
      template_name: request.template_name,
      content,
      requires_signature: request.requires_signature,
      status: request.status,
      client_name: clientName,
      client_email: request.client_email,
      company_name: request.company_name,
      company_logo: request.company_logo,
      company_brand: request.company_brand,
      company_id: request.company_id,
      already_signed: false,
    });
  } catch (err) {
    console.error("Client sign token error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/client-sign/:token/sign", async (req, res) => {
  try {
    const { token } = req.params;
    const { signature_data, signer_name, signer_email, document_snapshot } = req.body;
    if (!signer_name) return res.status(400).json({ error: "signer_name required" });

    const [request] = await db
      .select()
      .from(documentRequestsTable)
      .where(eq(documentRequestsTable.token, token))
      .limit(1);

    if (!request) return res.status(404).json({ error: "Not found" });
    if (request.status === "signed") return res.status(409).json({ error: "Already signed" });
    if (request.expires_at && new Date() > new Date(request.expires_at)) {
      return res.status(410).json({ error: "Expired" });
    }

    const now = new Date();
    await db
      .update(documentRequestsTable)
      .set({ status: "signed", signed_at: now })
      .where(eq(documentRequestsTable.token, token));

    await db
      .insert(documentSignaturesTable)
      .values({
        company_id: request.company_id,
        template_id: request.template_id,
        employee_id: null,
        client_id: request.client_id || null,
        signed_at: now,
        signer_name,
        signer_email: signer_email || null,
        signature_data: signature_data || null,
        ip_address: req.ip || "unknown",
        user_agent: req.headers["user-agent"] || null,
        document_snapshot: document_snapshot || "",
      });

    return res.json({ success: true, signed_at: now });
  } catch (err) {
    console.error("Client sign error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
