import { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { apiRequestLogTable } from "@workspace/db/schema";
import {
  verifyApiKey, touchApiKey, looksLikeApiKey,
  type ApiScope, type VerifyFailure,
} from "./api-keys.js";
import { enforceCompanyCeiling } from "./api-rate-limit.js";

// [ai-access 2026-08-15] The front door for Qleno Connect (/api/v1) and Qleno
// Agent (/mcp). Design: docs/AI_ACCESS_DESIGN.md §2–§3.
//
// WHY THIS IS A SEPARATE MIDDLEWARE FROM requireAuth:
//   It would be less code to resolve API keys inside requireAuth — the key
//   would land in req.auth and every one of the 954 internal routes would
//   accept it for free. That is exactly why we don't. Those routes are internal
//   plumbing whose shapes change weekly; admitting a key to all of them would
//   freeze every one into a permanent public contract and make the blast radius
//   of any auth mistake 954 endpoints instead of the ~25 we deliberately
//   publish. requireAuth REJECTS qlno_ tokens outright (see auth.ts); a key
//   only ever authenticates routes mounted behind this middleware.

declare global {
  namespace Express {
    interface Request {
      apiKey?: {
        keyId: number;
        name: string;
        scopes: ApiScope[];
        kind: "rest" | "mcp";
      };
    }
  }
}

// Failure reasons are mapped to a deliberately small set of caller-facing
// messages. "not_found" and "bad_secret" both say the same thing: telling an
// attacker which half of the token was wrong is free help.
const FAILURE_RESPONSE: Record<VerifyFailure, { status: number; message: string }> = {
  malformed: { status: 401, message: "Malformed API key" },
  not_found: { status: 401, message: "Invalid API key" },
  bad_secret: { status: 401, message: "Invalid API key" },
  revoked: { status: 401, message: "This API key has been revoked" },
  expired: { status: 401, message: "This API key has expired" },
  user_inactive: { status: 403, message: "The user this key belongs to is no longer active" },
  role_forbidden: { status: 403, message: "This user's role cannot hold an API key" },
  company_disabled: { status: 403, message: "API access is not enabled for this company" },
};

// ── Internal in-process dispatch ─────────────────────────────────────────────
// The MCP server answers its tools by calling the v1 router directly rather than
// duplicating its SQL (see lib/mcp-dispatch.ts). Those synthetic requests carry
// an identity that this very middleware already verified microseconds earlier at
// the /api/mcp door, on the same real HTTP request.
//
// Re-verifying them would cost a database round-trip per tool call and would
// charge the tenant's rate ceiling twice for one call — the second charge
// invisible to the operator, who would see a 429 after half the traffic they
// expected. So the internal path skips the door and checks scopes only.
//
// This marker cannot be set from the wire. Express builds `req` from the socket
// and there is no header, query parameter, or body field that becomes a symbol
// property; the only writer is markInternalDispatch(), which is only reachable
// from code that has already been through the door. It is a Symbol rather than a
// string key specifically so a `req[userSuppliedKey] = true` bug anywhere in the
// codebase cannot collide with it.
const INTERNAL_DISPATCH = Symbol("qleno.internalDispatch");

/** Stamp a synthetic request as already-authenticated. Only lib/mcp-dispatch.ts calls this. */
export function markInternalDispatch(req: Request): void {
  (req as any)[INTERNAL_DISPATCH] = true;
}

/**
 * Authenticate an API key and require every listed scope.
 *
 * The key's scopes are only one of three gates. The company's api_access_enabled
 * switch and the live role of the key's owner are both checked inside
 * verifyApiKey() on every request, so deactivating a user or flipping the
 * company switch kills their keys immediately — no cache, no token lifetime to
 * wait out.
 */
export function requireApiKey(kind: "rest" | "mcp", ...scopes: ApiScope[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Already through the door on this same HTTP request — see INTERNAL_DISPATCH
    // above. Scopes are still enforced: the MCP layer checks the scope it thinks
    // a tool needs, and this checks the scope the endpoint actually requires. If
    // a tool is ever pointed at the wrong path, that mismatch is caught here
    // rather than silently granting reach the key was not given.
    if ((req as any)[INTERNAL_DISPATCH] === true && req.apiKey && req.auth) {
      const short = scopes.filter((s) => !req.apiKey!.scopes.includes(s));
      if (short.length > 0) {
        res.status(403).json({
          error: "insufficient_scope",
          message: `This key is missing the ${short.join(", ")} scope.`,
          required: scopes,
          granted: req.apiKey.scopes,
        });
        return;
      }
      next();
      return;
    }

    const header = req.headers.authorization;
    const raw = header?.startsWith("Bearer ") ? header.substring(7) : undefined;

    if (!raw) {
      res.status(401).json({ error: "unauthorized", message: "Provide an API key as: Authorization: Bearer qlno_live_…" });
      return;
    }

    // A login JWT is not a machine credential. Rejecting it here is the mirror
    // of requireAuth rejecting qlno_ tokens: each front door accepts exactly one
    // credential type, so neither can be reached by accident with the other.
    if (!looksLikeApiKey(raw)) {
      res.status(401).json({
        error: "unauthorized",
        message: "This endpoint requires an API key, not a login session. Create one under Settings → AI & API Access.",
      });
      return;
    }

    let result;
    try {
      result = await verifyApiKey(raw);
    } catch (err) {
      console.error("[api-auth] verify failed", err);
      res.status(503).json({ error: "unavailable", message: "Could not verify credentials" });
      return;
    }

    if (!result.ok) {
      const { status, message } = FAILURE_RESPONSE[result.reason];
      res.status(status).json({ error: status === 401 ? "unauthorized" : "forbidden", message });
      return;
    }

    const key = result.key;
    const missing = scopes.filter((s) => !key.scopes.includes(s));
    if (missing.length > 0) {
      res.status(403).json({
        error: "insufficient_scope",
        message: `This key is missing the ${missing.join(", ")} scope. Edit the key under Settings → AI & API Access.`,
        required: scopes,
        granted: key.scopes,
      });
      return;
    }

    // The key acts as its owner. Downstream handlers read req.auth exactly as
    // they would for a logged-in user, so company scoping, role checks, and
    // audit attribution all work unchanged — company_id always comes from here,
    // never from anything the caller sent.
    req.auth = {
      userId: key.userId,
      companyId: key.companyId,
      role: key.role,
      email: key.email,
      first_name: key.first_name,
    };
    req.apiKey = { keyId: key.keyId, name: key.name, scopes: key.scopes, kind };

    // The tenant-wide ceiling, checked AFTER the identity above is attached and
    // BEFORE any handler runs. The order is deliberate in both directions: the
    // limiter needs the company, which only exists once the key has resolved,
    // and attaching identity first means a throttled request still lands in the
    // tenant's own activity log. A 429 that is invisible to the operator being
    // throttled is the one thing worse than the throttle.
    if (enforceCompanyCeiling(req, res)) return;

    touchApiKey(key.keyId, req.ip);
    next();
  };
}

/**
 * Record one API/MCP call. Mounted before the route so it can time the response.
 *
 * Deliberately stores no request or response BODIES — see the schema comment on
 * api_request_log. This table would otherwise become the largest uncontrolled
 * store of customer PII in the system. `arg_digest` keeps shape only: which
 * filters were used and how many rows came back, enough to debug an integration
 * and never enough to reconstruct a customer record.
 */
export function logApiRequest(kind: "rest" | "mcp") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = Date.now();

    res.on("finish", () => {
      const key = req.apiKey;
      const companyId = req.auth?.companyId;
      // No key resolved (401 at the door) means no tenant to attribute this to.
      // Those are rate-limited by IP and don't belong in a tenant's activity view.
      if (!key || !companyId) return;

      // Route PATTERN, never the raw path: /api/v1/jobs/:id, not /api/v1/jobs/20810.
      // Raw paths carry record ids, which would turn this log into a browsing
      // history of the tenant's own customers.
      const route = kind === "mcp"
        ? String((req as any).mcpToolName ?? "unknown")
        : `${req.baseUrl}${req.route?.path ?? ""}` || req.path;

      db.insert(apiRequestLogTable).values({
        company_id: companyId,
        api_key_id: key.keyId,
        user_id: req.auth?.userId ?? null,
        kind,
        route,
        method: req.method,
        status: res.statusCode,
        duration_ms: Date.now() - started,
        bytes_out: Number(res.getHeader("content-length") ?? 0) || null,
        ip: req.ip ?? null,
        user_agent: req.headers["user-agent"]?.slice(0, 500) ?? null,
        arg_digest: {
          // Names of the filters used, not their values.
          query_keys: Object.keys(req.query ?? {}).sort(),
          body_keys: req.method === "GET" ? [] : Object.keys(req.body ?? {}).sort(),
          result_count: (res as any).qlenoResultCount ?? null,
          confirmed: (req.body as any)?.confirm === true ? true : null,
        },
      }).catch((err) => {
        // Never fail the caller's request over a logging write — but never
        // swallow it either. A silently-broken audit log is worse than none,
        // because it reads as "nothing happened".
        console.error("[api-auth] request log write failed", err);
      });
    });

    next();
  };
}
