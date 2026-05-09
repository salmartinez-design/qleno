/**
 * LMS webhook firing — unit tests.
 *
 * Stubs globalThis.fetch so we don't hit the real Make.com endpoint, then
 * asserts the URL/body/headers we'd send. Also confirms behavior when
 * MAKE_LMS_WEBHOOK_URL is unset (no fetch call, no throw).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fireLmsWebhook } from "../lib/lms-helpers.js";

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

let originalFetch: typeof fetch;
let originalEnv: string | undefined;
let calls: Recorded[];

function installFetchStub(response: Partial<Response> & { ok: boolean; status: number }) {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return response as Response;
  }) as typeof fetch;
}

describe("fireLmsWebhook", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = process.env.MAKE_LMS_WEBHOOK_URL;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.MAKE_LMS_WEBHOOK_URL;
    else process.env.MAKE_LMS_WEBHOOK_URL = originalEnv;
  });

  it("skips fetch and does NOT throw when MAKE_LMS_WEBHOOK_URL is unset", async () => {
    delete process.env.MAKE_LMS_WEBHOOK_URL;
    installFetchStub({ ok: true, status: 200 });
    await fireLmsWebhook("module_complete", { module_id: "welcome" });
    assert.equal(calls.length, 0);
  });

  it("POSTs JSON to the configured URL with the event tag in the body", async () => {
    process.env.MAKE_LMS_WEBHOOK_URL = "https://example.test/hook";
    installFetchStub({ ok: true, status: 200 });
    await fireLmsWebhook("module_complete", {
      company_id: 1,
      user_id: 7,
      module_id: "attendance",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.test/hook");
    assert.equal(calls[0].init?.method, "POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.event, "module_complete");
    assert.equal(body.module_id, "attendance");
    assert.equal(body.company_id, 1);
    assert.equal(body.user_id, 7);
  });

  it("uses the all_complete event tag for course completion", async () => {
    process.env.MAKE_LMS_WEBHOOK_URL = "https://example.test/hook";
    installFetchStub({ ok: true, status: 200 });
    await fireLmsWebhook("all_complete", { user_id: 7 });
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.event, "all_complete");
  });

  it("does NOT throw when the webhook returns a non-OK status (logged + swallowed)", async () => {
    process.env.MAKE_LMS_WEBHOOK_URL = "https://example.test/hook";
    installFetchStub({ ok: false, status: 503 });
    // Should not throw — fire-and-forget semantics.
    await fireLmsWebhook("module_complete", { module_id: "welcome" });
    assert.equal(calls.length, 1);
  });

  it("does NOT throw when fetch rejects (network error)", async () => {
    process.env.MAKE_LMS_WEBHOOK_URL = "https://example.test/hook";
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED — simulated network failure");
    }) as typeof fetch;
    // Should not throw — error logged, request succeeds.
    await fireLmsWebhook("module_complete", { module_id: "welcome" });
  });
});
