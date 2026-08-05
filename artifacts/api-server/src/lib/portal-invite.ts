// [customer-portal 2026-08-05] ONE implementation of "invite a customer to the
// portal", shared by every surface that offers it:
//
//   POST /api/portal/auth/invite      (account contacts + clients, new)
//   POST /api/clients/:id/portal-invite (the customer profile's existing button)
//
// Both had to end up here rather than growing their own copy. The clients.ts
// version previously minted a token, wrote "Portal invitation sent to …" into
// the communication log, and returned "Invitation sent" — while never calling
// the mailer at all. The office saw a success, the log agreed with it, and the
// customer got nothing. One implementation is how that stops being possible.
import { db } from "@workspace/db";
import { portalUsersTable, clientsTable, accountContactsTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { appBaseUrl } from "./app-url.js";
import { sendNotification } from "../services/notificationService.js";
import { mintPortalToken, normalizeEmail, findPortalUserByEmail } from "./portal-auth.js";

export interface InviteResult {
  ok: boolean;
  /** Present when a portal login exists (even if the email failed to leave). */
  portalUserId?: number;
  /** TRUE only when the mailer actually accepted the message. */
  emailed: boolean;
  message: string;
  status: number;
}

/**
 * Create (or refresh) a portal login and email a set-password link.
 *
 * Exactly one of clientId / accountContactId. The recipient address is read off
 * the RECORD, never accepted from a caller — otherwise this becomes a way to
 * send a working login link to an arbitrary address.
 */
export async function invitePortalUser(opts: {
  companyId: number;
  clientId?: number | null;
  accountContactId?: number | null;
}): Promise<InviteResult> {
  const clientId = opts.clientId ?? null;
  const contactId = opts.accountContactId ?? null;
  if ((clientId == null) === (contactId == null)) {
    return { ok: false, emailed: false, status: 400, message: "Pass exactly one of client_id or account_contact_id" };
  }

  // Resolve WITHIN the tenant. A bare id would match across companies.
  let email: string | null = null;
  let name: string | null = null;
  if (clientId != null) {
    const [c] = await db
      .select({ email: clientsTable.email, first: clientsTable.first_name, last: clientsTable.last_name })
      .from(clientsTable)
      .where(and(eq(clientsTable.id, clientId), eq(clientsTable.company_id, opts.companyId)))
      .limit(1);
    if (!c) return { ok: false, emailed: false, status: 404, message: "Client not found" };
    email = c.email;
    name = [c.first, c.last].filter(Boolean).join(" ") || null;
  } else {
    const [c] = await db
      .select({ email: accountContactsTable.email, name: accountContactsTable.name })
      .from(accountContactsTable)
      .where(and(eq(accountContactsTable.id, contactId!), eq(accountContactsTable.company_id, opts.companyId)))
      .limit(1);
    if (!c) return { ok: false, emailed: false, status: 404, message: "Account contact not found" };
    email = c.email;
    name = c.name;
  }
  if (!email) {
    return { ok: false, emailed: false, status: 400, message: "That record has no email address — add one first" };
  }

  const existing = await findPortalUserByEmail(opts.companyId, email);
  let portalUserId: number;
  if (existing) {
    // Re-invite. Deliberately does NOT clear an existing password: a customer
    // who already set one keeps working while the new link is outstanding.
    portalUserId = existing.id;
    await db.update(portalUsersTable).set({ is_active: true }).where(eq(portalUsersTable.id, existing.id));
  } else {
    const [created] = await db.insert(portalUsersTable).values({
      company_id: opts.companyId,
      email: normalizeEmail(email),
      name,
      client_id: clientId,
      account_contact_id: contactId,
    }).returning({ id: portalUsersTable.id });
    portalUserId = created.id;
  }

  const raw = await mintPortalToken({ companyId: opts.companyId, portalUserId, kind: "verify" });

  // The portal is routed per company (/portal/:slug/…), so the link must carry
  // the slug — without it the customer lands on a sign-in page for a company
  // named "set-password".
  const co = await db.execute(sql`SELECT slug FROM companies WHERE id = ${opts.companyId} LIMIT 1`);
  const slug = (co.rows[0] as any)?.slug;
  const link = slug
    ? `${appBaseUrl()}/portal/${slug}/set-password?token=${raw}`
    : `${appBaseUrl()}/portal/set-password?token=${raw}`;

  // Transactional: a deliberate staff action, so it bypasses the marketing
  // comms gate. An invite that silently doesn't arrive is a customer sitting
  // waiting for an email nobody sent.
  const emailed = await sendNotification(
    "portal_invite", "email", opts.companyId, normalizeEmail(email), null,
    { first_name: (name || "").split(" ")[0] || "", portal_link: link },
    true,
  ).catch(() => false);

  return {
    ok: true,
    portalUserId,
    emailed,
    status: 200,
    // Never claim delivery that didn't happen — the caller surfaces this
    // verbatim, and the old endpoint's fictional "Invitation sent" is exactly
    // what this wording exists to prevent.
    message: emailed
      ? `Invite sent to ${email}`
      : "Portal login created, but the invite email did not send",
  };
}
