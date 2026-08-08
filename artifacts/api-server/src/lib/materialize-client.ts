// [lead-card-link 2026-08-08] Turn a lead-only quote into a real client row.
//
// Extracted verbatim from the `/quotes/:id/convert` handler, which has done this
// since [convert-client-fix 2026-06-16], because a SECOND caller now needs the
// same behaviour: texting or emailing a save-card link. `payment_links.client_id`
// is NOT NULL, so a link cannot exist without a client — which is why the office
// could only send one to an existing customer. Sal, 2026-08-08: "for a new quote
// while on the phone i still need the ability to text or send the email."
//
// Shared rather than reimplemented so the two paths can never drift apart on the
// dedupe rule. If sending a link creates the client and the office then books the
// quote, convert MUST find that same client instead of inserting a twin — both
// now run this identical match.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface QuoteLeadFields {
  client_id?: number | null;
  lead_name?: string | null;
  lead_email?: string | null;
  lead_phone?: string | null;
  address?: string | null;
}

/**
 * Returns the client id for this quote, creating one from the lead fields when
 * the quote isn't already attached to a client. Returns null only when the quote
 * carries NO identifying detail at all (no name, email, phone or address).
 *
 * Dedupe: matches on email or last-10-digits of phone. A name-only lead has no
 * reliable key, so it always inserts fresh — same rule convert has always used.
 *
 * Also stamps `quotes.client_id` so the quote and the client stay tied together.
 */
export async function materializeClientForQuote(
  companyId: number,
  quoteId: number,
  q: QuoteLeadFields,
): Promise<number | null> {
  if (q.client_id) return q.client_id;

  const hasIdentity = q.lead_email || q.lead_phone || q.lead_name || q.address;
  if (!hasIdentity) return null;

  const emailLc = q.lead_email ? String(q.lead_email).toLowerCase().trim() : null;
  const phone10 = String(q.lead_phone || "").replace(/\D/g, "").slice(-10) || null;

  const match = (emailLc || phone10)
    ? await db.execute(sql`
        SELECT id FROM clients WHERE company_id = ${companyId} AND (
          (${emailLc}::text IS NOT NULL AND lower(email) = ${emailLc}) OR
          (${phone10}::text IS NOT NULL AND right(regexp_replace(coalesce(phone,''),'\\D','','g'),10) = ${phone10})
        ) ORDER BY id DESC LIMIT 1`)
    : { rows: [] as any[] };

  let clientId: number | null = (match.rows[0] as any)?.id ?? null;

  if (!clientId) {
    const np = String(q.lead_name ?? "").trim().split(/\s+/).filter(Boolean);
    const ins = await db.execute(sql`
      INSERT INTO clients (company_id, first_name, last_name, email, phone, address)
      VALUES (${companyId}, ${np[0] || q.lead_name || "Client"}, ${np.slice(1).join(" ") || ""},
              ${q.lead_email ?? null}, ${q.lead_phone ?? null}, ${q.address ?? null})
      RETURNING id`);
    clientId = (ins.rows[0] as any)?.id ?? null;
  }

  if (clientId) {
    try {
      await db.execute(sql`
        UPDATE quotes SET client_id = ${clientId}
         WHERE id = ${quoteId} AND company_id = ${companyId}`);
    } catch { /* non-fatal: the client exists either way */ }
  }
  return clientId;
}
