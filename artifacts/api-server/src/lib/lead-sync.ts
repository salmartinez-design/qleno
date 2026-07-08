import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Quote→lead pipeline sync: a quote create/send/convert keeps the lead pipeline
// in step (find-or-create lead, advance stage, link the quote, log activity),
// and inbound replies stop the cadence. All tenant-scoped, non-blocking.

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

async function logActivity(companyId: number, leadId: number, action: string, note?: string | null, userId?: number | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO lead_activity_log (lead_id, company_id, action_type, note, performed_by)
    VALUES (${leadId}, ${companyId}, ${action}, ${note ?? null}, ${userId ?? null})
  `).catch(() => {});
}

// Find-or-create the lead for a quote (match by email/phone within company),
// link quotes.lead_id, return the lead id.
export async function upsertLeadForQuote(companyId: number, quote: any): Promise<number | null> {
  try {
    let email = quote.lead_email ? String(quote.lead_email).toLowerCase().trim() : null;
    let phone10 = digits(quote.lead_phone).slice(-10) || null;
    const nameParts = String(quote.lead_name ?? "").trim().split(/\s+/).filter(Boolean);
    let first = nameParts[0] || null;
    let last = nameParts.slice(1).join(" ") || null;
    // Raw (un-normalized) contact used for the INSERT/UPDATE, seeded from the
    // quote's own lead_* fields. Existing-client quotes leave these null and
    // carry the customer on client_id instead — resolve those below.
    let insEmail: string | null = quote.lead_email ?? null;
    let insPhone: string | null = quote.lead_phone ?? null;

    // Existing-client quotes (quote builder for a known client) don't populate
    // lead_name/email/phone — the contact lives on the clients row via client_id.
    // Without this, every such quote produced a blank "Lead" placeholder. Pull the
    // real name/contact so the lead lands NAMED and dedupes against any existing
    // lead by email/phone.
    if (!email && !phone10 && !first && quote.client_id) {
      try {
        const cl = await db.execute(sql`
          SELECT first_name, last_name, email, phone FROM clients
          WHERE id = ${quote.client_id} AND company_id = ${companyId} LIMIT 1`);
        const row = cl.rows[0] as any;
        if (row) {
          first = row.first_name || first;
          last = row.last_name || last;
          email = row.email ? String(row.email).toLowerCase().trim() : email;
          phone10 = digits(row.phone).slice(-10) || phone10;
          insEmail = row.email ?? insEmail;
          insPhone = row.phone ?? insPhone;
        }
      } catch { /* leave contact as-is */ }
    }
    // Scope label for the lead pipeline. The quote stamps the scope name onto
    // service_type at CREATE, but PATCH (the builder's edit/save path) doesn't —
    // so fall back to resolving the name from scope_id, else the lead's Scope
    // column stays blank.
    let scope = quote.service_type || null;
    if (!scope && quote.scope_id) {
      try {
        const sc = await db.execute(sql`SELECT name FROM pricing_scopes WHERE id = ${quote.scope_id} LIMIT 1`);
        scope = (sc.rows[0] as any)?.name ?? null;
      } catch { /* leave scope null */ }
    }
    const address = quote.address ?? null;

    // Resolve the lead: the quote's existing link first, else match by
    // email/phone within the company, else create.
    let leadId: number | null = quote.lead_id ?? null;
    if (!leadId && (email || phone10)) {
      const m = await db.execute(sql`
        SELECT id FROM leads WHERE company_id = ${companyId} AND (
          (${email}::text IS NOT NULL AND lower(email) = ${email}) OR
          (${phone10}::text IS NOT NULL AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = ${phone10})
        ) ORDER BY id DESC LIMIT 1`);
      leadId = (m.rows[0] as any)?.id ?? null;
    }

    if (!leadId) {
      // Don't create a blank "Lead" placeholder for a contactless draft (no name,
      // no email, no phone — a fresh autosave before the office filled anything in).
      // A later PATCH/send/convert, once contact exists, will create the lead then.
      if (!first && !email && !phone10) return null;
      const insFirst = first || "Lead";
      const ins = await db.execute(sql`
        INSERT INTO leads (company_id, first_name, last_name, email, phone, address, scope, source, status, created_at, updated_at)
        VALUES (${companyId}, ${insFirst}, ${last}, ${insEmail}, ${insPhone},
                ${address}, ${scope}, ${quote.referral_source || "quote"}, 'needs_contacted', NOW(), NOW())
        RETURNING id`);
      leadId = (ins.rows[0] as any).id;
      await logActivity(companyId, leadId!, "created", "Lead created from quote", null);
      // Auto-enroll the fresh needs-contact lead in the phone lead drip.
      // Quote-builder leads are worked over the phone; without this only the
      // manual New Lead form path enrolled, so the pipeline's dominant lead
      // source never got a drip. Stopped again at the quoted/booked handoffs
      // below and on inbound reply.
      try {
        const { enrollForLeadDrip } = await import("../services/followUpService.js");
        await enrollForLeadDrip(companyId, leadId!, "phone_in");
      } catch (e) { console.error("[lead-sync] enrollForLeadDrip", e); }
    } else {
      // Enrich the existing lead. The lead is frequently created bare during
      // draft autosave (no name/contact); fill/refresh its descriptive fields
      // from the quote. COALESCE(NULLIF(...)) overwrites a placeholder/value
      // when the quote provides one, but never wipes an existing value with null.
      await db.execute(sql`
        UPDATE leads SET
          first_name = COALESCE(NULLIF(${first}, ''), first_name),
          last_name  = COALESCE(NULLIF(${last}, ''), last_name),
          email      = COALESCE(${insEmail}, email),
          phone      = COALESCE(${insPhone}, phone),
          address    = COALESCE(${address}, address),
          scope      = COALESCE(${scope}, scope),
          updated_at = NOW()
        WHERE id = ${leadId} AND company_id = ${companyId}`);
    }
    await db.execute(sql`UPDATE quotes SET lead_id = ${leadId} WHERE id = ${quote.id} AND company_id = ${companyId}`);
    return leadId;
  } catch (e) { console.error("[lead-sync] upsertLeadForQuote", e); return null; }
}

// Advance a lead's stage + stamp the matching timestamp + optional job/amount.
export async function advanceLeadStage(
  companyId: number, leadId: number, stage: string,
  opts: { jobId?: number; quoteAmount?: number | string | null; note?: string | null; userId?: number | null } = {},
): Promise<void> {
  try {
    const stampCol = stage === "quoted" ? "quoted_at" : stage === "booked" ? "booked_at" : stage === "contacted" ? "contacted_at" : null;
    await db.execute(sql`
      UPDATE leads SET status = ${stage}, updated_at = NOW()
        ${stampCol ? sql`, ${sql.raw(stampCol)} = COALESCE(${sql.raw(stampCol)}, NOW())` : sql``}
        ${opts.jobId != null ? sql`, job_id = ${opts.jobId}` : sql``}
        ${opts.quoteAmount != null ? sql`, quote_amount = ${String(opts.quoteAmount)}` : sql``}
        ${opts.userId != null ? sql`, assigned_to = COALESCE(assigned_to, ${opts.userId})` : sql``}
       WHERE id = ${leadId} AND company_id = ${companyId}`);
    await logActivity(companyId, leadId, `stage_${stage}`, opts.note ?? null, opts.userId);
    // Drip handoffs: quoted → the quote_followup cadence owns the conversation,
    // so the nurture drip stops (otherwise the lead gets both). booked → all
    // cadences stop; this covers the quote-convert paths, which advance the
    // stage here without going through PATCH /leads.
    if (stage === "quoted") {
      const { stopLeadDripEnrollments } = await import("../services/followUpService.js");
      await stopLeadDripEnrollments(companyId, leadId, "quote_sent").catch(() => {});
    } else if (stage === "booked") {
      const { stopEnrollmentsForLead } = await import("../services/followUpService.js");
      await stopEnrollmentsForLead(leadId, "lead_booked").catch(() => {});
    }
  } catch (e) { console.error("[lead-sync] advanceLeadStage", e); }
}

// Link a follow-up enrollment to its lead (after enrollForQuoteSent enrolled by quote).
export async function linkEnrollmentToLead(companyId: number, quoteId: number, leadId: number): Promise<void> {
  await db.execute(sql`
    UPDATE follow_up_enrollments SET lead_id = ${leadId}
     WHERE company_id = ${companyId} AND quote_id = ${quoteId} AND lead_id IS NULL
  `).catch(() => {});
}

// Inbound reply / opt-out → stop active cadence for the lead(s) on that phone.
export async function handleInboundReply(companyId: number, fromPhone: string, optOut: boolean): Promise<number[]> {
  const phone10 = digits(fromPhone).slice(-10);
  if (!phone10) return [];
  const leads = await db.execute(sql`
    SELECT id FROM leads WHERE company_id = ${companyId}
      AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = ${phone10}`);
  const ids = (leads.rows as any[]).map(r => r.id);
  const reason = optOut ? "opted_out" : "replied";
  for (const id of ids) {
    await db.execute(sql`
      UPDATE follow_up_enrollments SET stopped_at = NOW(), stopped_reason = ${reason}
       WHERE company_id = ${companyId} AND lead_id = ${id} AND completed_at IS NULL AND stopped_at IS NULL`).catch(() => {});
    await logActivity(companyId, id, reason, optOut ? "Customer opted out (STOP)" : "Customer replied — cadence stopped", null);
  }
  return ids;
}
