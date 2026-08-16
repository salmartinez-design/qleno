import type { Request, Response } from "express";

// [ai-access 2026-08-15] The per-COMPANY ceiling for Qleno Connect.
//
// WHY THIS EXISTS SEPARATELY FROM generalLimiter:
//   app.ts already rate-limits every /api request, and for an API key it buckets
//   by key id — 300 requests a minute each. That fixed the per-IP problem it was
//   written for, and its own comment says the real per-company ceiling "belongs
//   on the /api/v1 router where the key is already resolved". This is that.
//
//   Per-key alone is not a tenant ceiling: a tenant who mints ten keys gets ten
//   times the allowance, and this is a shared server. One tenant pointing an
//   agent at a paging loop should degrade THEIR API, not Phes's dispatch board.
//   The per-key limit is still the first thing a runaway single integration
//   hits; this is the backstop on the sum.
//
// The window is fixed rather than sliding, and the counter is in this process's
// memory. Both match what express-rate-limit is already doing for the rest of
// the app, so the behaviour is consistent across the two limiters. The honest
// limitation: if the API server is ever scaled to more than one instance, each
// instance counts on its own and the effective ceiling multiplies by the
// instance count. That is a real gap, it is not a security control (the auth
// gates are), and the fix is a shared store — noted here so it is found rather
// than rediscovered.

/**
 * Requests per minute per company, summed across every key that company holds.
 *
 * Sized against what the API is for, not against a round number. An assistant
 * answering a question makes single-digit calls; paging a year of jobs at the
 * 200-row maximum is about 35. 600/min leaves a tenant room to run several
 * integrations and a person asking questions at the same time, and still stops
 * a loop from consuming the server. Raise it deliberately, per tenant, if a real
 * integration ever needs more — do not raise it because one loop hit it.
 */
export const COMPANY_REQUESTS_PER_MINUTE = 600;

const WINDOW_MS = 60_000;

type Bucket = { count: number; resetAt: number };

const buckets = new Map<number, Bucket>();

/**
 * Drop windows that have already expired.
 *
 * The map is keyed by company, so it is bounded by the number of tenants who
 * have ever called — small, and not a leak in any realistic sense. The sweep is
 * here so that stays true if Qleno ever has thousands of tenants, and it runs on
 * a counter rather than a timer so it cannot hold the process open.
 */
let callsSinceSweep = 0;
function maybeSweep(now: number): void {
  if (++callsSinceSweep < 1000) return;
  callsSinceSweep = 0;
  for (const [companyId, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(companyId);
  }
}

export type CeilingResult =
  | { allowed: true; remaining: number; resetAt: number }
  | { allowed: false; retryAfterSec: number; resetAt: number };

/** Count one request against the company's window and say whether it may proceed. */
export function consumeCompanyQuota(companyId: number, now = Date.now()): CeilingResult {
  maybeSweep(now);

  let b = buckets.get(companyId);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(companyId, b);
  }

  b.count++;
  if (b.count > COMPANY_REQUESTS_PER_MINUTE) {
    return {
      allowed: false,
      // Always at least a second: a Retry-After of 0 invites an immediate retry,
      // which is the behaviour being throttled in the first place.
      retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
      resetAt: b.resetAt,
    };
  }
  return { allowed: true, remaining: COMPANY_REQUESTS_PER_MINUTE - b.count, resetAt: b.resetAt };
}

/**
 * Apply the ceiling, writing the standard headers either way.
 *
 * Returns true if the request was rejected, so the caller can stop. Headers are
 * set on success too — a client that only learns its budget by exceeding it
 * cannot pace itself, and pacing is the entire point.
 */
export function enforceCompanyCeiling(req: Request, res: Response): boolean {
  const companyId = req.auth?.companyId;
  if (!companyId) return false;

  const result = consumeCompanyQuota(companyId);
  const resetSec = Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000));

  res.setHeader("RateLimit-Limit", String(COMPANY_REQUESTS_PER_MINUTE));
  res.setHeader("RateLimit-Remaining", String(result.allowed ? result.remaining : 0));
  res.setHeader("RateLimit-Reset", String(resetSec));

  if (result.allowed) return false;

  res.setHeader("Retry-After", String(result.retryAfterSec));
  // Says WHOSE limit was hit and that it is shared across the tenant's keys,
  // because the caller's first instinct on a 429 is to mint another key — which
  // would not help and is worth saying before they try it.
  res.status(429).json({
    error: "rate_limited",
    message:
      `This company has exceeded ${COMPANY_REQUESTS_PER_MINUTE} API requests per minute. ` +
      `The limit is shared across all of the company's API keys, so creating another key will not raise it. ` +
      `Retry in ${result.retryAfterSec}s.`,
    limit: COMPANY_REQUESTS_PER_MINUTE,
    window_seconds: 60,
    retry_after_seconds: result.retryAfterSec,
  });
  return true;
}

/** Test seam. Never called by shipped code. */
export function __resetCompanyQuotas(): void {
  buckets.clear();
  callsSinceSweep = 0;
}
