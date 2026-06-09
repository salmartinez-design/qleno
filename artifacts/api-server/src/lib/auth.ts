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

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });
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
    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
      return;
    }
    next();
  };
}
