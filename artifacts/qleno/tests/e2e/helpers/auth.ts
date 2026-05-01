// [PR #28 / 2026-04-30] Playwright auth helper.
//
// Mints a JWT via the existing POST /api/auth/login endpoint
// (artifacts/api-server/src/routes/auth.ts:13) and stamps it into
// localStorage under the key the frontend reads from
// (artifacts/qleno/src/lib/auth.ts:13 — `qleno_token`). Faster than
// driving the login form: zero rendering, zero key-by-key fill, and
// no flake from autocomplete/password-manager popovers.
//
// Sal explicitly approved using the existing endpoint over a
// test-only mint endpoint. If the login flow ever moves to
// session-cookie auth (no JWT in response body), this helper breaks
// loudly — re-evaluate then; do NOT silently add a test-only
// endpoint per Sal's standing rule on API surface area.
//
// Credentials come from env vars set by GitHub Secrets in CI
// (E2E_TEST_OWNER_EMAIL, E2E_TEST_OWNER_PASSWORD). Local runs
// inherit from the user's shell. We never log the password.

import type { Page, APIRequestContext } from "@playwright/test";

export type Role = "owner" | "admin" | "tech";

const ENV_FOR_ROLE: Record<Role, { emailVar: string; passwordVar: string }> = {
  owner: { emailVar: "E2E_TEST_OWNER_EMAIL",  passwordVar: "E2E_TEST_OWNER_PASSWORD"  },
  admin: { emailVar: "E2E_TEST_ADMIN_EMAIL",  passwordVar: "E2E_TEST_ADMIN_PASSWORD"  },
  tech:  { emailVar: "E2E_TEST_TECH_EMAIL",   passwordVar: "E2E_TEST_TECH_PASSWORD"   },
};

export async function mintToken(
  request: APIRequestContext,
  role: Role,
  emailOverride?: string,
  passwordOverride?: string,
): Promise<{ token: string; userId: number; companyId: number }> {
  const cfg = ENV_FOR_ROLE[role];
  const email    = emailOverride    ?? process.env[cfg.emailVar];
  const password = passwordOverride ?? process.env[cfg.passwordVar];
  if (!email || !password) {
    throw new Error(
      `mintToken: missing credentials for role=${role}. ` +
      `Set ${cfg.emailVar} + ${cfg.passwordVar} (env or GitHub Secrets) ` +
      `or pass overrides.`,
    );
  }
  const r = await request.post("/api/auth/login", {
    data: { email, password },
  });
  if (!r.ok()) {
    const body = await r.text().catch(() => "");
    throw new Error(`mintToken: login failed (${r.status()}): ${body}`);
  }
  const json = await r.json() as { token: string; user: { id: number; company_id: number } };
  return { token: json.token, userId: json.user.id, companyId: json.user.company_id };
}

// Drives a Playwright page into an authenticated state. Navigates
// to baseURL first so localStorage has a same-origin context to
// write to (Playwright won't let us setStorage on about:blank), then
// stamps the token and reloads so the frontend's auth store reads
// it on mount.
export async function loginAs(
  page: Page,
  role: Role = "owner",
  emailOverride?: string,
  passwordOverride?: string,
): Promise<{ token: string; userId: number; companyId: number }> {
  const minted = await mintToken(page.request, role, emailOverride, passwordOverride);
  await page.goto("/");
  await page.evaluate((t) => {
    window.localStorage.setItem("qleno_token", t);
  }, minted.token);
  // Reload so React hydrates with the token in the auth store.
  await page.reload();
  return minted;
}
