import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthPayload {
  userId: number;
  companyId: number | null;
  role: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "cleanops-secret-key-change-in-production";

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
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
