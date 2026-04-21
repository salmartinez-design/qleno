import express, { type Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import router from "./routes";
import stripeWebhookRouter from "./routes/stripe-webhook.js";

const __appDir: string =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.set("trust proxy", 1);

app.use(cors());

// ── Stripe Webhook — raw body BEFORE express.json() ─────────────────────────
// Stripe requires the raw request body to validate HMAC signatures.
// Must be registered before express.json() parses the body.
app.use(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookRouter
);

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const uploadsDir = path.resolve(__appDir, "../uploads");
process.env.UPLOADS_DIR = uploadsDir;
app.use("/api/uploads", express.static(uploadsDir, { maxAge: "1d" }));

const pdfsDir = path.resolve(__appDir, "../pdfs");
process.env.PDFS_DIR = pdfsDir;
app.use("/api/pdfs", express.static(pdfsDir, { maxAge: "1h" }));

// ── Rate Limiting ────────────────────────────────────────────────────────────

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again in 15 minutes." },
  skip: (req) => req.path === "/logout" || req.path === "/me",
  keyGenerator: (req: Request): string => {
    // Rate-limit per email on login so one user's failed attempts
    // don't lock out other users on the same IP
    if (req.path === "/login" && req.body?.email) {
      return `login_email_${String(req.body.email).toLowerCase().trim()}`;
    }
    return req.ip ?? "unknown";
  },
  validate: { keyGeneratorIpFallback: false },
});

const userKeyGenerator = (req: Request): string => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const token = authHeader.substring(7);
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
      return `user_${payload.userId}`;
    } catch {}
  }
  return req.ip ?? "unknown";
};

const companyKeyGenerator = (req: Request): string => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const token = authHeader.substring(7);
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
      return `company_${payload.companyId}`;
    } catch {}
  }
  return req.ip ?? "unknown";
};

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded. Please slow down." },
  keyGenerator: userKeyGenerator,
  validate: { keyGeneratorIpFallback: false },
});

const messageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Message limit reached for this hour." },
  keyGenerator: companyKeyGenerator,
  validate: { keyGeneratorIpFallback: false },
});

app.use("/api/auth", authLimiter);
app.use("/api/clients/:id/communications/sms", messageLimiter);
app.use("/api/clients/:id/communications/email", messageLimiter);
app.use("/api/job-sms", messageLimiter);
app.use("/api", generalLimiter);
app.use("/api", router);

// ── Landing Page ────────────────────────────────────────────────────────────
const landingDir = path.resolve(__appDir, "../../../landing");
if (fs.existsSync(landingDir)) {
  app.get("/", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(landingDir, "index.html"));
  });
  app.use("/landing", express.static(landingDir, { maxAge: "10m" }));
  // Serve privacy.html at /privacy
  app.get("/privacy", (_req: Request, res: Response) => {
    res.sendFile(path.join(landingDir, "privacy.html"));
  });
}

// ── Frontend Static Serving ──────────────────────────────────────────────────
const serveFrontend = process.env.NODE_ENV === "production" || process.env.SERVE_FRONTEND === "true";
const frontendDist = path.resolve(__appDir, "../../cleanops-pro/dist/public");
if (serveFrontend && fs.existsSync(frontendDist)) {
  app.use("/assets", express.static(path.join(frontendDist, "assets"), { maxAge: "1y", immutable: true }));
  app.use(express.static(frontendDist, { maxAge: "10m", index: false }));
  app.use((_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(path.join(frontendDist, "index.html"));
  });
} else {
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Route not found" });
  });
}

// ── Global Error Handler ─────────────────────────────────────────────────────
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const timestamp = new Date().toISOString();
  const userId = req.auth?.userId ?? "unauthenticated";
  const companyId = req.auth?.companyId ?? "none";

  console.error(
    `[${timestamp}] ERROR | ${req.method} ${req.path} | user=${userId} company=${companyId}`,
    err
  );

  if (err.code === "23505") {
    return res.status(409).json({ error: "Conflict", message: "A record with this value already exists." });
  }
  if (err.code === "23503") {
    return res.status(400).json({ error: "Bad Request", message: "Referenced record does not exist." });
  }
  if (err.code === "42501") {
    return res.status(403).json({ error: "Forbidden", message: "Permission denied." });
  }

  const isDev = process.env.NODE_ENV !== "production";
  return res.status(500).json({
    error: "Something went wrong. Please try again.",
    ...(isDev ? { detail: err.message } : {}),
  });
});

export default app;
