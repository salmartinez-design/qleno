import { Router } from "express";
import { db } from "@workspace/db";
import { formTemplatesTable, formSubmissionsTable, clientsTable } from "@workspace/db/schema";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { randomUUID } from "crypto";

const router = Router();

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
Additional services (deep cleaning, move-in/out, appliance interiors, etc.) must be scheduled in advance and will be billed separately. PHES Cleaning LLC does not subcontract trades or maintenance work.

LOCKOUT POLICY
If our technicians arrive and are unable to gain access to the property, a lockout fee equal to the full service charge will apply. Please ensure access is available at the time of your scheduled service.

CANCELLATION AND RESCHEDULING
We require 48 hours advance notice to cancel or reschedule your appointment. Cancellations made within 48 hours of your scheduled service time during business hours (Monday–Friday 9:00 AM – 6:00 PM, Saturday 9:00 AM – 12:00 PM) will be charged a cancellation fee equal to 100% of the service cost. Exceptions may be made in cases of genuine emergency at management's discretion.

TERMINATION OF SERVICES
Either party may terminate recurring services with 30 days written notice. PHES Cleaning LLC reserves the right to terminate service immediately in cases of safety concerns, payment default, or hostile work environment.

PAYMENT TERMS
Payment is due on the day of service. We accept all major credit and debit cards. Your card on file will be automatically charged on the day of your scheduled service. Unpaid balances are subject to a late fee of $25 after 7 days.

SICK POLICY
For the health and safety of all our clients and staff, we will reschedule your service if a technician is ill. We will provide as much notice as possible and accommodate your rescheduling needs promptly at no penalty to you.

SAFETY AND WINTER ACCESS
In winter months, please ensure driveways and walkways are clear of snow and ice before your service. PHES Cleaning LLC reserves the right to reschedule services if conditions are deemed unsafe for our technicians. No cancellation fee will apply in these cases.

BODILY FLUIDS AND EXCLUSIONS
Our standard service does not include cleaning of bodily fluids, biohazardous materials, mold remediation, or pest-related cleanup. These require specialized services and will be declined or quoted separately.

SURFACE CARE DISCLAIMER
We take care with all surfaces, however PHES Cleaning LLC is not responsible for damage to improperly sealed, compromised, or pre-existing damaged surfaces. Please inform us of any fragile items or surfaces requiring special care before service.

SERVICE SUSPENSION POLICY
Clients may suspend recurring service for up to 90 days while retaining their scheduled appointment slot. Requests must be made with 48 hours notice. Suspension beyond 90 days may result in loss of your recurring time slot.

MINIMUM FREQUENCY PROTECTION
To maintain your cleaning rate and appointment slot, the maximum interval between cleanings is 60 days. Exceeding this interval may result in a rate adjustment to reflect the additional time required.

RECURRING RATE PROTECTION
Your rate is locked as long as you maintain your recurring schedule and frequency. Rate changes will be communicated with 30 days advance notice.

ANNUAL RATE REVIEW
PHES Cleaning LLC reserves the right to adjust rates annually in January based on labor costs, supply costs, and market conditions. Clients will be notified 30 days in advance of any rate change.

RATE CHANGES BASED ON CLEANING TIME
After your first 2–3 months of service, your rate may be adjusted to reflect the actual time required to clean your home to our standards. We will communicate any adjustment to you before it takes effect.

WEATHER POLICY
PHES Cleaning LLC may reschedule services due to severe weather conditions that pose safety risks to our staff. We will notify you as early as possible and reschedule at no penalty to you.

HOLIDAY CLOSURES
PHES Cleaning LLC observes the following holidays: New Year's Day, Memorial Day, Fourth of July, Labor Day, Thanksgiving Day, and Christmas Day. Services falling on these dates will be rescheduled.

24-HOUR SATISFACTION GUARANTEE
If you are not completely satisfied with your cleaning, please contact us within 24 hours and we will return to address any concerns at no additional charge. We stand behind our work.

BREAKAGE AND DAMAGE POLICY
PHES Cleaning LLC carries liability insurance. In the event of accidental damage caused by our technicians, please report it within 24 hours. We do not accept liability for items weighing over 25 lbs or items that were pre-existing in a damaged condition. Damage claims are handled on a case-by-case basis.`;

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
    const existing = await db
      .select({ id: formTemplatesTable.id })
      .from(formTemplatesTable)
      .where(and(
        eq(formTemplatesTable.company_id, req.auth!.companyId),
        eq(formTemplatesTable.is_default, true)
      ));

    if (existing.length > 0) {
      return res.json({ message: "Defaults already seeded", count: existing.length });
    }

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
PHES Cleaning LLC maintains professional cleaning standards. Clients may request inspection access to verify service quality.

LIABILITY
PHES Cleaning LLC carries commercial general liability insurance. Certificate of insurance available upon request.

CONFIDENTIALITY
All client information and property details will be kept strictly confidential.`,
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

    const inserted = await db.insert(formTemplatesTable).values(defaults).returning({ id: formTemplatesTable.id });
    return res.json({ message: "Default templates seeded", count: inserted.length });
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
