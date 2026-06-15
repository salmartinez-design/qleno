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
    const email = quote.lead_email ? String(quote.lead_email).toLowerCase().trim() : null;
    const phone10 = digits(quote.lead_phone).slice(-10) || null;
    const nameParts = String(quote.lead_name ?? "").trim().split(/\s+/).filter(Boolean);
    const first = nameParts[0] || null;
    const last = nameParts.slice(1).join(" ") || null;
    // Scope label for the lead pipeline (the quote stamps the scope name onto
    // service_type at create).
    const scope = quote.service_type || null;
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
      // Create. Only fall back to "Lead" as a last resort when there's truly no
      // name yet (e.g. a draft autosave before the office filled in the quote).
      const insFirst = first || quote.lead_name || "Lead";
      const ins = await db.execute(sql`
        INSERT INTO leads (company_id, first_name, last_name, email, phone, address, scope, source, status, created_at, updated_at)
        VALUES (${companyId}, ${insFirst}, ${last}, ${quote.lead_email ?? null}, ${quote.lead_phone ?? null},
                ${address}, ${scope}, ${quote.referral_source || "quote"}, 'needs_contacted', NOW(), NOW())
        RETURNING id`);
      leadId = (ins.rows[0] as any).id;
      await logActivity(companyId, leadId!, "created", "Lead created from quote", null);
    } else {
      // Enrich the existing lead. The lead is frequently created bare during
      // draft autosave (no name/contact); fill/refresh its descriptive fields
      // from the quote. COALESCE(NULLIF(...)) overwrites a placeholder/value
      // when the quote provides one, but never wipes an existing value with null.
      await db.execute(sql`
        UPDATE leads SET
          first_name = COALESCE(NULLIF(${first}, ''), first_name),
          last_name  = COALESCE(NULLIF(${last}, ''), last_name),
          email      = COALESCE(${quote.lead_email ?? null}, email),
          phone      = COALESCE(${quote.lead_phone ?? null}, phone),
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
