import express, { type Express, Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import router from "./routes";
import stripeWebhookRouter from "./routes/stripe-webhook.js";
import squareWebhookRouter from "./routes/square-webhook.js";
import { publicOAuthRouter } from "./routes/oauth.js";
import { resolveShortLink } from "./lib/short-link.js";
import { isAppReady } from "./lib/readiness.js";
import { previewReadOnlyGuard } from "./lib/preview-guard.js";

const __appDir: string =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.set("trust proxy", 1);

app.use(cors());

// ── Preview isolation ───────────────────────────────────────────────────────
// A Railway PR preview carries the production DATABASE_URL, so it is refused
// write access to it. First in the chain, ahead of the payment webhook routers
// below, so nothing can slip past. Inert in production and on a laptop.
// See lib/preview-guard.ts.
app.use(previewReadOnlyGuard);

// ── Stripe Webhook — raw body BEFORE express.json() ─────────────────────────
// Stripe requires the raw request body to validate HMAC signatures.
// Must be registered before express.json() parses the body.
app.use(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  stripeWebhookRouter
);

// ── Square Webhook — raw body BEFORE express.json() ─────────────────────────
// [square-webhook 2026-07-22] Same constraint as Stripe: Square's HMAC covers
// the exact bytes of the body, so a re-serialized object never verifies.
// Read-only reconciler — it credits invoices, it never charges anything.
app.use(
  "/api/square/webhook",
  express.raw({ type: "application/json" }),
  squareWebhookRouter
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

// [ai-access 2026-08-15] Both generators identify the caller by base64-decoding
// a JWT payload. An API key is NOT a JWT — it has no dots and no payload — so
// before this fix every keyed request fell through to req.ip. Consequence: all
// API traffic from one egress IP (a hosted assistant, a Zapier worker, an
// office NAT) shared a single 300/min bucket, so one busy integration throttled
// unrelated tenants, and a per-key limit was impossible to express.
//
// Keys are resolved from the token PREFIX here rather than from req.apiKey,
// because rate limiting runs before authentication — deliberately, so an
// invalid key can't cost a database round-trip per request. The key_id half is
// public and unforgeable-in-practice for limiting purposes: a caller can only
// starve a bucket they can already name, i.e. their own.
const apiKeyBucket = (req: Request, scope: "user" | "company"): string | null => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7);
  if (!token.startsWith("qlno_")) return null;
  // qlno_live_<key_id>_<secret> — take the key_id, never the secret.
  const parts = token.split("_");
  const keyId = parts[2];
  if (!keyId) return "apikey_unparsed";
  // Company-scoped limits can't be resolved without a DB read, so a key falls
  // back to its own bucket there. It is still per-KEY rather than per-IP, which
  // is the bug being fixed; a true per-company API ceiling belongs on the
  // /api/v1 router where the key is already resolved.
  return scope === "company" ? `apikey_co_${keyId}` : `apikey_${keyId}`;
};

const userKeyGenerator = (req: Request): string => {
  const fromKey = apiKeyBucket(req, "user");
  if (fromKey) return fromKey;
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
  const fromKey = apiKeyBucket(req, "company");
  if (fromKey) return fromKey;
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

// ── Readiness gate (2026-06-24) ───────────────────────────────────────────────
// The server binds the port and answers health immediately on boot; the
// migration chain runs in the background AFTER listen (index.ts). Until it
// finishes, hold every non-health /api route at 503 so no request reads or
// writes partially-migrated schema (preserves the 2026-05-17 read/write
// divergence fix). Health stays green so Railway's healthcheck passes the
// instant the port is bound — ending the chronic migrations-before-listen
// deploy-healthcheck failures. Static mounts (/api/uploads, /api/pdfs) are
// matched earlier in the chain, so they're never gated.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (isAppReady()) return next();
  // [favicon 2026-07-07] Gate ONLY /api — the frontend static mount lives
  // BELOW this middleware, so the old all-paths gate 503'd /favicon.svg,
  // /assets/*.js and index.html during every deploy's warm-up window.
  // Chrome caches the failed favicon per tab, which is how the Qleno logo
  // vanished from Sal's tab on a 7-deploy day. Static files don't touch
  // the DB, so they're safe to serve while migrations run.
  // [ai-access-oauth 2026-08-16] /oauth and /.well-known live at the origin
  // ROOT, not under /api, so the prefix test above would wave them through
  // while the tables they read are still being created. They are gated
  // explicitly instead: a discovery document served during warm-up would be
  // cached by the client (max-age 3600) and a token exchange against a missing
  // oauth_grants table would fail the flow at its very last step.
  // Named endpoints, not the whole /oauth prefix: /oauth/consent is a FRONTEND
  // page served by the SPA catch-all, and holding it back during warm-up would
  // answer a tenant mid-approval with a JSON error where the approve screen
  // should be. The four below are the ones that actually read the new tables.
  const isOAuthPath = ["/oauth/register", "/oauth/authorize", "/oauth/token", "/oauth/revoke"].includes(req.path)
    || req.path.startsWith("/.well-known/oauth")
    || req.path === "/.well-known/openid-configuration";
  if (!req.path.startsWith("/api") && !isOAuthPath) return next();
  if (req.path === "/api/health" || req.path === "/api/healthz") return next();
  res.set("Retry-After", "5");
  return res.status(503).json({
    status: "warming_up",
    message: "Server is starting; migrations in progress. Retry shortly.",
  });
});
app.use("/api", router);

// ── OAuth authorization server ───────────────────────────────────────────────
// [ai-access-oauth 2026-08-16] Mounted at the ORIGIN ROOT and ABOVE the SPA
// catch-all — both halves are load-bearing.
//
// Root, because RFC 9728 and RFC 8414 put discovery documents at the root of
// the origin; a client that cannot find them there concludes this server does
// not speak OAuth and shows the tenant no way to connect.
//
// Above the catch-all, because the catch-all answers every unmatched path with
// index.html. A discovery request would get 200 text/html, the client would
// fail to parse it, and the symptom is the confusing one: the MCP server logs
// the first request and the authorization server logs nothing at all.
app.use(publicOAuthRouter);

// ── Short-link redirect ───────────────────────────────────────────────────────
// [sms Pass3] GET /s/:code → 302 to the stored target (the token page). Lets
// customer SMS carry a clean app.qleno.com/s/<code> instead of a long hex token.
// Registered before the landing / SPA so it owns the /s/ path.
app.get("/s/:code", async (req: Request, res: Response) => {
  const code = String(req.params.code || "").trim();
  const target = code ? await resolveShortLink(code) : null;
  if (!target) return res.status(404).send("Link not found or expired.");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  return res.redirect(302, target);
});

// ── Marketing Landing Page ───────────────────────────────────────────────────
// The marketing landing lives at /landing — NOT at the app root. Root "/" is
// intentionally left to fall through to the SPA below so that an unauthenticated
// visitor opening the app (field techs especially) lands on the login screen,
// not the marketing page. The SPA's "/" route redirects unauthenticated users
// to /login and renders the dashboard for authenticated ones.
// Marketing visitors reach the page at /landing; its CTAs link to absolute
// app.qleno.com/login and /register URLs, so they are unaffected by this move.
const landingDir = path.resolve(__appDir, "../../../landing");
if (fs.existsSync(landingDir)) {
  app.use("/landing", express.static(landingDir, { maxAge: "10m" }));
  // Serve privacy.html at /privacy
  app.get("/privacy", (_req: Request, res: Response) => {
    res.sendFile(path.join(landingDir, "privacy.html"));
  });
}

// ── Frontend Static Serving ──────────────────────────────────────────────────
const serveFrontend = process.env.NODE_ENV === "production" || process.env.SERVE_FRONTEND === "true";
const frontendDist = path.resolve(__appDir, "../../qleno/dist/public");
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
