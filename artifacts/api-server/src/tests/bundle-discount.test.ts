/**
 * Bundle Discount Integration Tests — "Oven + Refrigerator Combo"
 *
 * Coverage:
 *   - /api/public/calculate  (unauthenticated, used by booking widget)
 *   - /api/pricing/calculate (JWT-authenticated, used by internal quote builder)
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:bundle
 *
 * Prerequisites:
 *   API server must be running on the port specified by TEST_API_BASE
 *   (defaults to http://localhost:8080). The test self-authenticates via
 *   /api/auth/login using the demo company credentials below.
 *
 * Data constants:
 *   company_id = 1  (PHES Cleaning)
 *   Addon 8  = Oven Cleaning   ($60 flat)
 *   Addon 10 = Refrigerator Cleaning ($60 flat)
 *   Bundle "Oven + Refrigerator Combo" → flat_total $20 discount
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

const API_BASE = process.env.TEST_API_BASE ?? "http://localhost:8080";
const LOGIN_EMAIL = process.env.TEST_LOGIN_EMAIL ?? "salmartinez@phes.io";
const LOGIN_PASSWORD = process.env.TEST_LOGIN_PASSWORD ?? "phes1234";

const COMPANY_ID = 1;
const SCOPE_DEEP_CLEAN = 1;
const SCOPE_STANDARD_CLEAN = 3;
const SCOPE_RECURRING_WEEKLY = 4;
const SCOPE_MOVE_IN_OUT = 12;
const ADDON_OVEN = 8;
const ADDON_FRIDGE = 10;
const ADDON_EXTRA = 9;
const EXPECTED_BUNDLE_DISCOUNT = 20;

let authToken = "";

async function publicCalculate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/api/public/calculate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `Expected 200 but got ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function internalCalculate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/api/pricing/calculate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `Expected 200 but got ${res.status} — token may be expired`);
  return res.json() as Promise<Record<string, unknown>>;
}

function assertBundleApplied(result: Record<string, unknown>, label: string): void {
  assert.equal(result.bundle_discount, EXPECTED_BUNDLE_DISCOUNT, `${label}: bundle_discount must be 20`);
  const breakdown = result.bundle_breakdown as Array<{ name: string; discount: number }>;
  assert.ok(Array.isArray(breakdown) && breakdown.length > 0, `${label}: bundle_breakdown must be non-empty`);
  assert.ok(
    breakdown.some((b) => b.name === "Oven + Refrigerator Combo" && b.discount === EXPECTED_BUNDLE_DISCOUNT),
    `${label}: bundle_breakdown must include Oven + Refrigerator Combo with discount=20`
  );
}

describe("Oven + Refrigerator Bundle Discount", () => {
  before(async () => {
    const health = await fetch(`${API_BASE}/api/public/company/phes-cleaning`);
    assert.equal(health.status, 200, "API must be running and reachable");

    const loginRes = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    });
    assert.equal(loginRes.status, 200, "Login must succeed to test internal pricing endpoint");
    const loginData = (await loginRes.json()) as { token: string };
    authToken = loginData.token;
    assert.ok(authToken, "Auth token must be present after login");
  });

  describe("/api/public/calculate — booking widget endpoint (unauthenticated)", () => {
    it("Test 1 [public]: Deep Clean — Oven first [8,10] → bundle_discount=20 with breakdown", async () => {
      const result = await publicCalculate({
        company_id: COMPANY_ID,
        scope_id: SCOPE_DEEP_CLEAN,
        sqft: 1500,
        frequency: "onetime",
        addon_ids: [ADDON_OVEN, ADDON_FRIDGE],
      });
      assertBundleApplied(result, "Test 1");
    });

    it("Test 2 [public]: Deep Clean — Fridge first [10,8] → bundle_discount=20 (order-independent)", async () => {
      const result = await publicCalculate({
        company_id: COMPANY_ID,
        scope_id: SCOPE_DEEP_CLEAN,
        sqft: 1500,
        frequency: "onetime",
        addon_ids: [ADDON_FRIDGE, ADDON_OVEN],
      });
      assert.equal(result.bundle_discount, EXPECTED_BUNDLE_DISCOUNT, "bundle_discount must be 20 regardless of order");
    });

    it("Test 3 [public]: Standard Clean scope — bundle fires on different scope", async () => {
      const result = await publicCalculate({
        company_id: COMPANY_ID,
        scope_id: SCOPE_STANDARD_CLEAN,
        sqft: 1500,
        frequency: "onetime",
        addon_ids: [ADDON_OVEN, ADDON_FRIDGE],
      });
      assert.equal(result.bundle_discount, EXPECTED_BUNDLE_DISCOUNT, "bundle_discount must be 20 for Standard Clean");
    });

    it("Test 4 [public]: Move In/Out scope — bundle fires for move-in/out jobs", async () => {
      const result = await publicCalculate({
        company_id: COMPANY_ID,
        scope_id: SCOPE_MOVE_IN_OUT,
        sqft: 1500,
        frequency: "onetime",
        addon_ids: [ADDON_OVEN, ADDON_FRIDGE],
      });
      assert.equal(result.bundle_discount, EXPECTED_BUNDLE_DISCOUNT, "bundle_discount must be 20 for Move In/Out");
    });

    it("Test 5 [public]: Recurring Weekly — bundle fires for recurring subscriptions", async () => {
      const result = await publicCalculate({
        company_id: COMPANY_ID,
        scope_id: SCOPE_RECURRING_WEEKLY,
        sqft: 1500,
        frequency: "weekly",
        addon_ids: [ADDON_OVEN, ADDON_FRIDGE],
      });
      assert.equal(result.bundle_discount, EXPECTED_BUNDLE_DISCOUNT, "bundle_discount must be 20 for Recurring Weekly");
    });

    it("Test 6 [public]: Extra add-on alongside Oven+Fridge does not block discount", async () => {
      const result = await publicCalculate({
        company_id: COMPANY_ID,
        scope_id: SCOPE_DEEP_CLEAN,
        sqft: 1500,
        frequency: "onetime",
        addon_ids: [ADDON_OVEN, ADDON_EXTRA, ADDON_FRIDGE],
      });
      assert.equal(result.bundle_discount, EXPECTED_BUNDLE_DISCOUNT, "bundle_discount must be 20 with extra add-on");
    });

    it("Test 7 [public]: Only Oven selected → no bundle discount (negative case)", async () => {
      const result = await publicCalculate({
        company_id: COMPANY_ID,
        scope_id: SCOPE_DEEP_CLEAN,
        sqft: 1500,
        frequency: "onetime",
        addon_ids: [ADDON_OVEN],
      });
      assert.equal(result.bundle_discount, 0, "bundle_discount must be 0 when only Oven is selected");
    });

    it("Test 8 [public]: Only Fridge selected → no bundle discount (negative case)", async () => {
      const result = await publicCalculate({
        company_id: COMPANY_ID,
        scope_id: SCOPE_DEEP_CLEAN,
        sqft: 1500,
        frequency: "onetime",
        addon_ids: [ADDON_FRIDGE],
      });
      assert.equal(result.bundle_discount, 0, "bundle_discount must be 0 when only Fridge is selected");
    });
  });

  describe("/api/pricing/calculate — internal quote builder endpoint (JWT-authenticated)", () => {
    it("Test 9 [internal]: Deep Clean — Oven+Fridge → bundle_discount=20 via authenticated endpoint", async () => {
      const result = await internalCalculate({
        scope_id: SCOPE_DEEP_CLEAN,
        sqft: 1500,
        frequency: "onetime",
        addon_ids: [ADDON_OVEN, ADDON_FRIDGE],
      });
      assertBundleApplied(result, "Test 9");
    });

    it("Test 10 [internal]: Deep Clean — Fridge first [10,8] → bundle_discount=20 (order-independent, internal)", async () => {
      const result = await internalCalculate({
        scope_id: SCOPE_DEEP_CLEAN,
        sqft: 1500,
        frequency: "onetime",
        addon_ids: [ADDON_FRIDGE, ADDON_OVEN],
      });
      assert.equal(result.bundle_discount, EXPECTED_BUNDLE_DISCOUNT, "internal endpoint: bundle_discount must be 20 regardless of order");
    });
  });
});
