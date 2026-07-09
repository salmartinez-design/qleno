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

const JWT_SECRET = process.env.JWT_SECRET || "cleanops-secret-key-change-in-production";

// Loud boot warning when JWT_SECRET is unset. Running on the fallback default
// is the single most common cause of "login works, then instantly logs out":
// if JWT_SECRET is later set (or differs across replicas / mid-rollout), every
// token signed under one secret fails verification under the other, so /me
// 401s on a token login just issued. Surfacing this at boot makes the root
// cause visible instead of silently shipping on the shared default.
if (!process.env.JWT_SECRET) {
  console.warn(
    "[auth] WARNING: JWT_SECRET is not set — using the insecure built-in default. " +
      "Set a single stable JWT_SECRET in the environment (identical across all replicas) " +
      "to avoid token-verification failures and login-loop logouts.",
  );
}

// [tech-session 2026-06-30] 30-day login lifetime so field techs who keep the
// app pinned aren't silently logged out after a day (the "No jobs today" /
// reinstall-to-fix complaint). The frontend slides this forward on every app
// open (startTokenRefresh), so an active tech effectively never re-logs in; a
// truly stale (30-day-idle) pass routes to the login screen, never a blank
// screen. Trade-off: no server-side revocation yet — a lost/offboarded device
// stays valid until expiry. Add a revocation list as the proper follow-up.
export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
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
  try {
    const payload = verifyToken(token);
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
    const allowed = roles.includes("admin") ? [...roles, "office"] : roles;
    if (!allowed.includes(req.auth.role)) {
      res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
      return;
    }
    next();
  };
}
