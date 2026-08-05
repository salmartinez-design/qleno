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
import { portalUsersTable } from "@workspace/db/schema";
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

    return res.json({ ok: true, token: signPortalToken(sessionFromUser(user)) });
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

// ── Session probe ───────────────────────────────────────────────────────────
// GET /api/portal/auth/session — who am I, and what may I do?
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
