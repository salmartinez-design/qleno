import type { Request, Response, NextFunction } from "express";

// [preview-isolation 2026-08-20] Every Railway PR preview environment inherits
// the production variable set byte for byte. Verified by hashing the values:
// DATABASE_URL, JWT_SECRET, RESEND_API_KEY, SQUARE_ACCESS_TOKEN,
// STRIPE_SECRET_KEY, TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are IDENTICAL in
// `production`, `qleno-pr-1506` and `qleno-pr-1529`. All of them also carry
// COMMS_ENABLED=true and NODE_ENV=production.
//
// So a preview is not a sandbox. It is a second production server:
//
//   - it writes to the live database
//   - it can charge a real card on the live Stripe and Square keys
//   - it can text and email real customers on the live Twilio and Resend keys
//   - its JWT_SECRET matches production, so a token minted on a preview is
//     accepted by production and the other way round
//   - because NODE_ENV=production, every `if (NODE_ENV === "production")` branch
//     fires there too, including the post-deploy smoke tests
//
// And there is never just one. Thirteen preview environments had live
// deployments on 2026-08-20, which means thirteen extra copies of the customer
// notification cron, the follow-up drip cron, the hourly job-history bridge
// write and the sixty-second QuickBooks sync worker, all running against the
// same live rows on whatever code their branch happens to carry.
//
// The existing [preview-guard 2026-08-03] block in index.ts closed one instance
// of this — the boot data migrations, after a stale preview re-created recurring
// visits the office had deleted. It gated only those migrations. Everything
// listed above stayed open. This module closes the rest.
//
// The rule: PRODUCTION is the only environment allowed to write to production.

export const RAILWAY_ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT ?? null;

/** A real Railway production deploy. */
export const IS_RAILWAY_PRODUCTION = RAILWAY_ENVIRONMENT === "production";

/**
 * A Railway deploy that is NOT production — every `qleno-pr-*` preview.
 *
 * A laptop has no RAILWAY_ENVIRONMENT at all and is deliberately NOT a preview:
 * local behaviour is governed by the separate RUN_STARTUP_MIGRATIONS opt-in and
 * is unchanged by this module.
 */
export const IS_RAILWAY_PREVIEW = RAILWAY_ENVIRONMENT !== null && !IS_RAILWAY_PRODUCTION;

/**
 * Per-environment escape hatch, set in the Railway dashboard on ONE preview when
 * a change genuinely has to be exercised end to end against live data.
 *
 * It re-opens database writes only. The live senders stay dead either way — a
 * preview must never be able to text a customer or charge a card, no matter who
 * is testing what.
 */
export function previewWritesAllowed(): boolean {
  return process.env.PREVIEW_ALLOW_WRITES === "true";
}

/** Background crons and interval workers belong to production alone. */
export function backgroundWorkersAllowed(): boolean {
  return !IS_RAILWAY_PREVIEW;
}

const LIVE_CREDENTIAL_VARS = [
  "RESEND_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
] as const;

/**
 * Delete the live outbound credentials from this process on a preview.
 *
 * Blanking the variable is the neutralizer rather than patching the forty-odd
 * call sites, because every integration in this codebase already reads its key
 * out of process.env at call time and skips when it is missing — that is the
 * documented gating pattern ("inert until all three are set"). One deletion at
 * boot therefore disarms every sender at once, and no future send site can
 * forget to opt in.
 *
 * Returns the names it cleared, for the boot banner.
 */
export function neutralizeLiveCredentials(): string[] {
  if (!IS_RAILWAY_PREVIEW) return [];
  const cleared: string[] = [];
  for (const name of LIVE_CREDENTIAL_VARS) {
    if (process.env[name]) {
      delete process.env[name];
      cleared.push(name);
    }
  }
  return cleared;
}

/**
 * Requests that stay open on a read-only preview.
 *
 * Sign-in has to work or the preview cannot be looked at, which would make the
 * guard something people turn off. Everything here is a session operation on the
 * caller's own row. Password reset, portal invite and social sign-in are
 * deliberately absent: those send mail and change credentials.
 */
const WRITE_ALLOWLIST = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/refresh",
  "/api/auth/switch-company",
  "/api/portal/auth/login",
  "/api/portal/auth/enter",
]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuse anything that could change production data.
 *
 * Mounted ahead of the payment webhook routers on purpose. Those are POSTs from
 * Stripe and Square; only production's URL is subscribed, but a preview must not
 * act on one if it ever arrives.
 */
export function previewReadOnlyGuard(req: Request, res: Response, next: NextFunction): void {
  if (!IS_RAILWAY_PREVIEW || previewWritesAllowed()) return next();
  if (READ_METHODS.has(req.method)) return next();
  if (WRITE_ALLOWLIST.has(req.path)) return next();

  console.warn(`[preview-isolation] blocked ${req.method} ${req.path} — preview env "${RAILWAY_ENVIRONMENT}" is read-only`);
  res.status(503).json({
    error: "Preview environment is read-only",
    message:
      "This is a pull request preview. It shares the production database, so it is not allowed to change data. Use the live app to make changes.",
    environment: RAILWAY_ENVIRONMENT,
  });
}

/** One line in the deploy log saying exactly which posture this process took. */
export function logEnvironmentPosture(clearedCredentials: string[]): void {
  if (IS_RAILWAY_PRODUCTION) {
    console.log("[preview-isolation] environment=production — full write access, workers running");
    return;
  }
  if (!IS_RAILWAY_PREVIEW) {
    console.log("[preview-isolation] no RAILWAY_ENVIRONMENT — local process, guard inactive");
    return;
  }
  const writes = previewWritesAllowed()
    ? "WRITES ALLOWED via PREVIEW_ALLOW_WRITES=true"
    : "read-only (non-GET refused with 503)";
  console.warn(
    `[preview-isolation] environment="${RAILWAY_ENVIRONMENT}" shares the production database — ${writes}; background workers OFF; live senders disarmed${clearedCredentials.length ? ` (${clearedCredentials.join(", ")})` : ""}`,
  );
}
