import crypto from "crypto";
import { db } from "@workspace/db";
import { apiKeysTable, companiesTable, usersTable } from "@workspace/db/schema";
import { eq, and, isNull, desc, sql } from "drizzle-orm";

// [ai-access 2026-08-15] Mint / verify / rotate / revoke for the machine
// credentials behind Qleno Connect (REST /api/v1) and Qleno Agent (MCP).
// Design + rationale: docs/AI_ACCESS_DESIGN.md.
//
// This file is the ONLY place that knows the token format or touches
// secret_hash. Everything else goes through verifyApiKey().

// ── Token format ─────────────────────────────────────────────────────────────
// qlno_live_<key_id>_<secret>
//   key_id  12 chars, PUBLIC, unique-indexed. Verification is one index hit;
//           without a public id every request would hash-compare the table.
//   secret  43 chars of base64url over 32 CSPRNG bytes (256 bits).
//
// The literal "qlno_live_" prefix is load-bearing: it is what GitHub secret
// scanning and similar tools pattern-match on when a key leaks into a repo.
// Never make it configurable or tenant-specific.
//
// qlno_test_ is deliberately NOT implemented — no sandbox tenant exists
// (decision 2026-08-15: tenants connect against their own live data, and the
// safety comes from read-by-default scopes plus confirm-before-destructive,
// not from a parallel fake company we would have to keep believable forever).
// The prefix stays reserved so the format doesn't have to change if that
// decision is ever revisited.
export const KEY_PREFIX = "qlno_live_";

const KEY_ID_BYTES = 9;   // 9 bytes → 12 base64url chars, no padding
const SECRET_BYTES = 32;  // 256 bits — unguessable, see hashSecret()

// ── Scopes ───────────────────────────────────────────────────────────────────
// Effective permission is always: plan gate ∩ role of the minting user ∩ these.
// A scope can only ever NARROW what the minting user could already do — it can
// never grant something their role doesn't have.
export const READ_SCOPES = [
  "jobs:read",
  "clients:read",
  "invoices:read",
  "payroll:read",
  "reports:read",
  "quotes:read",
] as const;

export const WRITE_SCOPES = [
  "jobs:write",
  "clients:write",
  "invoices:write",
  "comms:send",
  "payments:charge",
  // [mcp-writes 2026-08-19] The office-workflow set. Sal: "I need to be able to
  // prompt a quote and email it... add a new employee, delete one, move one to
  // inactive status."
  //
  // `quotes:send` is deliberately its own scope and NOT folded into
  // `comms:send`. They are different powers: comms:send is "message anyone
  // anything", quotes:send is "email THIS quote to the address already on THIS
  // quote". The second has a fixed recipient the tenant already chose and a
  // fixed body the quote template renders, so a prompt injection buried in a
  // client note cannot turn it into a channel. That difference is what makes it
  // grantable to a chat connection when comms:send is not — see
  // OAUTH_GRANTABLE_SCOPES in oauth.ts.
  //
  // `employees:write` covers onboarding and deactivation. Deactivation carries
  // a further owner-only role check on top of the scope, because Sal is the only
  // person at the office who may do it.
  "quotes:write",
  "quotes:send",
  "schedules:write",
  "employees:write",
] as const;

export const ALL_SCOPES = [...READ_SCOPES, ...WRITE_SCOPES] as const;
export type ApiScope = (typeof ALL_SCOPES)[number];

// New keys are read-only unless the minting user deliberately adds write
// scopes. An AI that can only read cannot be talked into damage by a prompt
// injection buried in a client note.
export const DEFAULT_SCOPES: ApiScope[] = [...READ_SCOPES];

// These reach outside the app — money, customers, or a person's ability to log
// in. The UI requires a second, explicit confirmation before any of them can be
// attached to a key.
export const HIGH_RISK_SCOPES: ApiScope[] = [
  "comms:send",
  "payments:charge",
  "quotes:send",
  "employees:write",
];

export function isValidScope(s: string): s is ApiScope {
  return (ALL_SCOPES as readonly string[]).includes(s);
}

// ── Who may mint ─────────────────────────────────────────────────────────────
// Owner and admin only (decision 2026-08-15). An office user can USE a key
// someone minted for them; they cannot create one. Deliberately NOT reusing
// isOfficeRole() — that helper includes 'office', and the whole point here is
// that it doesn't. Keeping the two lists separate means a future change to
// office permissions can't silently widen who can mint credentials.
//
// A technician or trainee may never hold a key at all: their role scopes them
// to their own data by inline checks scattered across the app, and a machine
// credential riding a tech role would be a permission surface nobody has
// audited. Enforced at mint AND re-checked live on every request in
// verifyApiKey(), so a later role change revokes the key's power immediately.
const MINTER_ROLES = ["owner", "admin", "super_admin"];
const FORBIDDEN_KEY_ROLES = ["technician", "trainee", "portal_client", "accountant"];

export function canMintApiKeys(role: string | null | undefined): boolean {
  return !!role && MINTER_ROLES.includes(role);
}

// ── Hashing ──────────────────────────────────────────────────────────────────
// SHA-256, deliberately NOT bcrypt. bcrypt's work factor defends LOW-entropy
// human passwords against offline brute force; this secret is 256 CSPRNG bits,
// which no work factor makes meaningfully safer. At the rate limit (300 req/min
// per key) a bcrypt verify per request would burn real CPU for zero added
// safety. Same trade Stripe and GitHub make, for the same reason.
function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

// Constant-time compare so a caller can't learn the hash byte-by-byte from
// response timing. Both sides are fixed-length hex, but length-check first —
// timingSafeEqual throws on a length mismatch.
function hashesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

// ── Mint ─────────────────────────────────────────────────────────────────────

export interface MintedKey {
  id: number;
  key_id: string;
  /** The full token. Returned ONCE, never stored, never recoverable. */
  token: string;
  name: string;
  scopes: ApiScope[];
  expires_at: Date | null;
}

export interface MintOptions {
  companyId: number;
  /** The human the key acts as — normally the minting user themselves. */
  userId: number;
  createdBy: number;
  name: string;
  scopes?: ApiScope[];
  expiresAt?: Date | null;
  /** Set by rotateApiKey() to record lineage. */
  rotatedFrom?: number | null;
}

export async function mintApiKey(opts: MintOptions): Promise<MintedKey> {
  const scopes = (opts.scopes ?? DEFAULT_SCOPES).filter(isValidScope);
  if (scopes.length === 0) {
    throw new Error("An API key must carry at least one scope");
  }

  // The key acts as a real, current user in this company. Verified here rather
  // than trusted from the request body so a crafted payload can't mint a key
  // pointed at someone else's user id or another tenant.
  const [target] = await db
    .select({ id: usersTable.id, role: usersTable.role, company_id: usersTable.company_id })
    .from(usersTable)
    .where(eq(usersTable.id, opts.userId))
    .limit(1);

  if (!target || target.company_id !== opts.companyId) {
    throw new Error("Key owner must be a user in this company");
  }
  if (FORBIDDEN_KEY_ROLES.includes(String(target.role))) {
    throw new Error(`Role '${target.role}' cannot hold an API key`);
  }

  const key_id = b64url(crypto.randomBytes(KEY_ID_BYTES));
  const secret = b64url(crypto.randomBytes(SECRET_BYTES));
  const token = `${KEY_PREFIX}${key_id}_${secret}`;

  const [row] = await db
    .insert(apiKeysTable)
    .values({
      company_id: opts.companyId,
      user_id: opts.userId,
      key_id,
      secret_hash: hashSecret(secret),
      name: opts.name.trim() || "Untitled key",
      scopes,
      created_by: opts.createdBy,
      expires_at: opts.expiresAt ?? null,
      rotated_from: opts.rotatedFrom ?? null,
    })
    .returning({ id: apiKeysTable.id });

  return { id: row.id, key_id, token, name: opts.name, scopes, expires_at: opts.expiresAt ?? null };
}

// ── Verify ───────────────────────────────────────────────────────────────────

export interface VerifiedKey {
  keyId: number;
  companyId: number;
  userId: number;
  role: string;
  email: string;
  first_name?: string;
  name: string;
  scopes: ApiScope[];
}

export type VerifyFailure =
  | "malformed"
  | "not_found"
  | "bad_secret"
  | "revoked"
  | "expired"
  | "user_inactive"
  | "role_forbidden"
  | "company_disabled";

export type VerifyResult =
  | { ok: true; key: VerifiedKey }
  | { ok: false; reason: VerifyFailure };

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith("qlno_");
}

/**
 * Resolve a raw token to the tenant + user + scopes it grants, or a reason it
 * doesn't. Every check below is re-run on EVERY request rather than frozen at
 * mint time — the role, the user's active flag, and the company's access
 * switch are all live reads. That is what makes "deactivate the user" and
 * "flip api_access_enabled off" work as instant kill switches.
 */
export async function verifyApiKey(token: string): Promise<VerifyResult> {
  if (!token.startsWith(KEY_PREFIX)) return { ok: false, reason: "malformed" };

  const rest = token.slice(KEY_PREFIX.length);
  const sep = rest.indexOf("_");
  if (sep <= 0) return { ok: false, reason: "malformed" };

  const key_id = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (!key_id || !secret) return { ok: false, reason: "malformed" };

  const [row] = await db
    .select({
      id: apiKeysTable.id,
      company_id: apiKeysTable.company_id,
      user_id: apiKeysTable.user_id,
      secret_hash: apiKeysTable.secret_hash,
      name: apiKeysTable.name,
      scopes: apiKeysTable.scopes,
      revoked_at: apiKeysTable.revoked_at,
      expires_at: apiKeysTable.expires_at,
      role: usersTable.role,
      email: usersTable.email,
      first_name: usersTable.first_name,
      user_active: usersTable.is_active,
      api_enabled: companiesTable.api_access_enabled,
    })
    .from(apiKeysTable)
    .innerJoin(usersTable, eq(usersTable.id, apiKeysTable.user_id))
    .innerJoin(companiesTable, eq(companiesTable.id, apiKeysTable.company_id))
    .where(eq(apiKeysTable.key_id, key_id))
    .limit(1);

  if (!row) return { ok: false, reason: "not_found" };
  if (!hashesMatch(row.secret_hash, hashSecret(secret))) return { ok: false, reason: "bad_secret" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  if (row.user_active === false) return { ok: false, reason: "user_inactive" };
  if (FORBIDDEN_KEY_ROLES.includes(String(row.role))) return { ok: false, reason: "role_forbidden" };
  if (!row.api_enabled) return { ok: false, reason: "company_disabled" };

  return {
    ok: true,
    key: {
      keyId: row.id,
      companyId: row.company_id,
      userId: row.user_id,
      role: String(row.role),
      email: String(row.email ?? ""),
      first_name: row.first_name ?? undefined,
      name: row.name,
      scopes: (row.scopes ?? []).filter(isValidScope),
    },
  };
}

/**
 * Stamp last-used. Fire-and-forget on purpose: this is a convenience signal for
 * the tenant ("something used this key from an IP you don't recognise"), and a
 * write failure here must never fail the caller's actual request.
 */
export function touchApiKey(keyId: number, ip: string | undefined): void {
  db.update(apiKeysTable)
    .set({ last_used_at: new Date(), last_used_ip: ip ?? null })
    .where(eq(apiKeysTable.id, keyId))
    .catch((err) => console.error("[api-keys] last_used update failed", err));
}

// ── Revoke / rotate / list ───────────────────────────────────────────────────

/** Company-scoped by design — a key id from another tenant simply matches nothing. */
export async function revokeApiKey(companyId: number, keyId: number, revokedBy: number): Promise<boolean> {
  const rows = await db
    .update(apiKeysTable)
    .set({ revoked_at: new Date(), revoked_by: revokedBy })
    .where(and(
      eq(apiKeysTable.id, keyId),
      eq(apiKeysTable.company_id, companyId),
      isNull(apiKeysTable.revoked_at),
    ))
    .returning({ id: apiKeysTable.id });
  return rows.length > 0;
}

/** Overlap window for rotation. See rotateApiKey(). */
export const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * Mint a replacement carrying the same owner, name, and scopes, and set the old
 * key to expire in 24 hours instead of dying immediately.
 *
 * The overlap is the whole point: without it, rotating means the integration is
 * broken from the moment you click the button until someone pastes the new
 * token in. That guarantees nobody ever rotates. A day is enough to update a
 * connected assistant without a scramble, and short enough that a
 * rotated-because-leaked key isn't usable for long. To cut a leaked key off NOW,
 * revoke it — that is what revoke is for.
 */
export async function rotateApiKey(companyId: number, keyId: number, actorUserId: number): Promise<MintedKey | null> {
  const [old] = await db
    .select({
      id: apiKeysTable.id,
      user_id: apiKeysTable.user_id,
      name: apiKeysTable.name,
      scopes: apiKeysTable.scopes,
      revoked_at: apiKeysTable.revoked_at,
    })
    .from(apiKeysTable)
    .where(and(eq(apiKeysTable.id, keyId), eq(apiKeysTable.company_id, companyId)))
    .limit(1);

  if (!old || old.revoked_at) return null;

  const minted = await mintApiKey({
    companyId,
    userId: old.user_id,
    createdBy: actorUserId,
    name: old.name,
    scopes: (old.scopes ?? []).filter(isValidScope),
    rotatedFrom: old.id,
  });

  await db
    .update(apiKeysTable)
    .set({ expires_at: new Date(Date.now() + ROTATION_OVERLAP_MS) })
    .where(eq(apiKeysTable.id, old.id));

  return minted;
}

/** Settings list. Never selects secret_hash — the secret is unrecoverable by design. */
export async function listApiKeys(companyId: number) {
  return db
    .select({
      id: apiKeysTable.id,
      key_id: apiKeysTable.key_id,
      name: apiKeysTable.name,
      scopes: apiKeysTable.scopes,
      user_id: apiKeysTable.user_id,
      owner_name: sql<string>`btrim(coalesce(${usersTable.first_name}, '') || ' ' || coalesce(${usersTable.last_name}, ''))`,
      last_used_at: apiKeysTable.last_used_at,
      last_used_ip: apiKeysTable.last_used_ip,
      created_at: apiKeysTable.created_at,
      expires_at: apiKeysTable.expires_at,
      revoked_at: apiKeysTable.revoked_at,
    })
    .from(apiKeysTable)
    .innerJoin(usersTable, eq(usersTable.id, apiKeysTable.user_id))
    .where(eq(apiKeysTable.company_id, companyId))
    .orderBy(desc(apiKeysTable.created_at));
}

/** Display half of a token: qlno_live_a1b2c3d4e5f6…  Never reconstructs the secret. */
export function maskedToken(key_id: string): string {
  return `${KEY_PREFIX}${key_id}…`;
}
