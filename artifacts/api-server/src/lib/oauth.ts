import crypto from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { READ_SCOPES, isValidScope, type ApiScope } from "./api-keys.js";

// [ai-access-oauth 2026-08-16] The authorization server behind Qleno Agent.
// Design + rationale: docs/AI_ACCESS_OAUTH_DESIGN.md.
//
// WHY THIS EXISTS AT ALL:
//   Phases 1–4 shipped a bearer API key. Claude's connector dialog and
//   ChatGPT's both refuse a pasted key outright — they speak OAuth 2.1 with
//   Dynamic Client Registration and nothing else. Gemini and Grok accept a key
//   only from an advanced panel. And a PHONE has no config file, no local
//   bridge process, and reads the same connector list as claude.ai, so for
//   mobile there is no workaround at any price. This file is what makes the
//   feature reachable from the surface tenants actually use.
//
// This file is the ONLY place that knows the token format or touches a token
// hash. Everything else goes through verifyAccessToken().

// ── Token format ─────────────────────────────────────────────────────────────
// Deliberately NOT JWTs. A JWT is self-validating and saves a database hit, and
// is also unrevocable until it expires. The core safety property here is that
// revocation is IMMEDIATE: revoke a grant, deactivate the user, or flip the
// company switch, and the very next call fails. With a 1-hour JWT a compromised
// connector keeps reading customer data for up to an hour after the tenant
// clicks Revoke. One indexed lookup is a cheap price for that.
//
// The qlno_ family prefix is kept so secret-scanning tools still pattern-match
// a leaked token; the middle segment is what separates the credential types.
const ACCESS_PREFIX = "qlno_oat_";
const REFRESH_PREFIX = "qlno_ort_";
const CLIENT_ID_PREFIX = "qlnc_";

const TOKEN_BYTES = 32; // 256 bits — see hashToken()

/** Access-token life. Short, because refresh rotation makes it cheap to redo. */
const ACCESS_TTL_MS = 60 * 60 * 1000;            // 1 hour
/** Refresh life. Long enough that a tenant is not re-consenting every week. */
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
/** Authorization-code life. Seconds, per OAuth 2.1 — it is exchanged instantly. */
const CODE_TTL_MS = 60 * 1000;

// SHA-256, deliberately not bcrypt — identical reasoning to api-keys.ts: a work
// factor defends LOW-entropy human passwords, and these are 256 CSPRNG bits.
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function randomToken(prefix: string): string {
  return prefix + crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

// ── Scopes an OAuth grant may carry ──────────────────────────────────────────
// READ ONLY in this phase, and this is the mitigation rather than a limitation
// we ran out of time for.
//
// A grant lands in a CHAT WINDOW, where text from a customer note reaches a
// tool call by the shortest path in the system and the human sees a summary
// instead of the request. Phase 5 is where the injection defenses get built —
// confirmation gates, destructive-action framing, an injection-resistant tool
// contract. Putting write scopes on the least-defended surface before those
// exist would invert the whole safety argument. Write joins this list when
// Phase 5 ships, behind its confirm contract.
export const OAUTH_GRANTABLE_SCOPES: ApiScope[] = [...READ_SCOPES];

/** Drop anything a grant may not carry. Silently — the consent screen shows what was actually granted. */
export function filterGrantableScopes(requested: string[]): ApiScope[] {
  const ok = requested.filter(isValidScope).filter((s) => OAUTH_GRANTABLE_SCOPES.includes(s));
  // An empty scope request means "whatever you'll give me", which for a
  // read-only grant is the full read set. Returning nothing would hand back a
  // token that authenticates and can read nothing, which reads to the tenant as
  // a broken connector.
  return ok.length > 0 ? Array.from(new Set(ok)) : [...OAUTH_GRANTABLE_SCOPES];
}

// ── Redirect URI matching ────────────────────────────────────────────────────
// Exact string comparison, with the one exception RFC 8252 §7.3 requires: a
// loopback redirect matches ignoring the PORT, because a native client picks an
// ephemeral port at runtime and cannot register it in advance.
//
// No prefix matching and no wildcards anywhere. A sloppy match here is an open
// redirect, and an open redirect on an authorization endpoint leaks the
// authorization code to whoever crafted the URL.
export function redirectUriMatches(registered: string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true;

  let cand: URL;
  try { cand = new URL(candidate); } catch { return false; }
  if (!isLoopback(cand)) return false;

  return registered.some((r) => {
    let reg: URL;
    try { reg = new URL(r); } catch { return false; }
    return (
      isLoopback(reg) &&
      reg.protocol === cand.protocol &&
      reg.hostname === cand.hostname &&
      reg.pathname === cand.pathname
    );
  });
}

function isLoopback(u: URL): boolean {
  return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1";
}

/**
 * Is every registered redirect a loopback address?
 *
 * Shown at consent as an extra warning, because any process on the machine can
 * listen on a loopback port — the tenant cannot tell a real Claude Code from
 * something impersonating it by the URI alone.
 */
export function isLoopbackOnlyClient(redirectUris: string[]): boolean {
  if (redirectUris.length === 0) return false;
  return redirectUris.every((r) => { try { return isLoopback(new URL(r)); } catch { return false; } });
}

// ── Dynamic Client Registration (RFC 7591) ───────────────────────────────────

export interface RegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

/**
 * Register a client. Unauthenticated by specification — see the table comment
 * in oauth-migrate.ts for why that is safe: a registration grants nothing at
 * all until a human signs in and approves it.
 *
 * Public clients only. Every target here (Claude, ChatGPT, Gemini, Grok) is a
 * public client under OAuth 2.1, so there is no secret to hand out and no place
 * one could be kept. PKCE is what protects the exchange instead.
 */
export async function registerClient(input: {
  client_name?: string;
  client_uri?: string;
  redirect_uris: string[];
  ip?: string;
}): Promise<RegisteredClient> {
  const uris = input.redirect_uris
    .map((u) => String(u).trim())
    .filter(Boolean)
    .filter(isAcceptableRedirect);

  if (uris.length === 0) {
    throw Object.assign(new Error("redirect_uris must contain at least one https or loopback URI"), {
      oauthError: "invalid_redirect_uri",
    });
  }

  const client_id = CLIENT_ID_PREFIX + crypto.randomBytes(16).toString("base64url");
  const client_name = (input.client_name || "Unnamed client").slice(0, 120);

  await db.execute(sql`
    INSERT INTO oauth_clients (client_id, client_name, client_uri, redirect_uris, registered_via, registered_ip)
    VALUES (${client_id}, ${client_name}, ${input.client_uri ?? null},
            ${sql.raw(pgTextArray(uris))}, 'dcr', ${input.ip ?? null})
  `);

  return { client_id, client_name, redirect_uris: uris };
}

/**
 * https only, or a loopback address for native clients.
 *
 * A plain-http non-loopback redirect would carry the authorization code over
 * the wire in clear text; a custom scheme (myapp://) cannot be verified as
 * belonging to anyone, so any app on the device can claim it.
 */
function isAcceptableRedirect(u: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && isLoopback(url)) return true;
  return false;
}

/** Postgres text[] literal. Values are URLs already validated by isAcceptableRedirect. */
function pgTextArray(values: string[]): string {
  const inner = values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",");
  return `'{${inner}}'::text[]`;
}

export interface OAuthClientRow {
  client_id: string;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string[];
}

export async function findClient(clientId: string): Promise<OAuthClientRow | null> {
  const rows: any = await db.execute(sql`
    SELECT client_id, client_name, client_uri, redirect_uris
      FROM oauth_clients WHERE client_id = ${clientId} LIMIT 1
  `);
  const r = (rows.rows ?? rows)[0];
  if (!r) return null;
  return {
    client_id: r.client_id,
    client_name: r.client_name,
    client_uri: r.client_uri ?? null,
    redirect_uris: r.redirect_uris ?? [],
  };
}

// ── Authorization code ───────────────────────────────────────────────────────

/**
 * Issue a code for a user who has just approved at the consent screen.
 *
 * The code is returned once and stored only as a hash. code_challenge is
 * recorded so the exchange can prove the caller is the same party that started
 * the flow — without PKCE, anyone who intercepts the redirect can trade the
 * code for a token.
 */
export async function issueAuthorizationCode(input: {
  clientId: string;
  companyId: number;
  userId: number;
  scopes: ApiScope[];
  redirectUri: string;
  codeChallenge: string;
  resource?: string | null;
}): Promise<string> {
  const code = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + CODE_TTL_MS);

  await db.execute(sql`
    INSERT INTO oauth_authorization_codes
      (code_hash, client_id, company_id, user_id, scopes, redirect_uri, code_challenge, resource, expires_at)
    VALUES (${hashToken(code)}, ${input.clientId}, ${input.companyId}, ${input.userId},
            ${sql.raw(pgTextArray(input.scopes))}, ${input.redirectUri}, ${input.codeChallenge},
            ${input.resource ?? null}, ${expires})
  `);

  return code;
}

/** S256 only. `plain` is not accepted — it offers no protection against an interceptor. */
function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(challenge, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  grantId: number;
}

export type ExchangeFailure =
  | "invalid_code"
  | "code_expired"
  | "code_reused"
  | "redirect_mismatch"
  | "pkce_failed"
  | "client_mismatch";

/**
 * Trade an authorization code for tokens.
 *
 * A REUSED code revokes the grant it originally produced rather than merely
 * failing. Reuse means the code leaked, and whoever it leaked to may already be
 * holding a live token — refusing the second exchange while leaving the first
 * one's token working would defend nothing.
 */
export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  ip?: string;
}): Promise<{ ok: true; tokens: IssuedTokens } | { ok: false; reason: ExchangeFailure }> {
  const codeHash = hashToken(input.code);

  const rows: any = await db.execute(sql`
    SELECT code_hash, client_id, company_id, user_id, scopes, redirect_uri,
           code_challenge, expires_at, consumed_at, issued_grant_id
      FROM oauth_authorization_codes WHERE code_hash = ${codeHash} LIMIT 1
  `);
  const row = (rows.rows ?? rows)[0];
  if (!row) return { ok: false, reason: "invalid_code" };

  if (row.consumed_at) {
    if (row.issued_grant_id) {
      await revokeGrantById(Number(row.issued_grant_id), "authorization_code_replayed");
    }
    return { ok: false, reason: "code_reused" };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: "code_expired" };
  if (row.client_id !== input.clientId) return { ok: false, reason: "client_mismatch" };
  if (row.redirect_uri !== input.redirectUri) return { ok: false, reason: "redirect_mismatch" };
  if (!input.codeVerifier || !pkceMatches(input.codeVerifier, row.code_challenge)) {
    return { ok: false, reason: "pkce_failed" };
  }

  const client = await findClient(input.clientId);
  const scopes = (row.scopes ?? []).filter(isValidScope) as ApiScope[];

  const tokens = await createGrant({
    companyId: Number(row.company_id),
    userId: Number(row.user_id),
    clientId: input.clientId,
    clientName: client?.client_name ?? "Unknown client",
    scopes,
    ip: input.ip,
  });

  // Mark consumed AFTER the grant exists, and record which grant it produced so
  // a later replay knows what to revoke.
  await db.execute(sql`
    UPDATE oauth_authorization_codes
       SET consumed_at = now(), issued_grant_id = ${tokens.grantId}
     WHERE code_hash = ${codeHash}
  `);

  return { ok: true, tokens };
}

async function createGrant(input: {
  companyId: number;
  userId: number;
  clientId: string;
  clientName: string;
  scopes: ApiScope[];
  ip?: string;
}): Promise<IssuedTokens> {
  const access = randomToken(ACCESS_PREFIX);
  const refresh = randomToken(REFRESH_PREFIX);
  const accessExpires = new Date(Date.now() + ACCESS_TTL_MS);
  const refreshExpires = new Date(Date.now() + REFRESH_TTL_MS);

  const rows: any = await db.execute(sql`
    INSERT INTO oauth_grants
      (company_id, user_id, client_id, client_name, scopes,
       access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at, last_used_ip)
    VALUES (${input.companyId}, ${input.userId}, ${input.clientId}, ${input.clientName},
            ${sql.raw(pgTextArray(input.scopes))},
            ${hashToken(access)}, ${accessExpires}, ${hashToken(refresh)}, ${refreshExpires}, ${input.ip ?? null})
    RETURNING id
  `);
  const grantId = Number((rows.rows ?? rows)[0].id);

  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    scope: input.scopes.join(" "),
    grantId,
  };
}

/**
 * Rotate a refresh token.
 *
 * ROTATION IS MANDATORY, not a nicety: OAuth 2.1 requires public clients to
 * either rotate refresh tokens or sender-constrain them, and every client here
 * is public. The old refresh token is invalidated in the same statement that
 * issues the new one, so a stolen refresh token is usable at most once and the
 * legitimate client's next refresh fails loudly instead of silently sharing
 * access with an attacker.
 */
export async function refreshGrant(input: {
  refreshToken: string;
  clientId: string;
  ip?: string;
}): Promise<{ ok: true; tokens: IssuedTokens } | { ok: false; reason: "invalid_grant" }> {
  const rows: any = await db.execute(sql`
    SELECT id, company_id, user_id, client_id, client_name, scopes, refresh_expires_at, revoked_at
      FROM oauth_grants WHERE refresh_token_hash = ${hashToken(input.refreshToken)} LIMIT 1
  `);
  const row = (rows.rows ?? rows)[0];
  if (!row) return { ok: false, reason: "invalid_grant" };
  if (row.revoked_at) return { ok: false, reason: "invalid_grant" };
  if (row.client_id !== input.clientId) return { ok: false, reason: "invalid_grant" };
  if (row.refresh_expires_at && new Date(row.refresh_expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "invalid_grant" };
  }

  const access = randomToken(ACCESS_PREFIX);
  const refresh = randomToken(REFRESH_PREFIX);
  const accessExpires = new Date(Date.now() + ACCESS_TTL_MS);
  const refreshExpires = new Date(Date.now() + REFRESH_TTL_MS);

  await db.execute(sql`
    UPDATE oauth_grants
       SET access_token_hash  = ${hashToken(access)},
           access_expires_at  = ${accessExpires},
           refresh_token_hash = ${hashToken(refresh)},
           refresh_expires_at = ${refreshExpires},
           last_used_at       = now(),
           last_used_ip       = ${input.ip ?? null}
     WHERE id = ${row.id}
  `);

  const scopes = (row.scopes ?? []).filter(isValidScope) as ApiScope[];
  return {
    ok: true,
    tokens: {
      access_token: access,
      refresh_token: refresh,
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      scope: scopes.join(" "),
      grantId: Number(row.id),
    },
  };
}

// ── Verify (the door) ────────────────────────────────────────────────────────

export interface VerifiedGrant {
  grantId: number;
  companyId: number;
  userId: number;
  role: string;
  email: string;
  first_name?: string;
  clientName: string;
  scopes: ApiScope[];
}

export type GrantFailure =
  | "malformed"
  | "not_found"
  | "expired"
  | "revoked"
  | "user_inactive"
  | "role_forbidden"
  | "company_disabled";

export type VerifyGrantResult =
  | { ok: true; grant: VerifiedGrant }
  | { ok: false; reason: GrantFailure };

export function looksLikeAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_PREFIX);
}

// Same list as api-keys.ts FORBIDDEN_KEY_ROLES, and deliberately duplicated
// rather than exported-and-shared: these are two separate policy decisions that
// happen to agree today. If write scopes ever ship for one credential type and
// not the other, this list is where that divergence belongs.
const FORBIDDEN_GRANT_ROLES = ["technician", "trainee", "portal_client", "accountant"];

/**
 * Resolve an access token to the tenant + user + scopes it grants.
 *
 * Every check here is a LIVE read, exactly as verifyApiKey() does it — the
 * role, the user's active flag, and the company switch are never frozen into
 * the token. That is what makes deactivating a user or flipping
 * api_access_enabled an instant kill switch for their grants, with no token
 * lifetime to wait out.
 */
export async function verifyAccessToken(token: string): Promise<VerifyGrantResult> {
  if (!looksLikeAccessToken(token)) return { ok: false, reason: "malformed" };

  const rows: any = await db.execute(sql`
    SELECT g.id, g.company_id, g.user_id, g.client_name, g.scopes,
           g.access_expires_at, g.revoked_at,
           u.role, u.email, u.first_name, u.is_active AS user_active,
           c.api_access_enabled
      FROM oauth_grants g
      JOIN users     u ON u.id = g.user_id
      JOIN companies c ON c.id = g.company_id
     WHERE g.access_token_hash = ${hashToken(token)}
     LIMIT 1
  `);
  const row = (rows.rows ?? rows)[0];

  if (!row) return { ok: false, reason: "not_found" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (new Date(row.access_expires_at).getTime() <= Date.now()) return { ok: false, reason: "expired" };
  if (row.user_active === false) return { ok: false, reason: "user_inactive" };
  if (FORBIDDEN_GRANT_ROLES.includes(String(row.role))) return { ok: false, reason: "role_forbidden" };
  if (!row.api_access_enabled) return { ok: false, reason: "company_disabled" };

  return {
    ok: true,
    grant: {
      grantId: Number(row.id),
      companyId: Number(row.company_id),
      userId: Number(row.user_id),
      role: String(row.role),
      email: String(row.email ?? ""),
      first_name: row.first_name ?? undefined,
      clientName: String(row.client_name ?? "Connected app"),
      scopes: (row.scopes ?? []).filter(isValidScope) as ApiScope[],
    },
  };
}

/** Fire-and-forget last-used stamp. A write failure here must never fail the caller's request. */
export function touchGrant(grantId: number, ip: string | undefined): void {
  db.execute(sql`
    UPDATE oauth_grants SET last_used_at = now(), last_used_ip = ${ip ?? null} WHERE id = ${grantId}
  `).catch((err) => console.error("[oauth] last_used update failed", err));
}

// ── Revoke / list ────────────────────────────────────────────────────────────

async function revokeGrantById(grantId: number, reason: string): Promise<void> {
  await db.execute(sql`
    UPDATE oauth_grants
       SET revoked_at = now(), revoked_reason = ${reason},
           access_token_hash = ${"revoked_" + crypto.randomBytes(16).toString("hex")},
           refresh_token_hash = NULL
     WHERE id = ${grantId} AND revoked_at IS NULL
  `);
}

/**
 * Revoke from the tenant's own settings page. Company-scoped by design — a
 * grant id from another tenant simply matches nothing.
 */
export async function revokeGrantForCompany(companyId: number, grantId: number): Promise<boolean> {
  const res: any = await db.execute(sql`
    UPDATE oauth_grants
       SET revoked_at = now(), revoked_reason = 'revoked_by_tenant',
           access_token_hash = ${"revoked_" + crypto.randomBytes(16).toString("hex")},
           refresh_token_hash = NULL
     WHERE id = ${grantId} AND company_id = ${companyId} AND revoked_at IS NULL
     RETURNING id
  `);
  return ((res.rows ?? res).length ?? 0) > 0;
}

/** Client-initiated revocation (RFC 7009). Accepts either token type. */
export async function revokeByToken(token: string): Promise<void> {
  const h = hashToken(token);
  const rows: any = await db.execute(sql`
    SELECT id FROM oauth_grants
     WHERE (access_token_hash = ${h} OR refresh_token_hash = ${h}) AND revoked_at IS NULL
     LIMIT 1
  `);
  const row = (rows.rows ?? rows)[0];
  if (row) await revokeGrantById(Number(row.id), "revoked_by_client");
}

export interface GrantSummary {
  id: number;
  client_name: string;
  scopes: string[];
  approved_by: string;
  approved_by_role: string;
  created_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
}

/** Everything currently connected for this tenant, newest first. */
export async function listGrants(companyId: number): Promise<GrantSummary[]> {
  const rows: any = await db.execute(sql`
    SELECT g.id, g.client_name, g.scopes, g.created_at, g.last_used_at, g.last_used_ip,
           g.refresh_expires_at,
           COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.email) AS approved_by,
           u.role AS approved_by_role
      FROM oauth_grants g
      JOIN users u ON u.id = g.user_id
     WHERE g.company_id = ${companyId} AND g.revoked_at IS NULL
     ORDER BY g.created_at DESC
  `);
  return (rows.rows ?? rows).map((r: any) => ({
    id: Number(r.id),
    client_name: r.client_name,
    scopes: r.scopes ?? [],
    approved_by: r.approved_by ?? "",
    approved_by_role: String(r.approved_by_role ?? ""),
    created_at: new Date(r.created_at).toISOString(),
    last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    last_used_ip: r.last_used_ip ?? null,
    expires_at: r.refresh_expires_at ? new Date(r.refresh_expires_at).toISOString() : null,
  }));
}
