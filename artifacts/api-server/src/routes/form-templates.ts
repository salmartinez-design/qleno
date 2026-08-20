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
import { nextReminderAt } from "../lib/agreement-lifecycle.js";
import { appBaseUrl } from "../lib/app-url.js";

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

// [agreement-lifecycle 2026-08-20] The office list. This used to return the bare
// bones - form, client, status, signed-by - which meant the only question it
// could answer was "is it signed yet". It could not tell you whether the
// customer had even opened it, how many times, when we last chased them, when
// the link dies, why somebody said no, or which agreement replaced a cancelled
// one. Raw SQL rather than the drizzle select because most of these columns are
// added by the ensure-columns migration and are not in the generated schema.
router.get("/submissions", requireAuth, async (req, res) => {
  try {
    const { form_id, client_id, status } = req.query;
    const companyId = req.auth!.companyId;
    const formId = form_id ? parseInt(form_id as string) : null;
    const clientId = client_id ? parseInt(client_id as string) : null;
    const statusFilter = status ? String(status) : null;

    const rows = (await db.execute(sql`
      SELECT fs.id, fs.form_id, fs.client_id,
             trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) AS client_name,
             c.email AS client_email, c.phone AS client_phone,
             fs.status, fs.sent_at, fs.sent_to, fs.sent_to_phone,
             fs.submitted_at, fs.signature_name, fs.signature_at, fs.ip_address,
             fs.pdf_url, fs.content_hash, fs.expires_at, fs.created_at, fs.sign_token,
             fs.viewed_at, fs.last_viewed_at, coalesce(fs.view_count, 0) AS view_count,
             fs.declined_at, fs.decline_reason, fs.declined_name,
             fs.cancelled_at, fs.cancel_reason, fs.cancel_kind, fs.superseded_by_id,
             coalesce(fs.reminder_step, 0) AS reminder_step,
             fs.next_reminder_at, fs.last_reminder_at,
             coalesce(fs.reminders_enabled, true) AS reminders_enabled,
             coalesce(fs.resend_count, 0) AS resend_count, fs.last_resent_at,
             ft.name AS form_name, ft.type AS form_type, ft.category AS form_category,
             u.name AS sent_by_name
        FROM form_submissions fs
        LEFT JOIN clients c ON c.id = fs.client_id
        LEFT JOIN form_templates ft ON ft.id = fs.form_id
        LEFT JOIN users u ON u.id = fs.submitted_by
       WHERE fs.company_id = ${companyId}
         AND (${formId}::int IS NULL OR fs.form_id = ${formId}::int)
         AND (${clientId}::int IS NULL OR fs.client_id = ${clientId}::int)
         AND (${statusFilter}::text IS NULL OR fs.status = ${statusFilter}::text)
       ORDER BY fs.created_at DESC`)).rows;

    return res.json(rows);
  } catch (err) {
    console.error("List form submissions error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// The full history behind one agreement, newest last, exactly as the Certificate
// of Completion prints it. The office list shows this inline so nobody has to
// download a PDF to answer "did they ever open it".
router.get("/submissions/:id/events", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = (await db.execute(sql`
      SELECT id, event_type, actor_email, ip_address, user_agent, meta, created_at
        FROM agreement_events
       WHERE agreement_id = ${id} AND company_id = ${req.auth!.companyId}
       ORDER BY created_at ASC, id ASC`)).rows;
    return res.json(rows);
  } catch (err) {
    console.error("Agreement events error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [agreement-lifecycle 2026-08-20] Pull an agreement back.
//
// Two different situations wear the same button. "We need to fix something"
// means the wording or the price is wrong and a corrected one is coming, so the
// customer should be told to wait rather than sign the copy in their inbox.
// "Cancel it" means there is no corrected one coming. The customer email and
// what the office expects next are different in each case, so the kind is
// recorded, not guessed.
//
// Either way the old link stops working immediately. Leaving a wrong agreement
// signable for the rest of its 30 days is how a customer ends up holding a
// contract at the wrong rate, and a signature on it would be perfectly valid.
router.post("/submissions/:id/cancel", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const kind = req.body?.kind === "revision" ? "revision" : "cancelled";
    const reason = String(req.body?.reason || "").trim().slice(0, 2000);
    const notifyCustomer = req.body?.notify_customer !== false;
    const companyId = req.auth!.companyId;

    const row = (await db.execute(sql`
      SELECT fs.id, fs.status, fs.client_id, fs.sent_to, ft.name AS form_name,
             c.first_name AS client_first, co.logo_url AS company_logo
        FROM form_submissions fs
        LEFT JOIN form_templates ft ON ft.id = fs.form_id
        LEFT JOIN clients c ON c.id = fs.client_id
        LEFT JOIN companies co ON co.id = fs.company_id
       WHERE fs.id = ${id} AND fs.company_id = ${companyId} LIMIT 1`)).rows[0] as any;

    if (!row) return res.status(404).json({ error: "Agreement not found" });
    if (row.status === "signed") {
      return res.status(409).json({ error: "This one is already signed. A signed agreement cannot be cancelled here." });
    }
    if (row.status === "cancelled") return res.json({ ok: true, already: true });

    await db.execute(sql`
      UPDATE form_submissions
         SET status = 'cancelled',
             cancelled_at = now(),
             cancelled_by = ${req.auth!.userId},
             cancel_kind = ${kind},
             cancel_reason = ${reason || null},
             reminders_enabled = false,
             next_reminder_at = NULL
       WHERE id = ${id} AND company_id = ${companyId}`);

    await db.execute(sql`
      INSERT INTO agreement_events (company_id, agreement_id, event_type, meta)
      VALUES (${companyId}, ${id}, 'cancelled',
              ${JSON.stringify({ kind, reason, by_user: req.auth!.userId })}::jsonb)`);

    // Tell the customer only if there is an address and the office wants to. A
    // silent pull-back is a real choice: sometimes the office is fixing a typo
    // nobody saw and a "please disregard" email just creates a question.
    let emailed = false;
    if (notifyCustomer && row.sent_to) {
      try {
        const { emailLogoUrl } = await import("../lib/app-url.js");
        const { agreementEmailShell } = await import("../lib/phes-agreement-emails.js");
        const { sendNotification } = await import("../services/notificationService.js");
        const logoUrl = emailLogoUrl(row.company_logo ?? null);
        emailed = await sendNotification(
          kind === "revision" ? "agreement_revising" : "agreement_cancelled",
          "email",
          companyId,
          String(row.sent_to),
          null,
          {
            first_name: String(row.client_first || "").trim(),
            agreement_name: String(row.form_name || "Service Agreement"),
            reason,
          },
          true,
          (bodyHtml, v) => agreementEmailShell({
            logoUrl,
            companyName: v.company_name,
            companyPhone: v.company_phone,
            companyEmail: v.company_email,
            title: kind === "revision" ? "We are updating your agreement" : "Your agreement has been withdrawn",
            banner: kind === "revision" ? "A corrected copy is on the way" : "Please disregard the agreement we sent",
          }, bodyHtml),
          row.client_id ?? null,
        );
      } catch (e) {
        console.error("[agreement-cancel] customer email (non-fatal):", e);
      }
    }

    return res.json({ ok: true, kind, emailed });
  } catch (err) {
    console.error("Cancel agreement error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// [agreement-lifecycle 2026-08-20] Send it again, optionally somewhere else.
//
// The everyday case is a customer saying "I never got it" or "use my work
// email" or "just text it to me". Before this the office had to send a brand
// new agreement, which left two live links for the same contract and two rows
// in the list, and whichever one got signed was luck.
//
// This keeps ONE agreement and one signature. The link and the frozen wording
// do not change, so nothing about what they are signing moves. What changes is
// where it goes, when it dies, and the chase clock, which restarts from the top
// because a customer who is seeing it for the first time today deserves the
// same run of reminders as one who got it a month ago.
router.post("/submissions/:id/resend", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const companyId = req.auth!.companyId;
    const newEmail = String(req.body?.email || "").trim();
    const newPhone = String(req.body?.phone || "").trim();
    const alsoText = req.body?.also_text === true;

    const row = (await db.execute(sql`
      SELECT fs.id, fs.status, fs.client_id, fs.sign_token, fs.sent_to, fs.sent_to_phone,
             ft.name AS form_name, c.first_name AS client_first, c.phone AS client_phone,
             co.logo_url AS company_logo
        FROM form_submissions fs
        LEFT JOIN form_templates ft ON ft.id = fs.form_id
        LEFT JOIN clients c ON c.id = fs.client_id
        LEFT JOIN companies co ON co.id = fs.company_id
       WHERE fs.id = ${id} AND fs.company_id = ${companyId} LIMIT 1`)).rows[0] as any;

    if (!row) return res.status(404).json({ error: "Agreement not found" });
    if (row.status === "signed") return res.status(409).json({ error: "This one is already signed" });
    if (row.status === "cancelled") {
      return res.status(409).json({ error: "This one was cancelled. Send a new agreement instead." });
    }

    const toEmail = newEmail || String(row.sent_to || "").trim();
    const toPhone = newPhone || String(row.sent_to_phone || row.client_phone || "").trim();
    if (!toEmail) return res.status(400).json({ error: "There is no email address to send this to" });

    // A resend revives a declined or expired agreement. That is the point: the
    // customer said no because something was wrong, we fixed it, here it is
    // again. The decline reason stays on the row as history.
    const anchor = new Date();
    const expires = new Date();
    expires.setDate(expires.getDate() + 30);
    const firstReminder = nextReminderAt(anchor, 0);

    await db.execute(sql`
      UPDATE form_submissions
         SET status = 'pending',
             sent_to = ${toEmail},
             sent_to_phone = ${toPhone || null},
             sent_at = now(),
             expires_at = ${expires},
             resend_count = coalesce(resend_count, 0) + 1,
             last_resent_at = now(),
             cadence_anchor_at = ${anchor},
             reminder_step = 0,
             reminders_enabled = true,
             next_reminder_at = ${firstReminder}
       WHERE id = ${id} AND company_id = ${companyId}`);

    const link = `${appBaseUrl()}/sign/${row.sign_token}`;
    const vars: Record<string, string> = {
      first_name: String(row.client_first || "").trim(),
      agreement_name: String(row.form_name || "Service Agreement"),
      agreement_link: link,
      expires_days: "30",
    };

    const { emailLogoUrl } = await import("../lib/app-url.js");
    const { agreementEmailShell } = await import("../lib/phes-agreement-emails.js");
    const { sendNotification } = await import("../services/notificationService.js");
    const logoUrl = emailLogoUrl(row.company_logo ?? null);

    // Transactional, same as the first send: a person pressed a button for one
    // named customer who is expecting it.
    const emailed = await sendNotification(
      "agreement_send", "email", companyId, toEmail, null, vars, true,
      (bodyHtml, v) => agreementEmailShell({
        logoUrl,
        companyName: v.company_name,
        companyPhone: v.company_phone,
        companyEmail: v.company_email,
        title: `Your ${v.company_name || "Phes"} service agreement`,
        banner: "Please review and sign your service agreement",
      }, bodyHtml),
      row.client_id ?? null,
    );

    let texted = false;
    if (alsoText && toPhone) {
      texted = await sendNotification("agreement_reminder", "sms", companyId, null, toPhone,
        { ...vars, status_line: "", days_left: "30", expires_on: "" }, true, undefined, row.client_id ?? null);
    }

    await db.execute(sql`
      INSERT INTO agreement_events (company_id, agreement_id, event_type, actor_email, meta)
      VALUES (${companyId}, ${id}, 'resent', ${toEmail},
              ${JSON.stringify({ by_user: req.auth!.userId, to_email: toEmail, to_phone: toPhone || null, emailed, texted })}::jsonb)`);

    return res.json({ ok: true, emailed, texted, sent_to: toEmail, sent_to_phone: toPhone || null, expires_at: expires });
  } catch (err) {
    console.error("Resend agreement error:", err);
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

    // [agreement-lifecycle 2026-08-20] Start the reminder clock on this send too.
    // Both send paths have to seed it, or an agreement sent from this screen
    // would sit forever with nothing chasing it while one sent from the client
    // profile got the full cadence.
    try {
      const anchor = new Date();
      await db.execute(sql`
        UPDATE form_submissions
           SET cadence_anchor_at = ${anchor},
               next_reminder_at = ${nextReminderAt(anchor, 0)},
               sent_to_phone = ${String(req.body?.phone || "").trim() || null}
         WHERE id = ${submission.id}`);
    } catch (e) {
      console.error("[agreement-lifecycle] cadence seed (non-fatal):", e);
    }

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
