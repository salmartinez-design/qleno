import { Router } from "express";
import { db } from "@workspace/db";
import { formTemplatesTable, formSubmissionsTable, clientsTable } from "@workspace/db/schema";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { randomUUID } from "crypto";

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

// [agreement-merge 2026-07-22] Phes's real commercial service agreement (the one
// that lived in Jotform), rewritten with {{merge variables}} so one template
// serves every building. Client name, address, rate, frequency and scope come
// from the estimate/client at send time — see lib/agreement-merge.ts.
const PHES_COMMERCIAL_SERVICE_AGREEMENT = `COMMERCIAL CLEANING SERVICE AGREEMENT

1. PARTIES
This Commercial Cleaning Service Agreement ("Agreement") is entered into on {{today}} by and between {{company_name}}, an Illinois company (the "Service Provider"), and {{client_company}} (the "Client").

2. CLIENT & SERVICE PROVIDER INFORMATION
Client Name: {{client_company}}
Service Address: {{service_address}}
Billing Method: Card on File
Service Provider: {{company_name}}
Provider Email: {{company_email}}
Provider Phone: {{company_phone}}

3. SERVICE SUMMARY & SCOPE

Effective Date: Services shall commence on {{effective_date}}.

Service Frequency: {{frequency}}
Scheduling: Exact service dates and times shall be determined by the Service Provider and may be adjusted due to holidays, weather conditions, building access restrictions, or operational needs, with reasonable notice provided to the Client.

Scope of Work
{{scope_of_work}}

Supplies and Equipment: The Service Provider will furnish all cleaning supplies and equipment necessary to perform these services.

4. PAYMENT TERMS & BILLING CYCLE

Rate: {{rate}} per visit - {{frequency}}

Payment Method: Card on file.

Due Date: Payment is due in full on the first visit of the month.

Late Payments: {{late_fee}}

Rate Adjustments: The Service Provider may adjust rates by providing {{rate_notice_days}} days' written notice. If the Client does not accept the adjusted rate, either party may terminate this Agreement effective on the proposed adjustment date, with no further obligation beyond services already performed.

Scope Limitation: The work performed will be strictly limited to the services listed in Section 3. Any additional tasks or requests outside this scope will be billed separately and require prior written approval.

5. CANCELLATION & ACCESS

Early Termination: Either party may terminate this Agreement with a {{termination_notice_days}}-day written notice, delivered as described in Section 10.

Lockout Policy: Service Provider shall provide forty-eight (48) hours' notice of the scheduled time. If the Service Provider is ready and able to perform services but is denied access to the property, the visit will be billed in full.

Keys and Access: Keys, fobs and access codes provided to the Service Provider will be stored securely and used only to perform services under this Agreement. The Client must notify the Service Provider immediately if access credentials change. The Service Provider is not responsible for re-keying or credential replacement costs unless a credential is lost through its negligence.

6. LIABILITY, DAMAGE & INSURANCE

Insurance: The Service Provider carries commercial general liability insurance. A certificate of insurance is available upon request.

Damage: The Service Provider will repair or replace items damaged through its negligence. The Client must report suspected damage in writing within {{damage_report_days}} business days of the service date; claims reported after that period cannot be verified and will not be honored. The Service Provider is not liable for damage arising from pre-existing wear, defects, or items that were not properly secured. Except where prohibited by law, the Service Provider's liability for damage to any item is limited to {{damage_cap}} unless a higher amount is agreed in writing in advance.

Governing Law: The laws of the State of Illinois govern this Agreement. Any disputes will be resolved in Cook County, Illinois.

7. NON-SOLICITATION

During the term of this Agreement and for {{nonsolicit_months}} months after it ends, the Client will not directly or indirectly hire, engage or solicit any employee or contractor of the Service Provider who performed services under this Agreement. If the Client does so, the Client agrees to pay a placement fee of {{nonsolicit_fee}}. The parties agree this amount is a reasonable estimate of the Service Provider's recruiting and training costs and is not a penalty.

8. INDEPENDENT CONTRACTOR

The Service Provider is an independent contractor. Personnel performing services are employees or contractors of the Service Provider only and are not employees of the Client. The Service Provider is solely responsible for their wages, taxes, insurance and supervision. Neither party is the agent of the other, and nothing in this Agreement creates a partnership or joint venture.

9. CONFIDENTIALITY

All client information and property details will be kept strictly confidential.

10. NOTICES

All notices required under this Agreement, including notice of termination, must be in writing. Written notice is validly delivered by email or by text message (SMS) to the addresses and numbers below, or to any address or number the parties later provide in writing. Notice is effective on the date it is sent.

To the Service Provider: {{company_email}} / {{company_phone}}
To the Client: {{client_email}} / {{client_phone}}

11. ENTIRE AGREEMENT

This Agreement constitutes the entire understanding between the parties. Any amendments must be in writing and signed by both parties.

By signing, the Client fully understands and agrees to the contents of this Agreement. The individual signing represents and warrants that they have authority to bind the Client. The Client is responsible for all amounts due for services provided or scheduled during the term and any notice period.`;

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

const PHES_RESIDENTIAL_TERMS = `ARRIVAL WINDOW
Our technicians operate within a 2–3 hour arrival window. Exact arrival times cannot be guaranteed due to the nature of home cleaning services. We will do our best to accommodate your schedule and notify you when your technician is on the way.

SERVICE GUIDELINES
We will begin services on the agreed start date. Your service includes a per-visit minimum and covers all standard cleaning tasks as discussed. Additional hours beyond the base rate are billed at the agreed hourly rate.

ADD-ONS AND TRADES POLICY
Additional services (deep cleaning, move-in/out, appliance interiors, etc.) must be scheduled in advance and will be billed separately. Phes does not subcontract trades or maintenance work.

LOCKOUT POLICY
If our technicians arrive and are unable to gain access to the property, a lockout fee equal to the full service charge will apply. Please ensure access is available at the time of your scheduled service.

CANCELLATION AND RESCHEDULING
We require 48 hours advance notice to cancel or reschedule your appointment. Cancellations made within 48 hours of your scheduled service time during business hours (Monday–Friday 9:00 AM – 6:00 PM, Saturday 9:00 AM – 12:00 PM) will be charged a cancellation fee equal to 100% of the service cost. Exceptions may be made in cases of genuine emergency at management's discretion.

TERMINATION OF SERVICES
Either party may terminate recurring services with 30 days written notice. Phes reserves the right to terminate service immediately in cases of safety concerns, payment default, or hostile work environment.

PAYMENT TERMS
Payment is due on the day of service. We accept all major credit and debit cards. Your card on file will be automatically charged on the day of your scheduled service. Unpaid balances are subject to a late fee of $25 after 7 days.

SICK POLICY
For the health and safety of all our clients and staff, we will reschedule your service if a technician is ill. We will provide as much notice as possible and accommodate your rescheduling needs promptly at no penalty to you.

SAFETY AND WINTER ACCESS
In winter months, please ensure driveways and walkways are clear of snow and ice before your service. Phes reserves the right to reschedule services if conditions are deemed unsafe for our technicians. No cancellation fee will apply in these cases.

BODILY FLUIDS AND EXCLUSIONS
Our standard service does not include cleaning of bodily fluids, biohazardous materials, mold remediation, or pest-related cleanup. These require specialized services and will be declined or quoted separately.

SURFACE CARE DISCLAIMER
We take care with all surfaces, however Phes is not responsible for damage to improperly sealed, compromised, or pre-existing damaged surfaces. Please inform us of any fragile items or surfaces requiring special care before service.

SERVICE SUSPENSION POLICY
Clients may suspend recurring service for up to 90 days while retaining their scheduled appointment slot. Requests must be made with 48 hours notice. Suspension beyond 90 days may result in loss of your recurring time slot.

MINIMUM FREQUENCY PROTECTION
To maintain your cleaning rate and appointment slot, the maximum interval between cleanings is 60 days. Exceeding this interval may result in a rate adjustment to reflect the additional time required.

RECURRING RATE PROTECTION
Your rate is locked as long as you maintain your recurring schedule and frequency. Rate changes will be communicated with 30 days advance notice.

ANNUAL RATE REVIEW
Phes reserves the right to adjust rates annually in January based on labor costs, supply costs, and market conditions. Clients will be notified 30 days in advance of any rate change.

RATE CHANGES BASED ON CLEANING TIME
After your first 2–3 months of service, your rate may be adjusted to reflect the actual time required to clean your home to our standards. We will communicate any adjustment to you before it takes effect.

WEATHER POLICY
Phes may reschedule services due to severe weather conditions that pose safety risks to our staff. We will notify you as early as possible and reschedule at no penalty to you.

HOLIDAY CLOSURES
Phes observes the following holidays: New Year's Day, Memorial Day, Fourth of July, Labor Day, Thanksgiving Day, and Christmas Day. Services falling on these dates will be rescheduled.

24-HOUR SATISFACTION GUARANTEE
If you are not completely satisfied with your cleaning, please contact us within 24 hours and we will return to address any concerns at no additional charge. We stand behind our work.

BREAKAGE AND DAMAGE POLICY
Phes carries liability insurance. In the event of accidental damage caused by our technicians, please report it within 24 hours. We do not accept liability for items weighing over 25 lbs or items that were pre-existing in a damaged condition. Damage claims are handled on a case-by-case basis.`;

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
        terms_body: PHES_RESIDENTIAL_TERMS,
        requires_sign: true,
        is_active: true,
        is_default: true,
        created_by: req.auth!.userId,
      },
      {
        company_id: req.auth!.companyId,
        name: "Commercial Cleaning Agreement",
        type: "agreement",
        category: "commercial",
        schema: [
          { id: "f_company", type: "text", label: "Company Name", required: true, variable: "company_name" },
          { id: "f_contact", type: "text", label: "Primary Contact", required: true, variable: "contact_name" },
          { id: "f_address", type: "text", label: "Property Address", required: true, variable: "property_address" },
          { id: "f_phone", type: "tel", label: "Phone", required: true, variable: "contact_phone" },
          { id: "f_email", type: "email", label: "Email", required: true, variable: "contact_email" },
          { id: "f_frequency", type: "select", label: "Service Frequency", required: true, variable: "service_frequency", options: ["Daily", "Weekly", "Bi-Weekly", "Monthly"] },
          { id: "f_scope", type: "textarea", label: "Scope of Work", required: true, variable: "scope_of_work" },
        ] as any,
        terms_body: `COMMERCIAL CLEANING AGREEMENT

SCOPE OF WORK
Services will be performed as outlined in the agreed scope of work. Any additional services outside the agreed scope will be quoted separately.

PAYMENT TERMS
Invoices are due NET 30 days from date of issue. Late payments are subject to a 1.5% monthly interest charge.

TERMINATION
Either party may terminate with 60 days written notice. Immediate termination may occur for non-payment or breach of contract.

PERFORMANCE STANDARDS
Phes maintains professional cleaning standards. Clients may request inspection access to verify service quality.

LIABILITY
Phes carries commercial general liability insurance. Certificate of insurance available upon request.

CONFIDENTIALITY
All client information and property details will be kept strictly confidential.`,
        requires_sign: true,
        is_active: true,
        is_default: true,
        created_by: req.auth!.userId,
      },
      {
        // Phes's real commercial contract (was in Jotform). Distinct name from
        // the generic "Commercial Cleaning Agreement" above so seeding adds it
        // without disturbing whatever a company already has.
        company_id: req.auth!.companyId,
        name: "Commercial Service Agreement",
        type: "agreement",
        category: "commercial",
        schema: [] as any,
        terms_body: PHES_COMMERCIAL_SERVICE_AGREEMENT,
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
        ...(terms_body !== undefined && { terms_body }),
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

router.post("/:id/send", requireAuth, async (req, res) => {
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
