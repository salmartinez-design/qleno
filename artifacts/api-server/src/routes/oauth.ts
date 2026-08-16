import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth.js";
import { logAudit } from "../lib/audit.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  registerClient, findClient, redirectUriMatches, isLoopbackOnlyClient,
  issueAuthorizationCode, exchangeAuthorizationCode, refreshGrant,
  revokeByToken, revokeGrantForCompany, listGrants,
  filterGrantableScopes, OAUTH_GRANTABLE_SCOPES,
} from "../lib/oauth.js";
import { canMintApiKeys } from "../lib/api-keys.js";

// [ai-access-oauth 2026-08-16] OAuth 2.1 authorization server for Qleno Agent.
// Design: docs/AI_ACCESS_OAUTH_DESIGN.md §6.
//
// Two routers, mounted in different places for a reason:
//   publicOAuthRouter — at the ORIGIN ROOT (/.well-known, /oauth). These must
//     NOT sit under /api: RFC 9728 and RFC 8414 both place discovery documents
//     at the root of the origin, and a client that cannot find them there
//     concludes the server does not do OAuth and offers the tenant nothing.
//   oauthAdminRouter — under /api, behind a login session. This is the tenant's
//     own management surface for grants they have approved.

// ── Public origin ────────────────────────────────────────────────────────────
// Derived from the REQUEST, not from APP_BASE_URL. The `resource` field must
// match the URL the tenant actually typed into their connector dialog, byte for
// byte — a mismatch is rejected outright by the client, and the symptom is a
// connector that fails at "Connect" with no useful error. Deriving from the
// request is also what lets a PR preview environment work without config.
function publicOrigin(req: Request): string {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "app.qleno.com").split(",")[0].trim();
  return `${proto}://${host}`;
}

// ── Registration rate limit ──────────────────────────────────────────────────
// DCR is unauthenticated by specification, so the only thing standing between
// this endpoint and an unbounded table is a limiter. In-memory and per-IP: this
// is abuse control, not a security boundary (the security boundary is that a
// registration grants nothing until a human approves it), so it does not need
// to survive a restart or coordinate across instances.
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX_PER_IP = 20;
const registerHits = new Map<string, { count: number; resetAt: number }>();

function registrationAllowed(ip: string): boolean {
  const now = Date.now();
  const hit = registerHits.get(ip);
  if (!hit || hit.resetAt <= now) {
    registerHits.set(ip, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
    return true;
  }
  if (hit.count >= REGISTER_MAX_PER_IP) return false;
  hit.count += 1;
  return true;
}

// Bound the map so a spray of unique IPs cannot grow it without limit.
setInterval(() => {
  const now = Date.now();
  for (const [ip, hit] of registerHits) if (hit.resetAt <= now) registerHits.delete(ip);
}, REGISTER_WINDOW_MS).unref?.();

// ═══════════════════════════════════════════════════════════════════════════
// Public router — mounted at the origin root
// ═══════════════════════════════════════════════════════════════════════════

export const publicOAuthRouter = Router();

/**
 * Protected resource metadata (RFC 9728).
 *
 * Served at BOTH the bare path and the path-suffixed variant, because clients
 * disagree about which to probe: the suffixed form is derived from the resource
 * URL's path (/api/mcp → /.well-known/oauth-protected-resource/api/mcp) and is
 * what Claude tries first, while others use the bare path. Answering both is
 * two lines; answering one is a connector that fails for half the tenants.
 */
function protectedResourceMetadata(req: Request, res: Response) {
  const origin = publicOrigin(req);
  res.set("Cache-Control", "public, max-age=3600");
  res.json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: OAUTH_GRANTABLE_SCOPES,
    bearer_methods_supported: ["header"],
    // A tenant only ever sees this URL because something went wrong, so it has
    // to land on the AI & API Access tab itself. /settings/ai-access was not a
    // route — it fell through to the SPA catch-all and rendered the dashboard,
    // which reads as the link being broken rather than as help.
    resource_documentation: `${origin}/company?tab=ai-access`,
  });
}

publicOAuthRouter.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
publicOAuthRouter.get("/.well-known/oauth-protected-resource/api/mcp", protectedResourceMetadata);
publicOAuthRouter.get("/.well-known/oauth-protected-resource/api/v1", protectedResourceMetadata);

/** Authorization server metadata (RFC 8414). */
function authorizationServerMetadata(req: Request, res: Response) {
  const origin = publicOrigin(req);
  res.set("Cache-Control", "public, max-age=3600");
  res.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: OAUTH_GRANTABLE_SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 only. `plain` is advertised by nobody here because it offers an
    // interceptor no obstacle at all — see pkceMatches() in lib/oauth.ts.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${origin}/company?tab=ai-access`,
  });
}

publicOAuthRouter.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
// OpenID-style path, probed by some clients before the RFC 8414 one.
publicOAuthRouter.get("/.well-known/openid-configuration", authorizationServerMetadata);

/** Dynamic Client Registration (RFC 7591). Body is application/json per §3.1. */
publicOAuthRouter.post("/oauth/register", async (req: Request, res: Response) => {
  const ip = req.ip ?? "unknown";
  if (!registrationAllowed(ip)) {
    res.status(429).json({ error: "temporarily_unavailable", error_description: "Too many registrations. Try again later." });
    return;
  }

  const body = req.body ?? {};
  const uris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (uris.length === 0) {
    res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required" });
    return;
  }

  try {
    const client = await registerClient({
      client_name: body.client_name,
      client_uri: body.client_uri,
      redirect_uris: uris,
      ip,
    });
    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Public client: there is no secret to issue. Every target client here
      // (Claude, ChatGPT, Gemini, Grok) runs where a secret cannot be kept, so
      // PKCE protects the exchange instead of a shared secret that would be a
      // liability the moment it shipped.
      token_endpoint_auth_method: "none",
    });
  } catch (err: any) {
    if (err?.oauthError) {
      res.status(400).json({ error: err.oauthError, error_description: err.message });
      return;
    }
    console.error("[oauth] register failed", err);
    res.status(500).json({ error: "server_error", error_description: "Registration failed" });
  }
});

/**
 * Authorization endpoint.
 *
 * This validates and then hands off to the SPA consent screen. Two failure
 * modes are handled differently on purpose:
 *   - a BAD client_id or redirect_uri renders an error PAGE and redirects
 *     nowhere. Redirecting to an unverified URI would make this endpoint an
 *     open redirect, which is precisely how authorization codes get stolen.
 *   - a valid client asking for something wrong (missing PKCE, wrong response
 *     type) is redirected back with an OAuth error, because at that point the
 *     destination is known-good and the client can show the user a real message.
 */
publicOAuthRouter.get("/oauth/authorize", async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  const clientId = q.client_id ?? "";
  const redirectUri = q.redirect_uri ?? "";

  if (!clientId || !redirectUri) {
    res.status(400).type("html").send(errorPage("Missing client_id or redirect_uri."));
    return;
  }

  const client = await findClient(clientId);
  if (!client) {
    res.status(400).type("html").send(errorPage("This application is not registered with Qleno."));
    return;
  }
  if (!redirectUriMatches(client.redirect_uris, redirectUri)) {
    res.status(400).type("html").send(errorPage("This application's redirect address does not match the one it registered."));
    return;
  }

  // From here the redirect target is trusted, so errors go back to the client.
  const bounce = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (q.state) u.searchParams.set("state", q.state);
    res.redirect(302, u.toString());
  };

  if (q.response_type !== "code") return bounce("unsupported_response_type", "Only the authorization code flow is supported.");
  if (!q.code_challenge) return bounce("invalid_request", "PKCE is required: send code_challenge.");
  if ((q.code_challenge_method ?? "") !== "S256") return bounce("invalid_request", "code_challenge_method must be S256.");

  // Hand off to the consent screen, carrying the parameters forward. The SPA
  // route falls through to index.html because nothing above it claims /oauth/consent.
  const consent = new URL(`${publicOrigin(req)}/oauth/consent`);
  for (const k of ["client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"]) {
    if (q[k]) consent.searchParams.set(k, String(q[k]));
  }
  res.redirect(302, consent.toString());
});

/**
 * Token endpoint.
 *
 * Reads application/x-www-form-urlencoded per RFC 6749 §4.1.3 — NOT JSON. A
 * JSON-only token endpoint answers 415 to every conforming client and the flow
 * dies at the last step, after the tenant has already signed in and approved,
 * which is the most confusing place for it to fail.
 */
publicOAuthRouter.post("/oauth/token", async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  const b = (req.body ?? {}) as Record<string, string | undefined>;
  const grantType = b.grant_type;

  if (grantType === "authorization_code") {
    if (!b.code || !b.client_id || !b.redirect_uri || !b.code_verifier) {
      res.status(400).json({ error: "invalid_request", error_description: "code, client_id, redirect_uri and code_verifier are required" });
      return;
    }
    const result = await exchangeAuthorizationCode({
      code: b.code, clientId: b.client_id, redirectUri: b.redirect_uri,
      codeVerifier: b.code_verifier, ip: req.ip,
    });
    if (!result.ok) {
      // One caller-facing message for every failure. Telling an attacker
      // whether the code was expired, replayed, or simply wrong is free help.
      if (result.reason === "code_reused") console.warn("[oauth] authorization code replayed — grant revoked");
      res.status(400).json({ error: "invalid_grant", error_description: "The authorization code is not valid." });
      return;
    }
    const t = result.tokens;
    res.json({
      access_token: t.access_token,
      token_type: "Bearer",
      expires_in: t.expires_in,
      refresh_token: t.refresh_token,
      scope: t.scope,
    });
    return;
  }

  if (grantType === "refresh_token") {
    if (!b.refresh_token || !b.client_id) {
      res.status(400).json({ error: "invalid_request", error_description: "refresh_token and client_id are required" });
      return;
    }
    const result = await refreshGrant({ refreshToken: b.refresh_token, clientId: b.client_id, ip: req.ip });
    if (!result.ok) {
      res.status(400).json({ error: "invalid_grant", error_description: "The refresh token is not valid." });
      return;
    }
    const t = result.tokens;
    res.json({
      access_token: t.access_token,
      token_type: "Bearer",
      expires_in: t.expires_in,
      refresh_token: t.refresh_token,
      scope: t.scope,
    });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type", error_description: "Supported: authorization_code, refresh_token" });
});

/**
 * Revocation (RFC 7009).
 *
 * Always 200, even for a token that does not exist — §2.2 requires it, and the
 * reason is sound: a different answer for a valid versus invalid token turns
 * this into an oracle for testing stolen tokens.
 */
publicOAuthRouter.post("/oauth/revoke", async (req: Request, res: Response) => {
  const token = (req.body ?? {}).token;
  if (token) {
    try { await revokeByToken(String(token)); }
    catch (err) { console.error("[oauth] revoke failed", err); }
  }
  res.status(200).json({});
});

/** Minimal branded error page for the cases where redirecting would be unsafe. */
function errorPage(message: string): string {
  const safe = String(message).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Qleno</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#F7F6F3;font-family:'Plus Jakarta Sans',system-ui,sans-serif;color:#1A1917;padding:24px}
  .card{background:#FFF;border:1px solid #E5E2DC;border-radius:12px;padding:28px;max-width:420px}
  h1{margin:0 0 10px;font-size:18px;font-weight:700}
  p{margin:0;font-size:14px;line-height:1.55;color:#6B6862}
</style></head><body><div class="card">
<h1>Could not connect</h1><p>${safe}</p></div></body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tenant-facing router — mounted under /api, login session required
// ═══════════════════════════════════════════════════════════════════════════

export const oauthAdminRouter = Router();
oauthAdminRouter.use(requireAuth);

/**
 * Who may approve a connection?
 *
 * Owner, admin, and office — deliberately WIDER than canMintApiKeys(), which is
 * owner/admin only. Minting a key creates a standalone credential that outlives
 * any session; approving a grant hands a connector the reader's OWN view and
 * nothing more, revocable in one click and dead the moment the user is
 * deactivated. Refusing office here would mean Maribel and Francisco cannot use
 * this feature at all, which is the opposite of why it was built.
 *
 * Technicians and trainees are excluded here AND re-checked live on every
 * request in verifyAccessToken(), so neither layer is load-bearing alone.
 */
const CONSENT_ROLES = ["owner", "admin", "super_admin", "office"];
function canApproveGrant(role: string | null | undefined): boolean {
  return !!role && CONSENT_ROLES.includes(role);
}

/**
 * A session's company, or null after answering the request.
 *
 * req.auth.companyId is nullable: a super-admin session belongs to the platform
 * rather than to any one tenant. Every grant is scoped to exactly one company,
 * so there is no correct company to attach a connector to from such a session —
 * and guessing one would hand a connector to a tenant nobody chose. Callers
 * return immediately when this is null.
 */
function companyOf(req: Request, res: Response): number | null {
  const companyId = req.auth?.companyId ?? null;
  if (companyId == null) {
    res.status(403).json({
      error: "forbidden",
      message: "Sign in to the company you want to connect before approving.",
    });
    return null;
  }
  return companyId;
}

/**
 * What the consent screen needs to render.
 *
 * Returns the plan gate result too, so a tenant who is not switched on is told
 * WHY rather than being shown an Approve button that produces a connector which
 * silently returns nothing.
 */
oauthAdminRouter.get("/consent-details", async (req: Request, res: Response) => {
  const clientId = String(req.query.client_id ?? "");
  const redirectUri = String(req.query.redirect_uri ?? "");
  const client = clientId ? await findClient(clientId) : null;

  if (!client || !redirectUriMatches(client.redirect_uris, redirectUri)) {
    res.status(400).json({ error: "invalid_client", message: "This application is not registered with Qleno." });
    return;
  }

  const companyId = companyOf(req, res);
  if (companyId == null) return;
  const rows: any = await db.execute(sql`
    SELECT api_access_enabled, plan FROM companies WHERE id = ${companyId} LIMIT 1
  `);
  const co = (rows.rows ?? rows)[0];

  let host = redirectUri;
  try { host = new URL(redirectUri).host; } catch { /* shown raw if unparseable */ }

  res.json({
    client_name: client.client_name,
    client_uri: client.client_uri,
    redirect_host: host,
    // Any process on the machine can listen on a loopback port, so the URI
    // alone cannot tell the tenant a real Claude Code from an impersonator.
    loopback_only: isLoopbackOnlyClient(client.redirect_uris),
    scopes: filterGrantableScopes(String(req.query.scope ?? "").split(/[\s,]+/).filter(Boolean)),
    user: {
      name: [req.auth!.first_name, ""].filter(Boolean).join(" ").trim() || req.auth!.email,
      email: req.auth!.email,
      role: req.auth!.role,
    },
    can_approve: canApproveGrant(req.auth!.role),
    company_enabled: !!co?.api_access_enabled,
    plan: co?.plan ?? null,
  });
});

/** Approve. Issues the authorization code and returns where to send the browser. */
oauthAdminRouter.post("/approve", async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const clientId = String(b.client_id ?? "");
  const redirectUri = String(b.redirect_uri ?? "");
  const codeChallenge = String(b.code_challenge ?? "");

  const client = clientId ? await findClient(clientId) : null;
  if (!client || !redirectUriMatches(client.redirect_uris, redirectUri)) {
    res.status(400).json({ error: "invalid_client", message: "This application is not registered with Qleno." });
    return;
  }
  if (!codeChallenge) {
    res.status(400).json({ error: "invalid_request", message: "Missing PKCE challenge." });
    return;
  }
  if (!canApproveGrant(req.auth!.role)) {
    res.status(403).json({ error: "forbidden", message: "Your role cannot approve an AI connection." });
    return;
  }

  const companyId = companyOf(req, res);
  if (companyId == null) return;
  const rows: any = await db.execute(sql`
    SELECT api_access_enabled FROM companies WHERE id = ${companyId} LIMIT 1
  `);
  if (!(rows.rows ?? rows)[0]?.api_access_enabled) {
    res.status(403).json({ error: "forbidden", message: "AI & API access is not enabled for this company." });
    return;
  }

  const scopes = filterGrantableScopes(
    Array.isArray(b.scopes) ? b.scopes : String(b.scope ?? "").split(/[\s,]+/).filter(Boolean)
  );

  const code = await issueAuthorizationCode({
    clientId, companyId, userId: req.auth!.userId, scopes,
    redirectUri, codeChallenge, resource: b.resource ? String(b.resource) : null,
  });

  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (b.state) target.searchParams.set("state", String(b.state));

  await logAudit(req, "oauth_grant_approved", "oauth_client", clientId, null, {
    client_name: client.client_name, scopes, redirect_host: target.host,
  }).catch(() => { /* audit must never block the flow */ });

  res.json({ redirect_to: target.toString() });
});

/** Deny. Bounces back with the OAuth error the client expects. */
oauthAdminRouter.post("/deny", async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const client = b.client_id ? await findClient(String(b.client_id)) : null;
  const redirectUri = String(b.redirect_uri ?? "");
  if (!client || !redirectUriMatches(client.redirect_uris, redirectUri)) {
    res.json({ redirect_to: null });
    return;
  }
  const u = new URL(redirectUri);
  u.searchParams.set("error", "access_denied");
  u.searchParams.set("error_description", "The user declined the connection.");
  if (b.state) u.searchParams.set("state", String(b.state));
  res.json({ redirect_to: u.toString() });
});

/** Everything currently connected, for Settings → AI & API Access. */
oauthAdminRouter.get("/grants", async (req: Request, res: Response) => {
  const companyId = companyOf(req, res);
  if (companyId == null) return;
  res.json({ grants: await listGrants(companyId) });
});

/**
 * Revoke a connection.
 *
 * Owner/admin only — same bar as revoking an API key. Approving a connection
 * affects only the approver's own reach, but revoking one cuts off a tool
 * someone else may be relying on, so it belongs with the people who own the
 * account rather than with everyone who can approve.
 */
oauthAdminRouter.delete("/grants/:id", async (req: Request, res: Response) => {
  if (!canMintApiKeys(req.auth!.role)) {
    res.status(403).json({ error: "Forbidden", message: "Only an owner or admin can revoke a connection" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Bad id" }); return; }

  const companyId = companyOf(req, res);
  if (companyId == null) return;

  const done = await revokeGrantForCompany(companyId, id);
  if (!done) { res.status(404).json({ error: "Not found" }); return; }

  await logAudit(req, "oauth_grant_revoked", "oauth_grant", id, null, null)
    .catch(() => { /* audit must never block the revoke */ });

  res.json({ ok: true });
});
