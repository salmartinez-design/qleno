// Proof-of-life e2e test. Hits /api/healthz and / and asserts the
// stack is up. No auth, no DB seed dependency, no test fixtures —
// this is the "is the workflow even working" smoke test.
//
// If THIS test fails, the failure is in the workflow itself
// (Postgres didn't come up, api-server didn't bind to 5000, vite
// build fell over, etc.) — not in any application code.
//
// Tagged @canary so the runbook's smoke-check step can pull just
// these tests via `--grep @canary`.

import { test, expect } from "@playwright/test";

test.describe("proof-of-life @canary", () => {
  test("GET /api/healthz returns 200", async ({ request }) => {
    const r = await request.get("/api/healthz");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.status).toBe("ok");
  });

  test("GET /api/health responds (200 ok or 503 db-error, both acceptable)", async ({ request }) => {
    // We don't require db=ok here. A 503 with a structured error is
    // still a sign the route + handler work; the cascade tests below
    // are the ones that fail loud if the DB is really broken.
    const r = await request.get("/api/health");
    expect([200, 503]).toContain(r.status());
    const body = await r.json();
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("version");
  });

  test("GET / serves the SPA shell", async ({ request }) => {
    const r = await request.get("/");
    expect(r.status()).toBe(200);
    const text = await r.text();
    // Vite's index.html ships a <div id="root"> mount point.
    expect(text).toContain('id="root"');
  });
});
