// [customer-portal 2026-08-05] The portal's authentication core: session
// issuance, session resolution, single-use secrets, and the capability lookup.
// Design: docs/CUSTOMER_PORTAL_DESIGN.md.
//
// THE RULE THIS MODULE EXISTS TO HOLD:
//   One identity system, two capability sets. Residential and commercial
//   customers share this entire file. They diverge in exactly one place —
//   portalCapabilities() — and nowhere else. If you find yourself writing
//   `if (commercial)` in a route, the answer belongs in the table below.
//
// AND THE ONE IT MUST NEVER BREAK:
//   A portal session must never satisfy requireAuth (lib/auth.ts). Portal
//   sessions deliberately keep role 'portal_client' so that guard rejects them.
//   Do not "clean that up" — it is the thing standing between a customer and
//   ~320 role-ungated staff routes.
import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { portalUsersTable, portalTokensTable } from "@workspace/db/schema";
import { and, eq, isNull, gt, sql } from "drizzle-orm";
import { signToken, verifyToken } from "./auth.js";

// Portal sessions are SHORT-lived. A staff token lasts 30 days because it sits
// on a company laptop; a customer session is a browser on an unknown device.
const SESSION_TTL = "12h";
// Single-use secret lifetimes, per kind. Impersonation is deliberately tiny:
// it exists for the length of a support call, not a workday.
const TOKEN_TTL_MINUTES: Record<PortalTokenKind, number> = {
  verify: 60 * 24 * 3,
  reset: 60,
  magic: 15,
  impersonation: 15,
};

export type PortalTokenKind = "verify" | "reset" | "magic" | "impersonation";

export interface PortalSession {
  portalUserId: number;
  companyId: number;
  email: string;
  /** Set for a residential customer. Exactly one of these two is non-null. */
  clientId: number | null;
  /** Set for a commercial customer (an account_contacts row). */
  accountContactId: number | null;
  /** Staff user id when the office is viewing as this customer; else null. */
  impersonatedBy: number | null;
}

declare global {
  namespace Express {
    interface Request {
      portalSession?: PortalSession;
    }
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────

// Signed with role 'portal_client' ON PURPOSE — see the header note. The portal
// claims ride alongside; verifyToken preserves unknown fields.
export function signPortalToken(session: PortalSession): string {
  return signToken({
    userId: session.portalUserId,
    companyId: session.companyId,
    role: "portal_client",
    email: session.email,
    portal: {
      clientId: session.clientId,
      accountContactId: session.accountContactId,
      impersonatedBy: session.impersonatedBy,
    },
  } as any, SESSION_TTL);
}

/**
 * Resolve a portal session, or reject.
 *
 * Re-reads `portal_users` on EVERY request rather than trusting the token's
 * claims. A JWT is a 12-hour snapshot; deactivating a customer or detaching
 * them from an account has to take effect immediately, not when their token
 * happens to expire.
 */
export async function requirePortalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized", message: "Sign in to continue" });
    return;
  }
  let payload: any;
  try {
    payload = verifyToken(header.substring(7));
  } catch {
    res.status(401).json({ error: "Unauthorized", message: "Your session has expired — sign in again" });
    return;
  }
  // A STAFF token must not open a customer session either. The isolation runs
  // both ways: staff use the office app, and an accidental cross-over here
  // would let a staff token read portal routes as though it were a customer.
  if (payload.role !== "portal_client" || !payload.portal) {
    res.status(403).json({ error: "Forbidden", message: "Not a portal session" });
    return;
  }

  const [user] = await db
    .select({
      id: portalUsersTable.id,
      company_id: portalUsersTable.company_id,
      email: portalUsersTable.email,
      client_id: portalUsersTable.client_id,
      account_contact_id: portalUsersTable.account_contact_id,
      is_active: portalUsersTable.is_active,
    })
    .from(portalUsersTable)
    .where(eq(portalUsersTable.id, payload.userId))
    .limit(1);

  if (!user || !user.is_active) {
    res.status(401).json({ error: "Unauthorized", message: "This login is no longer active" });
    return;
  }
  // The token says which company; the row is the truth. A mismatch means a
  // token minted against a record that has since moved — refuse it.
  if (user.company_id !== payload.companyId) {
    res.status(401).json({ error: "Unauthorized", message: "Your session is no longer valid" });
    return;
  }

  req.portalSession = {
    portalUserId: user.id,
    companyId: user.company_id,
    email: user.email,
    // Straight off the ROW, never off the token, and never off the request
    // body. This pair is the whole authorization story for the request.
    clientId: user.client_id,
    accountContactId: user.account_contact_id,
    impersonatedBy: payload.portal.impersonatedBy ?? null,
  };
  next();
}

// ── Capabilities ────────────────────────────────────────────────────────────

export interface PortalCapabilities {
  kind: "residential" | "commercial";
  viewVisits: boolean;
  rateClean: boolean;
  viewInvoices: boolean;
  downloadInvoicePdf: boolean;
  bulkDownloadInvoices: boolean;
  payInvoice: boolean;
  viewBuildings: boolean;
  requestService: boolean;
  manageContacts: boolean;
  // [portal-service-account 2026-08-20] The customer's own agreement and the
  // plan it describes. Reading these is never gated on `acting`: an office
  // support session walking a customer through their cadence or their notice
  // terms is the whole point of view-as.
  viewSchedule: boolean;
  viewAgreement: boolean;
  /**
   * Pause and resume their own service. Residential only — a hold is scoped to
   * a `clients` row, and a commercial account's pauses are negotiated per
   * building, not self-served.
   *
   * NOTE this only ever covers a FREE hold, one that fits inside the free days
   * the agreement grants and moves no money. A hold long enough to count as
   * notice ends the agreement and bills the notice period, so it is never
   * self-executing at any capability level — it becomes a request the office
   * answers. See routes/portal.ts POST /hold.
   */
  manageHold: boolean;
  /** Send us someone they know. */
  submitReferral: boolean;
}

/**
 * The ONE place residential and commercial differ. Every portal route asks this
 * instead of re-deriving "is this commercial?" inline — that re-derivation is
 * how two code paths drift into two different ideas of who may do what.
 */
export function portalCapabilities(session: PortalSession): PortalCapabilities {
  const commercial = session.accountContactId != null;
  // An impersonated session is READ-ONLY. Support staff walking a customer
  // through a screen must never be able to spend that customer's money or
  // commit them to work. Applied here so every capability check inherits it and
  // no individual route has to remember.
  const acting = session.impersonatedBy == null;

  return commercial
    ? {
        kind: "commercial",
        viewVisits: true,
        rateClean: false,
        viewInvoices: true,
        downloadInvoicePdf: true,
        bulkDownloadInvoices: true,
        payInvoice: acting,
        viewBuildings: true,
        requestService: acting,
        manageContacts: acting,
        viewSchedule: true,
        viewAgreement: true,
        // A commercial hold is not a thing: holds hang off a clients row, and a
        // property-management account pauses per building through its contract.
        manageHold: false,
        submitReferral: false,
      }
    : {
        kind: "residential",
        viewVisits: true,
        rateClean: acting,
        viewInvoices: true,
        downloadInvoicePdf: true,
        bulkDownloadInvoices: false,
        payInvoice: acting,
        viewBuildings: false,
        // [portal-service-account 2026-08-20] Was false with the note "later".
        // Later is now: a residential customer can ask for an extra clean, and
        // the ask lands in the same office queue a commercial one does.
        requestService: acting,
        manageContacts: false,
        viewSchedule: true,
        viewAgreement: true,
        manageHold: acting,
        submitReferral: acting,
      };
}

/** Guard a route on one capability. */
export function requireCapability(cap: keyof Omit<PortalCapabilities, "kind">) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = req.portalSession;
    if (!session) {
      res.status(401).json({ error: "Unauthorized", message: "Sign in to continue" });
      return;
    }
    if (!portalCapabilities(session)[cap]) {
      res.status(403).json({
        error: "Forbidden",
        message: session.impersonatedBy != null
          ? "This is a read-only support session — the customer must do this themselves"
          : "Not available on this account",
      });
      return;
    }
    next();
  };
}

// ── Passwords ───────────────────────────────────────────────────────────────

const BCRYPT_ROUNDS = 12;

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);

/**
 * Verify a password against a hash that may be absent.
 *
 * Runs a real bcrypt comparison against a dummy hash when the user has no
 * password (social-only, or no such email), so a wrong email and a wrong
 * password take the same time. Without this, response timing tells an attacker
 * which email addresses are real customers.
 */
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.7HHKQGYKmnCwqBs8yUQxGWnfaQtKZ7S";
export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (!hash) { await bcrypt.compare(plain, DUMMY_HASH); return false; }
  return bcrypt.compare(plain, hash);
}

/** Minimum bar for a customer password. Length carries the weight, not symbols. */
export function passwordProblem(plain: unknown): string | null {
  if (typeof plain !== "string" || plain.length < 10) {
    return "Password must be at least 10 characters";
  }
  if (plain.length > 200) return "Password is too long";
  return null;
}

// ── Single-use secrets (verify / reset / magic / impersonation) ─────────────

/**
 * Mint a single-use token. Returns the RAW value to put in a link — only the
 * SHA-256 hash is stored, so a leaked database row is not a usable link.
 */
export async function mintPortalToken(opts: {
  companyId: number;
  portalUserId: number;
  kind: PortalTokenKind;
  issuedByUserId?: number | null;
}): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + TOKEN_TTL_MINUTES[opts.kind] * 60_000);
  await db.insert(portalTokensTable).values({
    company_id: opts.companyId,
    portal_user_id: opts.portalUserId,
    kind: opts.kind,
    token_hash: hashToken(raw),
    expires_at: expires,
    issued_by_user_id: opts.issuedByUserId ?? null,
  });
  return raw;
}

export const hashToken = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex");

/**
 * Redeem a token: valid, right kind, unexpired, unused — and mark it used in
 * the SAME statement. The `used_at IS NULL` predicate lives in the UPDATE so
 * two simultaneous clicks on a reset link can't both win; the second updates
 * zero rows and is rejected.
 */
export async function redeemPortalToken(raw: string, kind: PortalTokenKind): Promise<{
  portalUserId: number; companyId: number; issuedByUserId: number | null;
} | null> {
  if (!raw || typeof raw !== "string") return null;
  const rows = await db
    .update(portalTokensTable)
    .set({ used_at: new Date() })
    .where(and(
      eq(portalTokensTable.token_hash, hashToken(raw)),
      eq(portalTokensTable.kind, kind),
      isNull(portalTokensTable.used_at),
      gt(portalTokensTable.expires_at, new Date()),
    ))
    .returning({
      portal_user_id: portalTokensTable.portal_user_id,
      company_id: portalTokensTable.company_id,
      issued_by: portalTokensTable.issued_by_user_id,
    });
  const row = rows[0];
  return row
    ? { portalUserId: row.portal_user_id, companyId: row.company_id, issuedByUserId: row.issued_by ?? null }
    : null;
}

/**
 * Invalidate every outstanding token of a kind for a user. Called after a
 * successful password reset so older reset links in the mailbox stop working.
 */
export async function revokePortalTokens(portalUserId: number, kind: PortalTokenKind): Promise<void> {
  await db
    .update(portalTokensTable)
    .set({ used_at: new Date() })
    .where(and(
      eq(portalTokensTable.portal_user_id, portalUserId),
      eq(portalTokensTable.kind, kind),
      isNull(portalTokensTable.used_at),
    ));
}

/** Emails are matched case-insensitively; the unique index is on lower(email). */
export const normalizeEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();

/** Look up a portal user by email within a tenant. */
export async function findPortalUserByEmail(companyId: number, email: string) {
  const [user] = await db
    .select()
    .from(portalUsersTable)
    .where(and(
      eq(portalUsersTable.company_id, companyId),
      sql`lower(${portalUsersTable.email}) = ${normalizeEmail(email)}`,
    ))
    .limit(1);
  return user ?? null;
}
