// [comms-opt-out 2026-06-21] Compliance layer for SMS STOP + email unsubscribe.
//
// Before this, SMS STOP was only handled at Twilio's carrier level (Qleno
// recorded nothing, so reminder/review crons still fired at opted-out people)
// and email had no unsubscribe at all (the mockup linked a dead
// phes.io/unsubscribe). Both are legal exposure (TCPA / CAN-SPAM) before comms
// go live. This module is the single source of truth for:
//   * reading opt-out state on every send path (isSmsOptedOut / isEmailOptedOut)
//   * setting it from the Twilio inbound webhook (setSmsOptOutByPhone) and the
//     tokenized email unsubscribe route (setEmailOptOutByToken)
//   * building the List-Unsubscribe headers + footer link for outbound email
//
// Multi-tenant: every lookup is company-scoped (token lookup resolves its own
// company). Reads FAIL OPEN (send) on a DB/transient error or a pre-migration
// schema so a hiccup can't silently black-hole all comms — but a recorded
// opt-out is always honored.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  phoneDigits,
  isStopKeyword,
  isStartKeyword,
  appBaseUrl,
  buildUnsubDataFromToken,
  type EmailUnsubData,
} from "./opt-out-core.js";

// Re-export the pure surface so existing importers of this module are unchanged.
export { phoneDigits, isStopKeyword, isStartKeyword, appBaseUrl, buildUnsubDataFromToken };
export type { EmailUnsubData };

// True when a client in this company with this phone has opted out of SMS.
export async function isSmsOptedOut(companyId: number, phone: string | null | undefined): Promise<boolean> {
  const d = phoneDigits(phone);
  if (!d || d.length < 10) return false;
  try {
    const r = await db.execute(sql`
      SELECT 1 FROM (
        SELECT phone FROM clients WHERE company_id = ${companyId} AND sms_opt_out_at IS NOT NULL
        UNION ALL
        SELECT phone FROM leads   WHERE company_id = ${companyId} AND sms_opt_out_at IS NOT NULL
      ) t
       WHERE right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10) = ${d}
       LIMIT 1
    `);
    return r.rows.length > 0;
  } catch (e) {
    console.warn("[opt-out] isSmsOptedOut read failed (failing open):", (e as any)?.message ?? e);
    return false;
  }
}

// True when a client in this company with this email has opted out of email.
export async function isEmailOptedOut(companyId: number, email: string | null | undefined): Promise<boolean> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e) return false;
  try {
    const r = await db.execute(sql`
      SELECT 1 FROM (
        SELECT email FROM clients WHERE company_id = ${companyId} AND email_opt_out_at IS NOT NULL
        UNION ALL
        SELECT email FROM leads   WHERE company_id = ${companyId} AND email_opt_out_at IS NOT NULL
      ) t
       WHERE lower(email) = ${e}
       LIMIT 1
    `);
    return r.rows.length > 0;
  } catch (err) {
    console.warn("[opt-out] isEmailOptedOut read failed (failing open):", (err as any)?.message ?? err);
    return false;
  }
}

// Set / clear the SMS opt-out flag for every client in a company matching a
// phone (last-10). Returns the number of client rows updated. Used by the Twilio
// inbound webhook.
export async function setSmsOptOutByPhone(companyId: number, phone: string, optedOut: boolean): Promise<number> {
  const d = phoneDigits(phone);
  if (!d || d.length < 10) return 0;
  try {
    const rc = await db.execute(sql`
      UPDATE clients
         SET sms_opt_out_at = ${optedOut ? sql`now()` : sql`NULL`}
       WHERE company_id = ${companyId}
         AND right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10) = ${d}
    `);
    // [lead-opt-out 2026-07-09] Also flag the lead(s) on that phone — the drip
    // audience is leads, so a STOP that only touched clients left them opted in.
    const rl = await db.execute(sql`
      UPDATE leads
         SET sms_opt_out_at = ${optedOut ? sql`now()` : sql`NULL`}
       WHERE company_id = ${companyId}
         AND right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10) = ${d}
    `);
    return ((rc as any).rowCount ?? 0) + ((rl as any).rowCount ?? 0);
  } catch (e) {
    console.error("[opt-out] setSmsOptOutByPhone failed:", (e as any)?.message ?? e);
    return 0;
  }
}

// [opt-out-confirmation 2026-07-11] Send the ONE compliance confirmation a
// customer gets after texting STOP. The office reported that opt-outs registered
// silently — the cadence stopped and the flag was set, but nothing was sent, so
// it "looked" like the STOP did nothing (John Trocellier). Best-effort and
// self-contained:
//   • Replies from the SAME number the customer texted (thread continuity).
//   • Honors the comms gate via resolveSender().reason — if comms are globally /
//     tenant / branch disabled we don't (and can't) send.
//   • Deliberately BYPASSES the app-level opt-out suppression: this is the single
//     message allowed AFTER a STOP, so we call the Twilio primitive directly
//     rather than a guarded send path.
//   • If the carrier already has the number on its STOP list (Twilio's own
//     default opt-out already answered), Twilio rejects ours with error 21610 —
//     caught and logged, never fatal. The opt-out itself already stuck.
//   • Logs the sent confirmation into sms_messages so the office SEES it in the
//     conversation thread.
// Returns true only when Twilio accepted the message.
// [opt-out-visible 2026-08-13] Sal: "we still can't see in message thread if the
// customer gets the opt out confirmation after they reply stop."
//
// The confirmation was only ever recorded when Twilio ACCEPTED it. Every other
// outcome wrote nothing to the thread, so the office saw the customer's STOP and
// then silence — with no way to tell whether the customer was answered, and no
// way to tell an unsubscribed customer from a broken one.
//
// The most common outcome is exactly the invisible one: Twilio's own opt-out
// handling already replied and put the number on its STOP list, so OUR send is
// rejected with 21610. The customer DID get a confirmation — from the carrier —
// and the thread showed nothing.
//
// So every path now leaves a mark. A delivered confirmation is logged as the
// outbound message it is; anything else writes an internal note explaining what
// the customer actually received, on the contact's own log so it renders in the
// thread (client → communication_log, lead → lead_activity_log — the same two
// stores POST /notes writes to).
async function noteOnThread(companyId: number, phone: string, body: string): Promise<void> {
  const d = phoneDigits(phone);
  if (!d || d.length < 10) return;
  try {
    const r = await db.execute(sql`
      SELECT
        (SELECT c.id FROM clients c WHERE c.company_id = ${companyId}
           AND right(regexp_replace(COALESCE(c.phone,''),'\\D','','g'),10) = ${d} ORDER BY c.id LIMIT 1) AS client_id,
        (SELECT l.id FROM leads l WHERE l.company_id = ${companyId}
           AND right(regexp_replace(COALESCE(l.phone,''),'\\D','','g'),10) = ${d} ORDER BY l.id DESC LIMIT 1) AS lead_id`);
    const row = r.rows[0] as any;
    // Column names and filters mirror POST /notes and the thread's note-merge
    // exactly — the merge only reads communication_log WHERE channel='note' and
    // lead_activity_log WHERE action_type='note_added' AND note IS NOT NULL, so
    // anything else is written and never rendered.
    if (row?.client_id) {
      await db.execute(sql`
        INSERT INTO communication_log
          (company_id, customer_id, direction, channel, summary, body)
        VALUES (${companyId}, ${Number(row.client_id)}, 'internal', 'note', ${body}, ${body})`);
    } else if (row?.lead_id) {
      await db.execute(sql`
        INSERT INTO lead_activity_log (lead_id, company_id, action_type, note, created_at)
        VALUES (${Number(row.lead_id)}, ${companyId}, 'note_added', ${body}, NOW())`);
    }
  } catch (e) {
    console.warn("[opt-out] thread note failed:", (e as any)?.message ?? e);
  }
}

export async function sendSmsOptOutConfirmation(
  companyId: number,
  toPhone: string,
  fromNumber?: string | null,
): Promise<boolean> {
  try {
    const { resolveSender, sendSmsVia } = await import("./comms-sender.js");
    const sender = await resolveSender(companyId);
    if (sender.reason) {
      console.log(`[opt-out] confirmation skipped (${sender.reason}) company=${companyId}`);
      // Texting is switched off, so nobody replied to them. The opt-out itself
      // still stuck — say both, because those are different facts.
      await noteOnThread(companyId, toPhone,
        "Opted out of texts. No confirmation was sent — texting is currently disabled for this account.");
      return false;
    }
    // Reply from the exact number the customer texted, when we have it.
    const from = (fromNumber && String(fromNumber).trim()) || sender.from_number;
    if (!from) return false;
    // Name the brand in the copy (carriers expect opt-out confirmations to
    // identify the sender).
    let brand = "Our team";
    try {
      const r = await db.execute(sql`SELECT name FROM companies WHERE id = ${companyId} LIMIT 1`);
      brand = (r.rows[0] as any)?.name || brand;
    } catch { /* non-fatal — fall back to the generic label */ }
    const body = `${brand}: You're unsubscribed and won't receive more texts. Reply START to resubscribe.`;
    await sendSmsVia({ ...sender, from_number: from }, toPhone, body);
    try {
      const { recordOutboundSms } = await import("./sms-store.js");
      await recordOutboundSms({ companyId, toRaw: toPhone, fromNumber: from, body });
    } catch (e) { console.warn("[opt-out] confirmation log failed:", (e as any)?.message ?? e); }
    return true;
  } catch (e: any) {
    // 21610 = recipient already opted out at the carrier (Twilio answered it).
    console.warn(`[opt-out] confirmation not delivered: ${e?.message ?? e}`);
    // The distinction the office needs: 21610 means the CUSTOMER WAS ANSWERED,
    // just by the carrier rather than by us — the opt-out worked and the thread
    // should say so. Anything else means nobody answered them, which is a
    // different problem and shouldn't read the same.
    const code = Number(e?.code ?? e?.status ?? 0);
    const carrierHandled = code === 21610 || /21610|opted out|blacklist/i.test(String(e?.message ?? ""));
    await noteOnThread(companyId, toPhone,
      carrierHandled
        ? "Opted out of texts. The carrier had already sent its own STOP confirmation, so ours was not delivered — the customer was answered and will receive no further texts."
        : `Opted out of texts. The confirmation could not be sent (${e?.message ?? "unknown error"}) — the customer may not have received a reply.`);
    return false;
  }
}

// Set the email opt-out flag from an unsubscribe token. Returns the affected
// client (id/email/company_id) or null when the token doesn't match. Idempotent.
export async function setEmailOptOutByToken(
  token: string,
): Promise<{ id: number; email: string | null; company_id: number } | null> {
  const t = String(token ?? "").trim();
  if (!t) return null;
  try {
    const r = await db.execute(sql`
      UPDATE clients SET email_opt_out_at = now()
       WHERE email_unsub_token = ${t}
       RETURNING id, email, company_id
    `);
    if (r.rows.length) return (r.rows[0] as any);
    // [lead-opt-out 2026-07-09] Token might belong to a lead, not a client.
    const rl = await db.execute(sql`
      UPDATE leads SET email_opt_out_at = now()
       WHERE email_unsub_token = ${t}
       RETURNING id, email, company_id
    `);
    return (rl.rows[0] as any) ?? null;
  } catch (e) {
    console.error("[opt-out] setEmailOptOutByToken failed:", (e as any)?.message ?? e);
    return null;
  }
}

// Re-subscribe via token (the confirmation page offers it for accidental clicks).
export async function clearEmailOptOutByToken(
  token: string,
): Promise<{ id: number; email: string | null; company_id: number } | null> {
  const t = String(token ?? "").trim();
  if (!t) return null;
  try {
    const r = await db.execute(sql`
      UPDATE clients SET email_opt_out_at = NULL
       WHERE email_unsub_token = ${t}
       RETURNING id, email, company_id
    `);
    if (r.rows.length) return (r.rows[0] as any);
    // [lead-opt-out 2026-07-09] Token might belong to a lead, not a client.
    const rl = await db.execute(sql`
      UPDATE leads SET email_opt_out_at = NULL
       WHERE email_unsub_token = ${t}
       RETURNING id, email, company_id
    `);
    return (rl.rows[0] as any) ?? null;
  } catch (e) {
    console.error("[opt-out] clearEmailOptOutByToken failed:", (e as any)?.message ?? e);
    return null;
  }
}

// Resolve (or lazily mint) the unsubscribe token for a recipient email in a
// company, and build the List-Unsubscribe headers + a footer link. Returns null
// when no matching client row exists (e.g. a lead-only recipient or a fresh
// schema) — callers then send without the header rather than failing.
export async function buildEmailUnsubData(
  companyId: number,
  email: string | null | undefined,
): Promise<EmailUnsubData | null> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e) return null;
  try {
    // Look for a client first, then a lead. [lead-opt-out 2026-07-09] Drip
    // emails go to LEADS, so without the lead lookup those emails shipped with
    // no unsubscribe link (the old code returned null for lead-only recipients).
    let table: "clients" | "leads" = "clients";
    let r = await db.execute(sql`
      SELECT id, email_unsub_token FROM clients
       WHERE company_id = ${companyId} AND lower(email) = ${e}
       LIMIT 1
    `);
    if (!r.rows.length) {
      table = "leads";
      r = await db.execute(sql`
        SELECT id, email_unsub_token FROM leads
         WHERE company_id = ${companyId} AND lower(email) = ${e}
         LIMIT 1
      `);
    }
    const row = r.rows[0] as any;
    if (!row) return null;
    let token: string = row.email_unsub_token;
    if (!token) {
      token = randomUUID();
      await db.execute(sql`UPDATE ${sql.raw(table)} SET email_unsub_token = ${token} WHERE id = ${row.id}`);
    }
    return buildUnsubDataFromToken(token);
  } catch (err) {
    console.warn("[opt-out] buildEmailUnsubData failed:", (err as any)?.message ?? err);
    return null;
  }
}

// Idempotent boot migration: add the opt-out columns, backfill a token for every
// existing client, and add a unique index on the token. Safe to run on every
// cold start.
export async function runCommsOptOutMigration(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS sms_opt_out_at timestamp`);
    await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_opt_out_at timestamp`);
    await db.execute(sql`ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_unsub_token text`);
    // Backfill tokens for existing rows (gen_random_uuid from pgcrypto; falls
    // back silently if the extension isn't present on some installs).
    try {
      await db.execute(sql`
        UPDATE clients SET email_unsub_token = gen_random_uuid()::text
         WHERE email_unsub_token IS NULL
      `);
    } catch (e) {
      console.warn("[opt-out] token backfill via gen_random_uuid skipped:", (e as any)?.message ?? e);
    }
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS clients_email_unsub_token_uidx
        ON clients (email_unsub_token) WHERE email_unsub_token IS NOT NULL
    `);
    // [lead-opt-out 2026-07-09] Drip campaigns target LEADS, not clients, so the
    // opt-out flags + unsubscribe token must exist on leads too — otherwise a
    // lead who replies STOP or clicks unsubscribe is never recorded and gets
    // re-messaged, and lead drip emails ship with no unsubscribe link. Mirror
    // the exact client columns onto leads.
    await db.execute(sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_opt_out_at timestamp`);
    await db.execute(sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_opt_out_at timestamp`);
    await db.execute(sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_unsub_token text`);
    try {
      await db.execute(sql`
        UPDATE leads SET email_unsub_token = gen_random_uuid()::text
         WHERE email_unsub_token IS NULL
      `);
    } catch (e) {
      console.warn("[opt-out] lead token backfill via gen_random_uuid skipped:", (e as any)?.message ?? e);
    }
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS leads_email_unsub_token_uidx
        ON leads (email_unsub_token) WHERE email_unsub_token IS NOT NULL
    `);
    console.log("[opt-out] migration ok (clients + leads)");
  } catch (err) {
    console.error("[opt-out] migration error (non-fatal):", err);
  }
}
