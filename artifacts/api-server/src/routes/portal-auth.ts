// [customer-portal 2026-08-05] Password authentication for the customer portal:
// signup, email verification, login, forgot/reset, and the session probe.
// Mounted at /api/portal/auth. Design: docs/CUSTOMER_PORTAL_DESIGN.md.
//
// Residential and commercial customers use these SAME routes — the difference
// between them is which record their invite attached them to, resolved once at
// signup and never re-decided here (see lib/portal-auth.ts portalCapabilities).
//
// Signup is INVITE-ONLY by design. An open "create an account" form on a
// cleaning company's portal is an enumeration oracle: anyone could probe which
// email addresses are customers. Instead the office invites a client or an
// account contact, which mints a 'verify' token; the customer sets a password
// with that token in hand. Google/Apple sign-in will attach to the same
// portal_users row through portal_identities.
import { Router } from "express";
import { db } from "@workspace/db";
import { portalUsersTable, portalIdentitiesTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { appBaseUrl } from "../lib/app-url.js";
import { sendNotification } from "../services/notificationService.js";
import {
  signPortalToken, requirePortalAuth, portalCapabilities,
  hashPassword, verifyPassword, passwordProblem,
  mintPortalToken, redeemPortalToken, revokePortalTokens,
  normalizeEmail, findPortalUserByEmail,
} from "../lib/portal-auth.js";
import { invitePortalUser } from "../lib/portal-invite.js";
import { verifyGoogleIdToken, googlePortalClientId, googlePortalEnabled } from "../lib/portal-google.js";

// The portal is routed per company (/portal/:slug/...), so an emailed link must
// carry the slug. Without it "/portal/set-password" resolves as slug =
// "set-password" and the customer lands on a sign-in page for a company that
// doesn't exist.
async function portalLink(companyId: number, path: string, token: string): Promise<string> {
  const co = await db.execute(sql`SELECT slug FROM companies WHERE id = ${companyId} LIMIT 1`);
  const slug = (co.rows[0] as any)?.slug;
  return slug
    ? `${appBaseUrl()}/portal/${slug}/${path}?token=${token}`
    : `${appBaseUrl()}/portal/${path}?token=${token}`;
}

const router = Router();

// One reply for every "did this email exist?" branch. Login, forgot-password
// and invite all funnel through wording that reveals nothing about whether an
// address is on file.
const GENERIC_LOGIN_FAIL = "That email and password don't match";

function sessionFromUser(user: {
  id: number; company_id: number; email: string;
  client_id: number | null; account_contact_id: number | null;
}, impersonatedBy: number | null = null) {
  return {
    portalUserId: user.id,
    companyId: user.company_id,
    email: user.email,
    clientId: user.client_id,
    accountContactId: user.account_contact_id,
    impersonatedBy,
  };
}

// ── Office: invite a customer ───────────────────────────────────────────────
// POST /api/portal/auth/invite  { client_id } | { account_contact_id }
// Staff-only. Creates (or re-invites) the portal login and emails a set-password
// link. This is the ONLY way a portal_users row is born.
router.post("/invite", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const out = await invitePortalUser({
      companyId,
      clientId: req.body?.client_id ? parseInt(String(req.body.client_id)) : null,
      accountContactId: req.body?.account_contact_id ? parseInt(String(req.body.account_contact_id)) : null,
    });
    if (!out.ok) {
      return res.status(out.status).json({ error: out.status === 404 ? "Not Found" : "Bad Request", message: out.message });
    }
    logAudit(req, "PORTAL_INVITE", "portal_user", out.portalUserId ?? null, null, {
      client_id: req.body?.client_id ?? null,
      account_contact_id: req.body?.account_contact_id ?? null,
      emailed: out.emailed,
    });
    return res.json({ ok: true, portal_user_id: out.portalUserId, emailed: out.emailed, message: out.message });
  } catch (err) {
    console.error("Portal invite error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to invite this customer" });
  }
});

// ── Office: read the real login state ───────────────────────────────────────
// GET /api/portal/auth/status?client_id=123 | ?account_contact_id=456
//
// [portal-service-account 2026-08-20] The customer profile used to answer "does
// this person have portal access?" from `clients.portal_access` and
// `clients.portal_invite_sent_at` — legacy columns that the login path stopped
// consulting when identity moved to portal_users. The office could be looking at
// "Portal access: on" for a login that had been deactivated, or at an invite
// date for a customer who signed in months ago. One source of truth.
router.get("/status", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = req.query.client_id ? parseInt(String(req.query.client_id)) : null;
    const contactId = req.query.account_contact_id ? parseInt(String(req.query.account_contact_id)) : null;
    if ((clientId == null) === (contactId == null)) {
      return res.status(400).json({ error: "Bad Request", message: "Pass exactly one of client_id or account_contact_id" });
    }

    const [user] = await db
      .select({
        id: portalUsersTable.id,
        email: portalUsersTable.email,
        name: portalUsersTable.name,
        is_active: portalUsersTable.is_active,
        password_hash: portalUsersTable.password_hash,
        email_verified_at: portalUsersTable.email_verified_at,
        last_login_at: portalUsersTable.last_login_at,
        created_at: portalUsersTable.created_at,
      })
      .from(portalUsersTable)
      .where(and(
        eq(portalUsersTable.company_id, companyId),
        clientId != null
          ? eq(portalUsersTable.client_id, clientId)
          : eq(portalUsersTable.account_contact_id, contactId!),
      ))
      .limit(1);

    if (!user) return res.json({ exists: false });

    // Is there an unused, unexpired invite link still sitting in their inbox?
    // That is the difference between "invited, waiting on them" and "set up".
    const pending = await db.execute(sql`
      SELECT 1 FROM portal_tokens
       WHERE portal_user_id = ${user.id} AND kind = 'verify'
         AND used_at IS NULL AND expires_at > now()
       LIMIT 1`);

    // Which sign-in methods they actually have. A social-only account has no
    // password hash, and telling the office to "send them a reset" for one is
    // advice that leads nowhere.
    const providers = await db.execute(sql`
      SELECT provider FROM portal_identities WHERE portal_user_id = ${user.id}`);

    return res.json({
      exists: true,
      portal_user_id: user.id,
      email: user.email,
      name: user.name,
      is_active: user.is_active,
      // Never the hash itself, only whether one exists.
      has_password: !!user.password_hash,
      providers: (providers.rows as any[]).map((r) => r.provider),
      invite_pending: !!pending.rows[0],
      email_verified_at: user.email_verified_at,
      last_login_at: user.last_login_at,
      created_at: user.created_at,
    });
  } catch (err) {
    console.error("Portal status error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not read portal access" });
  }
});

// ── Office: send a password reset on the customer's behalf ──────────────────
// POST /api/portal/auth/send-reset  { client_id } | { account_contact_id }
//
// The customer-facing /forgot is deliberately vague and always 200s, because it
// is public. This one is staff-gated, so it can tell the office the truth: no
// login yet, or deactivated, or sent.
router.post("/send-reset", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = req.body?.client_id ? parseInt(String(req.body.client_id)) : null;
    const contactId = req.body?.account_contact_id ? parseInt(String(req.body.account_contact_id)) : null;
    if ((clientId == null) === (contactId == null)) {
      return res.status(400).json({ error: "Bad Request", message: "Pass exactly one of client_id or account_contact_id" });
    }

    const [user] = await db.select().from(portalUsersTable)
      .where(and(
        eq(portalUsersTable.company_id, companyId),
        clientId != null
          ? eq(portalUsersTable.client_id, clientId)
          : eq(portalUsersTable.account_contact_id, contactId!),
      ))
      .limit(1);
    if (!user) {
      return res.status(404).json({ error: "Not Found", message: "This customer has no portal login yet — invite them first" });
    }
    if (!user.is_active) {
      return res.status(400).json({ error: "Bad Request", message: "This portal login is turned off — turn it back on first" });
    }

    // Older reset links in their mailbox stop working, so there is exactly one
    // live link at a time and "the link doesn't work" has one cause, not two.
    await revokePortalTokens(user.id, "reset");
    const raw = await mintPortalToken({ companyId, portalUserId: user.id, kind: "reset", issuedByUserId: req.auth!.userId });
    const link = await portalLink(companyId, "set-password", raw);
    const sent = await sendNotification(
      "portal_password_reset", "email", companyId, user.email, null,
      { first_name: (user.name || "").split(" ")[0] || "", portal_link: link },
      // transactional: auth mail a person deliberately asked for, so it bypasses
      // the COMMS_ENABLED gate exactly like the staff password reset does.
      true,
    ).catch(() => false);

    logAudit(req, "PORTAL_RESET_SENT", "portal_user", user.id, null, { emailed: !!sent, customer_email: user.email });
    return res.json({
      ok: true,
      emailed: !!sent,
      message: sent ? `Reset link sent to ${user.email}` : "Could not send that email — check the address",
    });
  } catch (err) {
    console.error("Portal send-reset error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not send that reset" });
  }
});

// ── Office: turn a login off or back on ─────────────────────────────────────
// POST /api/portal/auth/set-active  { client_id | account_contact_id, active }
//
// This is what "Deactivate portal access" and "Cancel invitation" both are. The
// old profile button wrote clients.portal_access = false, a column nothing reads
// any more: it looked like a security control and did nothing. Turning a login
// off here takes effect on the customer's NEXT request, because requirePortalAuth
// re-reads portal_users every time rather than trusting the 12-hour token.
router.post("/set-active", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = req.body?.client_id ? parseInt(String(req.body.client_id)) : null;
    const contactId = req.body?.account_contact_id ? parseInt(String(req.body.account_contact_id)) : null;
    if ((clientId == null) === (contactId == null)) {
      return res.status(400).json({ error: "Bad Request", message: "Pass exactly one of client_id or account_contact_id" });
    }
    const active = req.body?.active === true;

    const [user] = await db.update(portalUsersTable)
      .set({ is_active: active })
      .where(and(
        eq(portalUsersTable.company_id, companyId),
        clientId != null
          ? eq(portalUsersTable.client_id, clientId)
          : eq(portalUsersTable.account_contact_id, contactId!),
      ))
      .returning({ id: portalUsersTable.id, email: portalUsersTable.email });
    if (!user) {
      return res.status(404).json({ error: "Not Found", message: "This customer has no portal login" });
    }

    // Turning access off also kills the links: an unused invite or reset link in
    // an old email would otherwise let them back in and re-activate on
    // set-password. Cancelling an invitation is this same call.
    if (!active) {
      await revokePortalTokens(user.id, "verify");
      await revokePortalTokens(user.id, "reset");
      await revokePortalTokens(user.id, "magic");
    }

    logAudit(req, active ? "PORTAL_ACCESS_ON" : "PORTAL_ACCESS_OFF", "portal_user", user.id, null, {
      client_id: clientId, account_contact_id: contactId, customer_email: user.email,
    });
    return res.json({
      ok: true,
      is_active: active,
      message: active ? "Portal access turned back on" : "Portal access turned off and any open links cancelled",
    });
  } catch (err) {
    console.error("Portal set-active error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not change portal access" });
  }
});

// ── Set password (completes an invite, and doubles as reset confirm) ────────
// POST /api/portal/auth/set-password  { token, password }
router.post("/set-password", async (req, res) => {
  try {
    const problem = passwordProblem(req.body?.password);
    if (problem) return res.status(400).json({ error: "Bad Request", message: problem });

    // Try both kinds: the same screen completes an invite and a reset, and the
    // customer cannot tell (nor should they care) which link they followed.
    const redeemed = (await redeemPortalToken(req.body?.token, "verify"))
      ?? (await redeemPortalToken(req.body?.token, "reset"));
    if (!redeemed) {
      return res.status(400).json({ error: "Bad Request", message: "That link has expired or was already used — ask for a new one" });
    }

    const hash = await hashPassword(req.body.password);
    const [user] = await db.update(portalUsersTable)
      .set({ password_hash: hash, email_verified_at: new Date(), is_active: true })
      .where(eq(portalUsersTable.id, redeemed.portalUserId))
      .returning();
    if (!user) return res.status(404).json({ error: "Not Found", message: "Login not found" });

    // Any other outstanding reset link in the mailbox stops working now.
    await revokePortalTokens(user.id, "reset");

    // Return the capability set alongside the token: the client forks on
    // kind ('commercial' vs 'residential') to pick a landing screen, and
    // without this it would silently fall back to the residential one.
    const session = sessionFromUser(user);
    return res.json({ ok: true, token: signPortalToken(session), capabilities: portalCapabilities(session) });
  } catch (err) {
    console.error("Portal set-password error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Failed to set your password" });
  }
});

// ── Login ───────────────────────────────────────────────────────────────────
// POST /api/portal/auth/login  { company_slug, email, password }
router.post("/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    const slug = String(req.body?.company_slug ?? "").trim();
    if (!email || !password || !slug) {
      return res.status(400).json({ error: "Bad Request", message: "Email, password and company are required" });
    }

    const co = await db.execute(sql`SELECT id FROM companies WHERE slug = ${slug} LIMIT 1`);
    const companyId = (co.rows[0] as any)?.id as number | undefined;
    if (!companyId) return res.status(401).json({ error: "Unauthorized", message: GENERIC_LOGIN_FAIL });

    const user = await findPortalUserByEmail(companyId, email);
    // verifyPassword still runs bcrypt when there's no user/hash, so a wrong
    // email and a wrong password cost the same time — otherwise the response
    // latency tells an attacker which addresses are real customers.
    const ok = await verifyPassword(password, user?.password_hash ?? null);
    if (!user || !ok || !user.is_active) {
      return res.status(401).json({ error: "Unauthorized", message: GENERIC_LOGIN_FAIL });
    }

    await db.update(portalUsersTable).set({ last_login_at: new Date() }).where(eq(portalUsersTable.id, user.id));
    const session = sessionFromUser(user);
    return res.json({
      token: signPortalToken(session),
      capabilities: portalCapabilities(session),
      user: { name: user.name, email: user.email },
    });
  } catch (err) {
    console.error("Portal login error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Sign-in failed" });
  }
});

// ── Forgot password ─────────────────────────────────────────────────────────
// POST /api/portal/auth/forgot  { company_slug, email }
// Always 200. Reporting "no such email" here would confirm which addresses are
// customers of this company.
router.post("/forgot", async (req, res) => {
  const ALWAYS = { ok: true, message: "If that email has a login, a reset link is on its way" };
  try {
    const email = normalizeEmail(req.body?.email);
    const slug = String(req.body?.company_slug ?? "").trim();
    if (!email || !slug) return res.json(ALWAYS);

    const co = await db.execute(sql`SELECT id FROM companies WHERE slug = ${slug} LIMIT 1`);
    const companyId = (co.rows[0] as any)?.id as number | undefined;
    if (!companyId) return res.json(ALWAYS);

    const user = await findPortalUserByEmail(companyId, email);
    if (user?.is_active) {
      const raw = await mintPortalToken({ companyId, portalUserId: user.id, kind: "reset" });
      const link = await portalLink(companyId, "set-password", raw);
      await sendNotification(
        "portal_password_reset", "email", companyId, user.email, null,
        { first_name: (user.name || "").split(" ")[0] || "", portal_link: link },
        true,
      ).catch(() => false);
    }
    return res.json(ALWAYS);
  } catch (err) {
    console.error("Portal forgot-password error:", err);
    return res.json(ALWAYS);
  }
});

// ── Office: view as customer ────────────────────────────────────────────────
// POST /api/portal/auth/impersonate  { client_id } | { account_contact_id }
//
// Sal's ask: "we can assimilate their view like we can with employees and walk
// them through how to do things." Staff-only, audited, and READ-ONLY — the
// read-only part is enforced by portalCapabilities(), which strips every
// money-moving and committing action whenever impersonatedBy is set. Support
// staff can see any screen the customer sees; they cannot pay an invoice,
// request work, or post a review as them.
//
// Returns a one-time URL rather than a raw session token: the token is minted
// into portal_tokens with issued_by_user_id, so every view-as session leaves an
// audit row naming the staff member and the customer. The link is good for 15
// minutes and dies on first use.
router.post("/impersonate", requireAuth, requireRole("owner", "admin", "office"), async (req, res) => {
  try {
    const companyId = req.auth!.companyId as number;
    const clientId = req.body?.client_id ? parseInt(String(req.body.client_id)) : null;
    const contactId = req.body?.account_contact_id ? parseInt(String(req.body.account_contact_id)) : null;
    if ((clientId == null) === (contactId == null)) {
      return res.status(400).json({ error: "Bad Request", message: "Pass exactly one of client_id or account_contact_id" });
    }

    // Find the customer's EXISTING login. View-as deliberately does not create
    // one — otherwise staff could conjure a portal identity for a customer who
    // was never invited, and the audit trail would start with a fiction.
    const [user] = await db
      .select()
      .from(portalUsersTable)
      .where(and(
        eq(portalUsersTable.company_id, companyId),
        clientId != null
          ? eq(portalUsersTable.client_id, clientId)
          : eq(portalUsersTable.account_contact_id, contactId!),
      ))
      .limit(1);
    if (!user) {
      return res.status(404).json({ error: "Not Found", message: "This customer has no portal login yet — invite them first" });
    }
    if (!user.is_active) {
      return res.status(400).json({ error: "Bad Request", message: "This portal login is inactive" });
    }

    const raw = await mintPortalToken({
      companyId, portalUserId: user.id, kind: "impersonation", issuedByUserId: req.auth!.userId,
    });
    const co = await db.execute(sql`SELECT slug FROM companies WHERE id = ${companyId} LIMIT 1`);
    const slug = (co.rows[0] as any)?.slug;
    const url = `${appBaseUrl()}/portal/${slug ?? ""}/enter?token=${raw}`;

    logAudit(req, "PORTAL_VIEW_AS", "portal_user", user.id, null, {
      client_id: clientId, account_contact_id: contactId, customer_email: user.email,
    });

    return res.json({ ok: true, url, expires_in_minutes: 15, customer: { name: user.name, email: user.email } });
  } catch (err) {
    console.error("Portal impersonate error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not open that customer's view" });
  }
});

// POST /api/portal/auth/enter  { token }
// Public: the office opens the one-time link, this redeems it into a read-only
// portal session. Single-use and short-lived, so a link left in a browser
// history or pasted into chat is dead by the time anyone finds it.
router.post("/enter", async (req, res) => {
  try {
    const redeemed = await redeemPortalToken(req.body?.token, "impersonation");
    if (!redeemed) {
      return res.status(400).json({ error: "Bad Request", message: "That link has expired or was already used" });
    }
    const [user] = await db.select().from(portalUsersTable)
      .where(eq(portalUsersTable.id, redeemed.portalUserId)).limit(1);
    if (!user || !user.is_active) {
      return res.status(404).json({ error: "Not Found", message: "That login is no longer active" });
    }
    // impersonatedBy carries the STAFF user id into the session. Everything
    // downstream — the read-only capability set and the portal's banner — keys
    // off it, so it must come from the token, never from the request.
    const session = sessionFromUser(user, redeemed.issuedByUserId);
    return res.json({
      token: signPortalToken(session),
      capabilities: portalCapabilities(session),
      user: { name: user.name, email: user.email },
      impersonated: true,
    });
  } catch (err) {
    console.error("Portal enter error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Could not open that session" });
  }
});

// ── Session probe ───────────────────────────────────────────────────────────
// GET /api/portal/auth/session — who am I, and what may I do?
// ── Sign in with Google ─────────────────────────────────────────────────────
// GET /api/portal/auth/google/config — tells the sign-in page whether to render
// the button. Public: a client id is public by design, and this endpoint is
// reached before anyone is authenticated.
router.get("/google/config", (_req, res) => {
  return res.json({ enabled: googlePortalEnabled(), client_id: googlePortalClientId() });
});

// POST /api/portal/auth/google  { credential, company_slug }
//
// Google is a way to SIGN IN, never a way to sign up. The customer must already
// have a portal login created by the office invite — same rule as the password
// path, and for the same reason: an open door here would let anyone with a
// Google account mint a customer login and start probing what it can reach.
// Failing to find a login is reported exactly like a wrong password.
router.post("/google", async (req, res) => {
  try {
    if (!googlePortalEnabled()) {
      return res.status(503).json({ error: "Unavailable", message: "Google sign-in is not set up" });
    }
    const slug = String(req.body?.company_slug ?? "").trim();
    if (!slug) return res.status(400).json({ error: "Bad Request", message: "Company is required" });

    const identity = await verifyGoogleIdToken(req.body?.credential);
    if (!identity) return res.status(401).json({ error: "Unauthorized", message: GENERIC_LOGIN_FAIL });

    const co = await db.execute(sql`SELECT id FROM companies WHERE slug = ${slug} LIMIT 1`);
    const companyId = (co.rows[0] as any)?.id as number | undefined;
    if (!companyId) return res.status(401).json({ error: "Unauthorized", message: GENERIC_LOGIN_FAIL });

    // 1. A previously linked identity wins outright — the subject is stable
    //    even if the customer later changes their email at Google.
    const linked = await db
      .select({ portal_user_id: portalIdentitiesTable.portal_user_id })
      .from(portalIdentitiesTable)
      .where(and(
        eq(portalIdentitiesTable.company_id, companyId),
        eq(portalIdentitiesTable.provider, "google"),
        eq(portalIdentitiesTable.subject, identity.subject),
      ))
      .limit(1);

    let user: any = null;
    if (linked[0]) {
      const [u] = await db.select().from(portalUsersTable)
        .where(eq(portalUsersTable.id, linked[0].portal_user_id)).limit(1);
      user = u ?? null;
    } else {
      // 2. First time: match an INVITED login by email and link it. Only on a
      //    Google-VERIFIED address — an unverified one would let someone claim
      //    a customer's account by signing up to Google with their address.
      if (!identity.emailVerified || !identity.email) {
        return res.status(401).json({ error: "Unauthorized", message: GENERIC_LOGIN_FAIL });
      }
      const found = await findPortalUserByEmail(companyId, identity.email);
      // No invite = no account. Google does not create one.
      if (!found) return res.status(401).json({ error: "Unauthorized", message: GENERIC_LOGIN_FAIL });
      user = found;
      await db.insert(portalIdentitiesTable).values({
        company_id: companyId,
        portal_user_id: found.id,
        provider: "google",
        subject: identity.subject,
      });
    }

    if (!user || !user.is_active) {
      return res.status(401).json({ error: "Unauthorized", message: GENERIC_LOGIN_FAIL });
    }

    // Signing in with Google proves the address, so the login counts as
    // verified even if they never followed the emailed invite link.
    await db.update(portalUsersTable)
      .set({ last_login_at: new Date(), email_verified_at: user.email_verified_at ?? new Date() })
      .where(eq(portalUsersTable.id, user.id));

    const session = sessionFromUser(user);
    return res.json({
      token: signPortalToken(session),
      capabilities: portalCapabilities(session),
      user: { name: user.name, email: user.email },
    });
  } catch (err) {
    console.error("Portal Google sign-in error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: "Sign-in failed" });
  }
});

router.get("/session", requirePortalAuth, async (req, res) => {
  const session = req.portalSession!;
  return res.json({
    email: session.email,
    capabilities: portalCapabilities(session),
    // Drives the portal's "you are viewing as a customer" banner + exit control.
    impersonated: session.impersonatedBy != null,
  });
});

export default router;
