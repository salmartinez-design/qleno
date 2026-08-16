import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthPayload {
  userId: number;
  companyId: number | null;
  role: string;
  email: string;
  first_name?: string;
  isSuperAdmin?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

// [jwt-secret 2026-08-15] The fallback used to be a fixed string committed to a
// public repo, behind a console.warn. A warning is the wrong control here: the
// signing secret IS the authentication system, so anyone reading the repo could
// mint a token for any role in any company, and a line in the boot log is not
// something anyone reads on a healthy deploy. Production is now refused outright
// rather than served insecurely.
//
// The dev fallback stays fixed on purpose — a per-process random secret would
// invalidate every token on each restart, which reads as a login bug and trains
// people to ignore it. It is safe only because production can never reach it.
const IS_PRODUCTION = process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT === "production";
const DEV_ONLY_JWT_SECRET = "qleno-local-dev-only-never-valid-in-production";

if (!process.env.JWT_SECRET && IS_PRODUCTION) {
  throw new Error(
    "[auth] FATAL: JWT_SECRET is not set. Refusing to start in production — " +
      "without it the server would sign sessions with a publicly-known development key, " +
      "letting anyone forge a token for any role in any company. " +
      "Set a single stable JWT_SECRET in the environment, identical across all replicas.",
  );
}

const JWT_SECRET = process.env.JWT_SECRET || DEV_ONLY_JWT_SECRET;

// Outside production an unset secret is merely inconvenient, but it is still the
// most common cause of "login works, then instantly logs out": tokens signed
// under one secret fail verification under another, so /me 401s on a session
// just issued.
if (!process.env.JWT_SECRET) {
  console.warn(
    "[auth] WARNING: JWT_SECRET is not set — using the local development key. " +
      "This is refused in production. Set a stable JWT_SECRET to avoid login-loop logouts.",
  );
}

// [tech-session 2026-06-30] 30-day login lifetime so field techs who keep the
// app pinned aren't silently logged out after a day (the "No jobs today" /
// reinstall-to-fix complaint). The frontend slides this forward on every app
// open (startTokenRefresh), so an active tech effectively never re-logs in; a
// truly stale (30-day-idle) pass routes to the login screen, never a blank
// screen. Trade-off: no server-side revocation yet — a lost/offboarded device
// stays valid until expiry. Add a revocation list as the proper follow-up.
// [customer-portal 2026-08-05] `expiresIn` is optional and defaults to the same
// 30 days, so every existing caller is unchanged. It exists because a CUSTOMER
// portal session must not last 30 days: the 30-day lifetime is justified above
// by a field tech's phone staying pinned to the app, which says nothing about a
// customer's browser on an unknown device. The portal passes 12h.
export function signToken(payload: AuthPayload, expiresIn: string = "30d"): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: expiresIn as any });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized", message: "No token provided" });
    return;
  }

  const token = authHeader.substring(7);

  // [ai-access 2026-08-15] An API key must NEVER authenticate an internal
  // route. It would be less code to resolve keys here — they'd land in req.auth
  // and all 954 internal endpoints would accept them for free — and that is
  // precisely the outcome to avoid: those endpoints are internal plumbing whose
  // shapes change weekly, and admitting keys would freeze every one into a
  // permanent public contract while making the blast radius of any auth mistake
  // 954 routes instead of the ~25 we deliberately publish.
  //
  // Keys authenticate ONLY routes mounted behind requireApiKey (lib/api-auth.ts):
  // /api/v1 and /mcp. The message names the right door rather than a bare 401,
  // because "invalid token" on a perfectly valid key is a support ticket.
  if (token.startsWith("qlno_")) {
    res.status(401).json({
      error: "Unauthorized",
      message: "API keys are not accepted on internal endpoints. Use the versioned API at /api/v1 or the MCP endpoint at /mcp.",
    });
    return;
  }

  try {
    const payload = verifyToken(token);
    // [portal-token-isolation 2026-08-05] A CUSTOMER portal token must never
    // authenticate a STAFF endpoint. /api/portal/login signs a normal app JWT
    // carrying role 'portal_client' (portal.ts), and this guard used to admit
    // any valid token — so that customer token satisfied `requireAuth` on every
    // staff route. ~320 routes are protected by requireAuth ALONE with no
    // requireRole, and they scope by req.auth.companyId only. GET /invoices/:id
    // is one: a logged-in customer could walk invoice ids and read every other
    // customer's invoice in the tenant, PDF included.
    //
    // Rejected HERE rather than route-by-route because the leak is the absence
    // of a check on hundreds of routes — an allowlist would have to be perfect
    // forever. The portal is unaffected: routes/portal.ts runs its own
    // requirePortalAuth, which verifies the token itself and never calls this.
    // Anything the portal legitimately needs gets an explicit /api/portal route.
    if (payload.role === "portal_client") {
      res.status(403).json({ error: "Forbidden", message: "Portal sessions cannot access staff endpoints" });
      return;
    }
    req.auth = payload;
    // [accountant-readonly 2026-06-20] The 'accountant' role (external CPA) is
    // VIEW-ONLY across the entire app: permit safe read methods, reject every
    // mutation no matter which endpoint it targets. Enforced here at the single
    // auth choke point so no write path can ever be missed.
    if (payload.role === "accountant" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      res.status(403).json({ error: "Forbidden", message: "Accountant access is view-only" });
      return;
    }
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
  }
}

// [trainee-role 2026-07-28] True for the field-cleaner roles that must be scoped
// to their OWN data (own jobs / pay / tips / mileage). A trainee is treated
// identically to a technician by every inline `role === "technician"` scope-down
// check — omitting trainee here would let a trainee fall through to the office
// branch and read other people's data, so use this helper, not a bare equality.
export function isTechnicianRole(role: string | null | undefined): boolean {
  return role === "technician" || role === "trainee";
}

// [client-office-notes 2026-08-09] True for the desk roles that may read and
// write office-only content. The inverse of isTechnicianRole is NOT good enough
// here — 'accountant' (the external CPA) is neither a tech nor office staff who
// should be editing client notes, so this is an explicit allow-list.
//
// Use this for field-level gating INSIDE a handler that is already authenticated
// but shared with non-office callers. A whole route that is office-only should
// still use requireRole("owner", "admin", "office") at the router.
export function isOfficeRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin" || role === "office" || role === "super_admin";
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: "Unauthorized", message: "Not authenticated" });
      return;
    }
    // [office-admin-parity 2026-06-26] The 'office' role is elevated to admin
    // level: anywhere a route grants 'admin', 'office' is granted too. This lets
    // every office employee reach and modify admin settings (pricing, discounts,
    // fees, company settings) without hand-editing each endpoint guard. It does
    // NOT cover owner-only routes (requireRole("owner") with no "admin") — those
    // stay owner-restricted, e.g. payroll-policy config. Single choke point so
    // no settings endpoint is missed and future admin routes inherit it.
    const withOffice = roles.includes("admin") ? [...roles, "office"] : [...roles];
    // [trainee-role 2026-07-28] A trainee behaves EXACTLY like a technician for
    // access. Single choke point (same pattern as office/admin above): anywhere a
    // route grants 'technician', 'trainee' is granted too, so a trainee is never
    // locked out of a technician-gated endpoint (my-jobs, clock, etc.). This does
    // NOT grant any office/admin capability — trainee only rides technician's grants.
    const allowed = withOffice.includes("technician") && !withOffice.includes("trainee")
      ? [...withOffice, "trainee"]
      : withOffice;
    if (!allowed.includes(req.auth.role)) {
      res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
      return;
    }
    next();
  };
}
