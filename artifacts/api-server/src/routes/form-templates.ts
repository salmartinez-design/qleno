import { Router } from "express";
import { db } from "@workspace/db";
import { formTemplatesTable, formSubmissionsTable, clientsTable } from "@workspace/db/schema";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { randomUUID } from "crypto";
import {
  RESIDENTIAL_AGREEMENT_BODY,
  COMMERCIAL_AGREEMENT_BODY,
} from "../lib/agreement-bodies.js";

const router = Router();

// [agreement-merge 2026-07-22] The catalog of {{variables}} an agreement body can
// use, so the builder can show authors what's available instead of making them
// guess token names. Static list — no auth-sensitive data, but keep it behind
// requireAuth like the rest of this router.
router.get("/variables", requireAuth, async (_req, res) => {
  try {
    const { AGREEMENT_VARIABLES } = await import("../lib/agreement-merge.js");
    return res.json({ data: AGREEMENT_VARIABLES });
  } catch (err) {
    console.error("Agreement variables error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

const PHES_RESIDENTIAL_SCHEMA = [
  { id: "f_name", type: "text", label: "Full Name", required: true, variable: "client_name" },
  { id: "f_address", type: "text", label: "Service Address", required: true, variable: "client_address" },
  { id: "f_city_state_zip", type: "text", label: "City, State, Zip", required: true, variable: "client_city_state_zip" },
  { id: "f_phone", type: "tel", label: "Cell Phone", required: true, variable: "client_phone" },
  { id: "f_email", type: "email", label: "Email Address", required: true, variable: "client_email" },
  { id: "f_frequency", type: "select", label: "Service Frequency", required: true, variable: "service_frequency", options: ["Weekly", "Bi-Weekly", "Monthly", "One-Time"] },
  { id: "f_entry", type: "select", label: "How do we gain entrance?", required: true, variable: "entry_method", options: ["Client home at time of cleaning", "Garage code", "Key in lockbox", "Key provided to PHES", "Door left unlocked"] },
  { id: "f_contact_tech_change", type: "select", label: "If technician changes, notify via:", required: false, variable: "contact_tech_change", options: ["Text", "Email", "Phone call", "No preference"] },
  { id: "f_contact_during", type: "select", label: "Preferred contact during service:", required: false, variable: "contact_during", options: ["Text", "Phone call", "Do not contact unless emergency"] },
];

router.get("/", requireAuth, async (req, res) => {
  try {
    const templates = await db
      .select()
      .from(formTemplatesTable)
      .where(eq(formTemplatesTable.company_id, req.auth!.companyId))
      .orderBy(desc(formTemplatesTable.created_at));

    const withCounts = await Promise.all(
      templates.map(async (t) => {
        const sent = await db
          .select({ count: count() })
          .from(formSubmissionsTable)
          .where(eq(formSubmissionsTable.form_id, t.id));
        return { ...t, sent_count: sent[0]?.count ?? 0 };
      })
    );

    return res.json(withCounts);
  } catch (err) {
    console.error("List form templates error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/submissions", requireAuth, async (req, res) => {
  try {
    const { form_id, client_id, status } = req.query;
    const conditions: any[] = [eq(formSubmissionsTable.company_id, req.auth!.companyId)];
    if (form_id) conditions.push(eq(formSubmissionsTable.form_id, parseInt(form_id as string)));
    if (client_id) conditions.push(eq(formSubmissionsTable.client_id, parseInt(client_id as string)));
    if (status) conditions.push(eq(formSubmissionsTable.status, status as string));

    const submissions = await db
      .select({
        id: formSubmissionsTable.id,
        form_id: formSubmissionsTable.form_id,
        client_id: formSubmissionsTable.client_id,
        client_name: sql<string>`concat(${clientsTable.first_name}, ' ', ${clientsTable.last_name})`,
        client_email: clientsTable.email,
        status: formSubmissionsTable.status,
        sent_at: formSubmissionsTable.sent_at,
        sent_to: formSubmissionsTable.sent_to,
        submitted_at: formSubmissionsTable.submitted_at,
        signature_name: formSubmissionsTable.signature_name,
        signature_at: formSubmissionsTable.signature_at,
        ip_address: formSubmissionsTable.ip_address,
        pdf_url: formSubmissionsTable.pdf_url,
        content_hash: formSubmissionsTable.content_hash,
        expires_at: formSubmissionsTable.expires_at,
        created_at: formSubmissionsTable.created_at,
        form_name: formTemplatesTable.name,
        form_type: formTemplatesTable.type,
        form_category: formTemplatesTable.category,
      })
      .from(formSubmissionsTable)
      .leftJoin(clientsTable, eq(formSubmissionsTable.client_id, clientsTable.id))
      .leftJoin(formTemplatesTable, eq(formSubmissionsTable.form_id, formTemplatesTable.id))
      .where(and(...conditions))
      .orderBy(desc(formSubmissionsTable.created_at));

    return res.json(submissions);
  } catch (err) {
    console.error("List form submissions error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/seed-defaults", requireAuth, async (req, res) => {
  try {
    // [agreement-merge 2026-07-22] Seed MISSING defaults by name instead of
    // all-or-nothing. The old early-return meant a company seeded once could
    // never receive a newly added default (the Commercial Service Agreement
    // would never reach Phes). Matching on name also guarantees we never
    // overwrite a template the office has since edited — we only add what
    // isn't there.
    const existing = await db
      .select({ name: formTemplatesTable.name })
      .from(formTemplatesTable)
      .where(eq(formTemplatesTable.company_id, req.auth!.companyId));
    const existingNames = new Set(existing.map(r => String(r.name || "").trim().toLowerCase()));

    const defaults = [
      {
        company_id: req.auth!.companyId,
        name: "Residential Cleaning Agreement",
        type: "agreement",
        category: "residential",
        schema: PHES_RESIDENTIAL_SCHEMA as any,
        terms_body: RESIDENTIAL_AGREEMENT_BODY,
        requires_sign: true,
        is_active: true,
        is_default: true,
        created_by: req.auth!.userId,
      },
      // [short-commercial-retired 2026-08-19] The generic "Commercial Cleaning
      // Agreement" default is gone. It shipped alongside the real commercial
      // contract below, under a name one word different, and said the opposite
      // thing about money: NET 30 with 1.5% monthly interest, against the real
      // contract's card on file due at the first visit of the month. It also
      // had no parties clause, no rate, no service address, no notices clause
      // and no signature language, so picking the wrong row in the send dialog
      // signed a customer onto terms Phes does not offer. The two rows it
      // already created on Phes and Schaumburg are deactivated in production.
      {
        // Phes's real commercial contract (was in Jotform). Distinct name from
        // the generic "Commercial Cleaning Agreement" above so seeding adds it
        // without disturbing whatever a company already has.
        company_id: req.auth!.companyId,
        name: "Commercial Service Agreement",
        type: "agreement",
        category: "commercial",
        schema: [] as any,
        terms_body: COMMERCIAL_AGREEMENT_BODY,
        requires_sign: true,
        is_active: true,
        is_default: true,
        created_by: req.auth!.userId,
      },
      {
        company_id: req.auth!.companyId,
        name: "New Client Intake Form",
        type: "intake",
        category: "both",
        schema: [
          { id: "f_name", type: "text", label: "Full Name", required: true, variable: "client_name" },
          { id: "f_phone", type: "tel", label: "Phone", required: true, variable: "client_phone" },
          { id: "f_email", type: "email", label: "Email", required: true, variable: "client_email" },
          { id: "f_address", type: "text", label: "Address", required: true, variable: "client_address" },
          { id: "f_pets", type: "select", label: "Pets in home?", required: false, variable: "pets", options: ["No pets", "Dog(s)", "Cat(s)", "Both dogs and cats", "Other"] },
          { id: "f_allergies", type: "textarea", label: "Allergies or sensitivities we should know about?", required: false, variable: "allergies" },
          { id: "f_priority", type: "textarea", label: "Areas to prioritize?", required: false, variable: "priority_areas" },
          { id: "f_hear", type: "select", label: "How did you hear about us?", required: false, variable: "referral_source", options: ["Google", "Facebook", "Instagram", "Friend/Family referral", "Nextdoor", "Other"] },
        ] as any,
        terms_body: null,
        requires_sign: false,
        is_active: true,
        is_default: true,
        created_by: req.auth!.userId,
      },
      {
        company_id: req.auth!.companyId,
        name: "Post-Service Inspection Checklist",
        type: "inspection",
        category: "both",
        schema: [
          { id: "s_kitchen", type: "section", label: "Kitchen" },
          { id: "f_counters", type: "radio", label: "Counters cleaned", required: false, options: ["Pass", "Needs attention", "N/A"] },
          { id: "f_sink", type: "radio", label: "Sink scrubbed", required: false, options: ["Pass", "Needs attention", "N/A"] },
          { id: "f_appliances", type: "radio", label: "Appliance exteriors wiped", required: false, options: ["Pass", "Needs attention", "N/A"] },
          { id: "s_bathroom", type: "section", label: "Bathrooms" },
          { id: "f_toilet", type: "radio", label: "Toilets sanitized", required: false, options: ["Pass", "Needs attention", "N/A"] },
          { id: "f_shower", type: "radio", label: "Shower/tub scrubbed", required: false, options: ["Pass", "Needs attention", "N/A"] },
          { id: "f_mirror", type: "radio", label: "Mirrors cleaned", required: false, options: ["Pass", "Needs attention", "N/A"] },
          { id: "s_general", type: "section", label: "General" },
          { id: "f_floors", type: "radio", label: "Floors vacuumed/mopped", required: false, options: ["Pass", "Needs attention", "N/A"] },
          { id: "f_dusting", type: "radio", label: "Dusting completed", required: false, options: ["Pass", "Needs attention", "N/A"] },
          { id: "f_notes", type: "textarea", label: "Inspector notes", required: false },
        ] as any,
        terms_body: null,
        requires_sign: false,
        is_active: true,
        is_default: true,
        created_by: req.auth!.userId,
      },
    ];

    const missing = defaults.filter(d => !existingNames.has(String(d.name || "").trim().toLowerCase()));
    if (missing.length === 0) {
      return res.json({ message: "Defaults already seeded", count: 0 });
    }
    const inserted = await db.insert(formTemplatesTable).values(missing).returning({ id: formTemplatesTable.id });
    return res.json({
      message: "Default templates seeded",
      count: inserted.length,
      added: missing.map(d => d.name),
    });
  } catch (err) {
    console.error("Seed defaults error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const template = await db
      .select()
      .from(formTemplatesTable)
      .where(and(eq(formTemplatesTable.id, id), eq(formTemplatesTable.company_id, req.auth!.companyId)))
      .limit(1);

    if (!template[0]) return res.status(404).json({ error: "Not Found" });
    return res.json(template[0]);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const { name, type, category, schema, terms_body, requires_sign } = req.body;
    const [inserted] = await db
      .insert(formTemplatesTable)
      .values({
        company_id: req.auth!.companyId,
        name,
        type: type || "agreement",
        category: category || "both",
        schema: schema || [],
        terms_body: terms_body || null,
        requires_sign: requires_sign ?? false,
        is_active: true,
        created_by: req.auth!.userId,
      })
      .returning();

    return res.status(201).json(inserted);
  } catch (err) {
    console.error("Create form template error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, type, category, schema, terms_body, requires_sign, is_active } = req.body;

    const [updated] = await db
      .update(formTemplatesTable)
      .set({
        ...(name !== undefined && { name }),
        ...(type !== undefined && { type }),
        ...(category !== undefined && { category }),
        ...(schema !== undefined && { schema }),
        // [agreement-body 2026-08-19] Editing the body hands ownership of the
        // text to the office. -1 permanently excludes this row from the boot
        // refresh, so a shipped revision of the default contract can never
        // overwrite a clause someone here wrote on purpose.
        ...(terms_body !== undefined && { terms_body, terms_body_seed_version: -1 }),
        ...(requires_sign !== undefined && { requires_sign }),
        ...(is_active !== undefined && { is_active }),
        updated_at: new Date(),
      })
      .where(and(eq(formTemplatesTable.id, id), eq(formTemplatesTable.company_id, req.auth!.companyId)))
      .returning();

    if (!updated) return res.status(404).json({ error: "Not Found" });
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/:id/duplicate", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [original] = await db
      .select()
      .from(formTemplatesTable)
      .where(and(eq(formTemplatesTable.id, id), eq(formTemplatesTable.company_id, req.auth!.companyId)))
      .limit(1);

    if (!original) return res.status(404).json({ error: "Not Found" });

    const [copy] = await db
      .insert(formTemplatesTable)
      .values({
        company_id: req.auth!.companyId,
        name: `${original.name} (Copy)`,
        type: original.type,
        category: original.category,
        schema: original.schema as any,
        terms_body: original.terms_body,
        requires_sign: original.requires_sign,
        is_active: false,
        is_default: false,
        created_by: req.auth!.userId,
      })
      .returning();

    return res.status(201).json(copy);
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db
      .delete(formTemplatesTable)
      .where(and(eq(formTemplatesTable.id, id), eq(formTemplatesTable.company_id, req.auth!.companyId)));
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [agreement-from-client 2026-08-19] Office-gated. This mints a signing token
// for a binding contract; it was previously open to any authenticated user,
// which includes every technician.
router.post("/:id/send", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const templateId = parseInt(req.params.id);
    const { client_id, custom_fields } = req.body;

    const [template] = await db
      .select()
      .from(formTemplatesTable)
      .where(and(eq(formTemplatesTable.id, templateId), eq(formTemplatesTable.company_id, req.auth!.companyId)))
      .limit(1);

    if (!template) return res.status(404).json({ error: "Template not found" });

    let clientEmail = req.body.email || null;
    let clientName = req.body.client_name || null;

    if (client_id) {
      const [client] = await db
        .select({ email: clientsTable.email, first_name: clientsTable.first_name, last_name: clientsTable.last_name })
        .from(clientsTable)
        .where(eq(clientsTable.id, client_id))
        .limit(1);
      if (client) {
        clientEmail = clientEmail || client.email;
        clientName = clientName || `${client.first_name} ${client.last_name}`;
      }
    }

    const signToken = randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const [submission] = await db
      .insert(formSubmissionsTable)
      .values({
        company_id: req.auth!.companyId,
        form_id: templateId,
        client_id: client_id || null,
        responses: custom_fields || {},
        status: "pending",
        sign_token: signToken,
        sent_at: new Date(),
        sent_to: clientEmail,
        expires_at: expiresAt,
        submitted_by: req.auth!.userId,
      })
      .returning();

    // [agreement-merge 2026-07-22] Fill {{client_name}} / {{rate}} / etc. from the
    // client + company records and PERSIST the result on this submission, so the
    // signer, the stored record and the certificate all show identical text. A
    // caller-supplied terms_body_override (per-send hand edit) is rendered too,
    // so hand-edited text can still use variables. No-op for templates with no
    // variables in them.
    try {
      const { renderAgreementFor } = await import("../lib/agreement-merge.js");
      const sourceBody = req.body.terms_body_override || template.terms_body || "";
      if (sourceBody) {
        const rendered = await renderAgreementFor(req.auth!.companyId, sourceBody, {
          clientId: client_id || null,
        });
        if (rendered) {
          await db.execute(sql`UPDATE form_submissions SET terms_body_override = ${rendered} WHERE id = ${submission.id}`);
        }
      }
    } catch (e) {
      console.error("[agreement-merge] render on send (non-fatal):", e);
    }

    // [agreement-esign] Record the 'sent' audit event for the Certificate of Completion.
    await db.execute(sql`INSERT INTO agreement_events (company_id, agreement_id, event_type, actor_email, meta)
      VALUES (${req.auth!.companyId}, ${submission.id}, 'sent', ${clientEmail ?? null}, ${JSON.stringify({ by_user: req.auth!.userId })}::jsonb)`).catch(() => {});

    const signingUrl = `${req.headers.origin || ''}/sign/${signToken}`;
    console.log(`[AGREEMENT SENT] To: ${clientEmail} | Name: ${clientName} | URL: ${signingUrl}`);

    return res.status(201).json({
      submission_id: submission.id,
      sign_token: signToken,
      signing_url: signingUrl,
      sent_to: clientEmail,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error("Send agreement error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
