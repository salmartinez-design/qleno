// [ai-access 2026-08-15] The per-company API ceiling.
//
// WHY THIS FILE EXISTS
// --------------------
// Qleno Connect is a shared server. Every tenant's API traffic runs through the
// same process that serves Phes's dispatch board, so "one tenant cannot degrade
// another" is a property of the product, not a nicety — and it is a property
// that fails silently. A limiter keyed by the wrong thing still returns 200s and
// still looks correct in every manual test; it only shows up when a second
// tenant is busy, which is exactly when nobody is reading logs.
//
// The specific mistake this guards against: bucketing by KEY. That reads as
// rate limiting, passes a single-key test, and gives a tenant with ten keys ten
// times the allowance. Case 3 is the one that would catch it — it asserts that
// exhausting one company's budget leaves another company's budget untouched,
// and it would equally fail if the bucket were ever keyed by something the
// CALLER controls.
//
// Run:
//   tsx --test src/tests/api-company-ceiling.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  consumeCompanyQuota,
  enforceCompanyCeiling,
  __resetCompanyQuotas,
  COMPANY_REQUESTS_PER_MINUTE as LIMIT,
} from "../lib/api-rate-limit.js";

/** Minimal req/res doubles. The limiter touches only auth, headers, status, json. */
function fake(companyId: number | undefined) {
  const headers: Record<string, string> = {};
  let status = 200;
  let body: any = null;
  const req = { auth: companyId === undefined ? undefined : { companyId } } as unknown as Request;
  const res = {
    setHeader(k: string, v: string) { headers[k] = v; },
    status(c: number) { status = c; return this; },
    json(b: any) { body = b; return this; },
  } as unknown as Response;
  return { req, res, headers, get: () => ({ status, body }) };
}

test("a request under the ceiling is allowed and reports what is left", () => {
  __resetCompanyQuotas();
  const first = consumeCompanyQuota(1);
  assert.equal(first.allowed, true);
  assert.equal(first.allowed && first.remaining, LIMIT - 1);
});

test("the request that crosses the ceiling is refused, and the ones after it stay refused", () => {
  __resetCompanyQuotas();
  for (let i = 0; i < LIMIT; i++) {
    assert.equal(consumeCompanyQuota(1).allowed, true, `request ${i + 1} should be allowed`);
  }
  assert.equal(consumeCompanyQuota(1).allowed, false, "the request past the ceiling must be refused");
  assert.equal(consumeCompanyQuota(1).allowed, false, "and it must not recover within the window");
});

test("one company exhausting its budget does not touch another company's", () => {
  // The whole reason the limiter is keyed by company rather than by key: a
  // runaway agent at one tenant must not throttle anybody else's dispatch board.
  __resetCompanyQuotas();
  for (let i = 0; i <= LIMIT; i++) consumeCompanyQuota(1);
  assert.equal(consumeCompanyQuota(1).allowed, false, "company 1 is over");

  const other = consumeCompanyQuota(2);
  assert.equal(other.allowed, true, "company 2 must be unaffected");
  assert.equal(other.allowed && other.remaining, LIMIT - 1, "and must start from a full budget");
});

test("the budget is shared across every key the company holds", () => {
  // consumeCompanyQuota takes no key id by design. If a key ever became part of
  // the bucket identity, this count would not add up across the two calls, and a
  // tenant could raise their own ceiling by minting keys.
  __resetCompanyQuotas();
  for (let i = 0; i < LIMIT - 1; i++) consumeCompanyQuota(7); // "key A"
  const viaSecondKey = consumeCompanyQuota(7);               // "key B", same company
  assert.equal(viaSecondKey.allowed, true);
  assert.equal(viaSecondKey.allowed && viaSecondKey.remaining, 0, "the last unit of a shared budget");
  assert.equal(consumeCompanyQuota(7).allowed, false, "a second key does not buy more headroom");
});

test("the window rolls over and the budget comes back", () => {
  __resetCompanyQuotas();
  const t0 = 1_000_000;
  for (let i = 0; i <= LIMIT; i++) consumeCompanyQuota(1, t0);
  assert.equal(consumeCompanyQuota(1, t0).allowed, false);

  // Just inside the window: still refused. One minute on: clear.
  assert.equal(consumeCompanyQuota(1, t0 + 59_000).allowed, false, "59s in, still over");
  assert.equal(consumeCompanyQuota(1, t0 + 60_001).allowed, true, "past the window, recovered");
});

test("a refused request answers 429 in this API's own vocabulary", () => {
  __resetCompanyQuotas();
  for (let i = 0; i <= LIMIT; i++) consumeCompanyQuota(1);

  const f = fake(1);
  const stopped = enforceCompanyCeiling(f.req, f.res);
  const { status, body } = f.get();

  assert.equal(stopped, true, "the caller must stop rather than run the handler");
  assert.equal(status, 429);
  assert.equal(body.error, "rate_limited");
  assert.equal(body.limit, LIMIT);
  assert.equal(body.window_seconds, 60);
  assert.ok(body.retry_after_seconds >= 1, "Retry-After of 0 would invite an instant retry");
  // The message has to head off the obvious wrong fix, which is minting a key.
  assert.match(body.message, /another key will not raise it/);
  assert.ok(f.headers["Retry-After"], "Retry-After header is what a well-behaved client reads");
  assert.equal(f.headers["RateLimit-Remaining"], "0");
});

test("an allowed request still publishes the budget headers", () => {
  // A client that only learns its budget by exceeding it cannot pace itself.
  __resetCompanyQuotas();
  const f = fake(1);
  const stopped = enforceCompanyCeiling(f.req, f.res);

  assert.equal(stopped, false);
  assert.equal(f.get().status, 200, "nothing is written on the success path");
  assert.equal(f.headers["RateLimit-Limit"], String(LIMIT));
  assert.equal(f.headers["RateLimit-Remaining"], String(LIMIT - 1));
  assert.ok(f.headers["RateLimit-Reset"] !== undefined);
});

test("no resolved company means no counting, and no crash", () => {
  // requireApiKey rejects before this point, so this path should be unreachable.
  // It is asserted anyway: the failure mode of guessing a company id here would
  // be charging one tenant's budget for another's traffic.
  __resetCompanyQuotas();
  const f = fake(undefined);
  assert.equal(enforceCompanyCeiling(f.req, f.res), false);
  assert.equal(f.headers["RateLimit-Limit"], undefined, "nothing was counted, so nothing is reported");
});
