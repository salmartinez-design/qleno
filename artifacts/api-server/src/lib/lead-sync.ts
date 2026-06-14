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
    if (quote.lead_id) return quote.lead_id;
    const email = quote.lead_email ? String(quote.lead_email).toLowerCase().trim() : null;
    const phone10 = digits(quote.lead_phone).slice(-10) || null;

    let leadId: number | null = null;
    if (email || phone10) {
      const m = await db.execute(sql`
        SELECT id FROM leads WHERE company_id = ${companyId} AND (
          (${email}::text IS NOT NULL AND lower(email) = ${email}) OR
          (${phone10}::text IS NOT NULL AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = ${phone10})
        ) ORDER BY id DESC LIMIT 1`);
      leadId = (m.rows[0] as any)?.id ?? null;
    }

    if (!leadId) {
      const nameParts = String(quote.lead_name ?? "").trim().split(/\s+/);
      const first = nameParts[0] || quote.lead_name || "Lead";
      const last = nameParts.slice(1).join(" ") || "";
      const ins = await db.execute(sql`
        INSERT INTO leads (company_id, first_name, last_name, email, phone, address, source, status, created_at, updated_at)
        VALUES (${companyId}, ${first}, ${last}, ${quote.lead_email ?? null}, ${quote.lead_phone ?? null},
                ${quote.address ?? null}, ${quote.referral_source || "quote"}, 'needs_contacted', NOW(), NOW())
        RETURNING id`);
      leadId = (ins.rows[0] as any).id;
      await logActivity(companyId, leadId!, "created", "Lead created from quote", null);
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
