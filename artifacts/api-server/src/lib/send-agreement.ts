// [agreement-from-client 2026-08-19] Send an e-signable service agreement to a
// client, from their profile or from a recurring signup.
//
// WHY THIS EXISTS: three separate agreement stacks had grown up in the codebase,
// and the "Send Agreement" button on the client profile was wired to the weakest
// of them (document_requests) — which merged no variables, captured no consent,
// wrote no audit event, and, most importantly, never emailed anybody. It minted
// a token nobody saw. The office pressed Send and the client received nothing.
//
// This routes the client profile onto the SAME stack the estimate flow already
// uses (form_templates → form_submissions → /sign/:token), which has the merge,
// the consent capture, the append-only event ledger, the content hash and the
// Certificate of Completion. Then it does the part none of the three ever did:
// it sends the email.
//
// The honest-return shape is copied from portal-invite.ts on purpose. "Sent"
// must never be claimed for a send that did not happen.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { appBaseUrl } from "./app-url.js";
import { renderAgreementFor } from "./agreement-merge.js";
import { sendNotification } from "../services/notificationService.js";

// How long a signing link stays good. Matches the estimate flow. The old
// document_requests path expired in 72 HOURS, which is not enough time for a
// customer to read a service contract over a weekend.
const LINK_VALID_DAYS = 30;

export interface SendAgreementOpts {
  companyId: number;
  clientId: number;
  /** Which property this contract covers. Defaults to the client's primary. */
  clientHomeId?: number | null;
  /** Pin a specific template. Defaults to the client's type-appropriate one. */
  templateId?: number | null;
  /** Office hand-edits for this one send. Merge variables still render. */
  termsBodyOverride?: string | null;
  sentByUserId?: number | null;
}

export interface SendAgreementResult {
  ok: boolean;
  emailed: boolean;
  status: number;
  message: string;
  submissionId?: number;
  signingUrl?: string;
  sentTo?: string | null;
}

/**
 * Pick the agreement template for a client. Residential and commercial contracts
 * are different documents, so the client's own type chooses, and an explicitly
 * flagged default wins over name matching.
 */
async function pickTemplate(companyId: number, clientType: string): Promise<{ id: number; terms_body: string | null; name: string } | null> {
  const wantCategory = clientType === "commercial" ? "commercial" : "client_residential";
  const rows = (await db.execute(sql`
    SELECT id, name, terms_body, category, is_default
      FROM form_templates
     WHERE company_id = ${companyId}
       AND is_active = true
       AND requires_sign = true
     ORDER BY (category = ${wantCategory}) DESC,
              is_default DESC NULLS LAST,
              (category = 'both') DESC,
              id ASC
     LIMIT 1
  `)).rows as any[];
  const t = rows[0];
  return t ? { id: t.id, terms_body: t.terms_body ?? null, name: t.name } : null;
}

export async function sendAgreementToClient(opts: SendAgreementOpts): Promise<SendAgreementResult> {
  const { companyId, clientId } = opts;

  const client: any = (await db.execute(sql`
    SELECT first_name, last_name, email, client_type
      FROM clients WHERE id = ${clientId} AND company_id = ${companyId} LIMIT 1
  `)).rows[0];
  if (!client) return { ok: false, emailed: false, status: 404, message: "Client not found" };
  const email = String(client.email || "").trim();
  if (!email) {
    return { ok: false, emailed: false, status: 400, message: "This client has no email address — add one first" };
  }

  let template: { id: number; terms_body: string | null; name: string } | null = null;
  if (opts.templateId) {
    const rows = (await db.execute(sql`
      SELECT id, name, terms_body FROM form_templates
       WHERE id = ${opts.templateId} AND company_id = ${companyId} AND is_active = true LIMIT 1
    `)).rows as any[];
    template = rows[0] ? { id: rows[0].id, terms_body: rows[0].terms_body ?? null, name: rows[0].name } : null;
  } else {
    template = await pickTemplate(companyId, String(client.client_type || "residential"));
  }
  if (!template) {
    return { ok: false, emailed: false, status: 400, message: "No signable agreement template — add one in Settings → Documents" };
  }

  // Merge at SEND time and persist the result, so the signing page, the stored
  // record, the hash and the certificate all show the identical words. A later
  // edit to the template can never change what a signed contract appears to say.
  const sourceBody = opts.termsBodyOverride || template.terms_body || "";
  const rendered = sourceBody
    ? await renderAgreementFor(companyId, sourceBody, { clientId, clientHomeId: opts.clientHomeId ?? null })
    : "";

  const token = randomUUID();
  const expires = new Date();
  expires.setDate(expires.getDate() + LINK_VALID_DAYS);

  const ins = (await db.execute(sql`
    INSERT INTO form_submissions
      (company_id, form_id, client_id, responses, status, sign_token, sent_at, sent_to, expires_at, submitted_by, terms_body_override)
    VALUES
      (${companyId}, ${template.id}, ${clientId}, '{}'::jsonb, 'pending', ${token}, now(), ${email}, ${expires}, ${opts.sentByUserId ?? null}, ${rendered || null})
    RETURNING id
  `)).rows[0] as any;
  const submissionId = ins.id as number;

  await db.execute(sql`
    INSERT INTO agreement_events (company_id, agreement_id, event_type, actor_email, meta)
    VALUES (${companyId}, ${submissionId}, 'sent', ${email},
            ${JSON.stringify({ by_user: opts.sentByUserId ?? null, client_id: clientId })}::jsonb)
  `).catch(() => {});

  const signingUrl = `${appBaseUrl()}/sign/${token}`;

  // Transactional: a deliberate staff action on a contract the client is
  // waiting for. Same reasoning as the portal invite — silently dropping this
  // leaves a customer who agreed to service with no way to sign.
  const emailed = await sendNotification(
    "agreement_send", "email", companyId, email, null,
    {
      first_name: String(client.first_name || "").trim(),
      agreement_name: template.name,
      agreement_link: signingUrl,
      expires_days: String(LINK_VALID_DAYS),
    },
    true,
  ).catch(() => false);

  return {
    ok: true,
    emailed,
    status: 200,
    submissionId,
    signingUrl,
    sentTo: email,
    message: emailed
      ? `Agreement sent to ${email}`
      : "Agreement created, but the email did not send — copy the signing link below",
  };
}
