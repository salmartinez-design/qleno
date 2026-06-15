import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Two-way SMS conversation store ────────────────────────────────────────────
// Canonical helpers for persisting + reading SMS in the unified sms_messages
// table. Tenant-scoped throughout; no per-tenant hardcoding.

// Last-10 digits — the canonical thread key. Robust to formatting differences
// across records ("+16308844318", "6308844318", "(630) 884-4318").
export function phone10(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "").slice(-10);
}

// Resolve the receiving tenant from the destination ("To") number. Company-level
// twilio_from_number is unique per tenant, so match it FIRST (avoids the
// duplicate-branch ambiguity); fall back to a branch number only if no company
// matches. Returns companyId or null.
export async function resolveTenantByNumber(toRaw: string): Promise<number | null> {
  const to = phone10(toRaw);
  if (!to) return null;
  // Match on last-10 (robust to formatting) but rank deterministically so a
  // malformed/duplicate number can never win: (1) exact E.164 match to the
  // incoming To, (2) well-formed numbers with a country code (>=11 digits) over
  // bare 10-digit leftovers, (3) lowest id. Company match takes precedence over
  // branch match.
  const co = await db.execute(sql`
    SELECT id FROM companies
     WHERE right(regexp_replace(coalesce(twilio_from_number,''),'\\D','','g'),10) = ${to}
     ORDER BY (twilio_from_number = ${toRaw}) DESC,
              (length(regexp_replace(coalesce(twilio_from_number,''),'\\D','','g')) >= 11) DESC,
              id ASC
     LIMIT 1`);
  if ((co.rows[0] as any)?.id != null) return Number((co.rows[0] as any).id);
  const br = await db.execute(sql`
    SELECT company_id FROM branches
     WHERE right(regexp_replace(coalesce(twilio_from_number,''),'\\D','','g'),10) = ${to}
     ORDER BY (twilio_from_number = ${toRaw}) DESC,
              (length(regexp_replace(coalesce(twilio_from_number,''),'\\D','','g')) >= 11) DESC,
              id ASC
     LIMIT 1`);
  return (br.rows[0] as any)?.company_id != null ? Number((br.rows[0] as any).company_id) : null;
}

export interface ContactMatch { client_id: number | null; lead_id: number | null; name: string | null }

// Match a customer phone (last-10) to a CLIENT first, then a LEAD, within the
// tenant. Either/both may be null when the number is unknown.
export async function matchContact(companyId: number, fromRaw: string): Promise<ContactMatch> {
  const p = phone10(fromRaw);
  if (!p) return { client_id: null, lead_id: null, name: null };
  const cl = await db.execute(sql`
    SELECT id, first_name, last_name FROM clients
     WHERE company_id = ${companyId}
       AND right(regexp_replace(coalesce(phone,''),'\\D','','g'),10) = ${p}
     LIMIT 1`);
  if (cl.rows[0]) {
    const c = cl.rows[0] as any;
    return { client_id: Number(c.id), lead_id: null, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null };
  }
  const ld = await db.execute(sql`
    SELECT id, first_name, last_name FROM leads
     WHERE company_id = ${companyId}
       AND right(regexp_replace(coalesce(phone,''),'\\D','','g'),10) = ${p}
     LIMIT 1`);
  if (ld.rows[0]) {
    const l = ld.rows[0] as any;
    return { client_id: null, lead_id: Number(l.id), name: [l.first_name, l.last_name].filter(Boolean).join(" ") || null };
  }
  return { client_id: null, lead_id: null, name: null };
}

// Persist an INBOUND SMS. Matches the sender to a client/lead and stores the
// body unread (read_at null). Returns the inserted row id + the match.
export async function recordInboundSms(args: {
  companyId: number; fromRaw: string; toRaw: string; body: string; providerId?: string | null;
}): Promise<{ id: number; match: ContactMatch }> {
  const match = await matchContact(args.companyId, args.fromRaw);
  const cp = phone10(args.fromRaw);
  const r = await db.execute(sql`
    INSERT INTO sms_messages
      (company_id, contact_phone, client_id, lead_id, direction, body, from_number, to_number, provider_id, status, read_at)
    VALUES
      (${args.companyId}, ${cp}, ${match.client_id}, ${match.lead_id}, 'inbound', ${args.body},
       ${args.fromRaw}, ${args.toRaw}, ${args.providerId ?? null}, 'received', NULL)
    RETURNING id`);
  return { id: Number((r.rows[0] as any).id), match };
}

// Persist an OUTBOUND SMS (manual reply / send). Outbound is "read" on insert.
export async function recordOutboundSms(args: {
  companyId: number; toRaw: string; fromNumber: string | null; body: string;
  providerId?: string | null; sentBy?: number | null; clientId?: number | null; leadId?: number | null;
  status?: string;
}): Promise<{ id: number }> {
  const cp = phone10(args.toRaw);
  const r = await db.execute(sql`
    INSERT INTO sms_messages
      (company_id, contact_phone, client_id, lead_id, direction, body, from_number, to_number, provider_id, status, read_at, sent_by)
    VALUES
      (${args.companyId}, ${cp}, ${args.clientId ?? null}, ${args.leadId ?? null}, 'outbound', ${args.body},
       ${args.fromNumber ?? null}, ${args.toRaw}, ${args.providerId ?? null}, ${args.status ?? "sent"}, NOW(), ${args.sentBy ?? null})
    RETURNING id`);
  return { id: Number((r.rows[0] as any).id) };
}

// Read a contact's SMS thread (chronological) by client_id, lead_id, or phone.
export async function getThread(companyId: number, key: { clientId?: number | null; leadId?: number | null; phone?: string | null }) {
  let where;
  if (key.clientId != null) where = sql`client_id = ${key.clientId}`;
  else if (key.leadId != null) where = sql`lead_id = ${key.leadId}`;
  else where = sql`contact_phone = ${phone10(key.phone)}`;
  const r = await db.execute(sql`
    SELECT id, direction, body, from_number, to_number, status, read_at, created_at, contact_phone, client_id, lead_id
      FROM sms_messages
     WHERE company_id = ${companyId} AND ${where}
     ORDER BY created_at ASC`);
  return r.rows;
}

// Mark a contact's inbound messages read (called when the thread is opened).
export async function markThreadRead(companyId: number, phone: string) {
  await db.execute(sql`
    UPDATE sms_messages SET read_at = NOW()
     WHERE company_id = ${companyId} AND contact_phone = ${phone10(phone)} AND direction = 'inbound' AND read_at IS NULL`);
}
