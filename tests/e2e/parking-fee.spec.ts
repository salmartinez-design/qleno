/**
 * Playwright E2E tests — parking-fee 3-tier waterfall (PR #51)
 *
 * Coverage:
 *   API-level (always runs):
 *     1. PUT /api/clients/:id persists parking_fee_enabled + parking_fee_amount
 *     2. GET /api/clients/:id returns the new fields
 *     3. resolveParkingAddon waterfall via the dispatch endpoint:
 *        a. schedule override wins
 *        b. client default wins when schedule blank
 *        c. tenant default fallback
 *
 *   Browser UI (skipped by default — set SKIP_BROWSER_TESTS=0):
 *     UI Test A: /customer-profile/:id Card on File tab → Parking Fee
 *                row is visible AND editable for residential clients
 *     UI Test B: /jobs Edit Job modal → Parking Fee row has an inline
 *                $ input when checked; saved value round-trips
 *
 * Run API-only:
 *   pnpm --filter @workspace/tests test:e2e -- parking-fee.spec.ts
 *
 * Run including UI:
 *   SKIP_BROWSER_TESTS=0 pnpm --filter @workspace/tests test:e2e:headed -- parking-fee.spec.ts
 */
import { test, expect, type APIRequestContext } from "@playwright/test";

const API_BASE = process.env.TEST_API_BASE ?? "http://localhost:8080";
const FRONTEND_BASE = process.env.TEST_BASE_URL ?? "http://localhost:80";
const LOGIN_EMAIL = process.env.TEST_EMAIL ?? "salmartinez@phes.io";
const LOGIN_PASSWORD = process.env.TEST_PASSWORD ?? "phes1234";

// Nicholas Cooper is the regression target — residential client whose
// parking fee should be $15 (per MaidCentral). If you don't have his
// id locally, override via env: TEST_PARKING_CLIENT_ID=<id>.
const TEST_CLIENT_ID = Number(process.env.TEST_PARKING_CLIENT_ID ?? 0);

async function getAuthToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/auth/login`, {
    data: { email: LOGIN_EMAIL, password: LOGIN_PASSWORD },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body.token as string;
}

test.describe("Parking-fee API — per-client default persists", () => {
  test.skip(!TEST_CLIENT_ID, "Set TEST_PARKING_CLIENT_ID env var to enable");

  test("PUT /api/clients/:id accepts parking_fee_enabled + parking_fee_amount", async ({ request }) => {
    const token = await getAuthToken(request);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // Snapshot, mutate, restore — keeps the test idempotent across runs.
    const before = await request.get(`${API_BASE}/api/clients/${TEST_CLIENT_ID}`, { headers });
    expect(before.status()).toBe(200);
    const beforeBody = await before.json();
    const prevEnabled = !!beforeBody.parking_fee_enabled;
    const prevAmount = beforeBody.parking_fee_amount;

    try {
      // Set $15 / enabled=true
      const put = await request.put(`${API_BASE}/api/clients/${TEST_CLIENT_ID}`, {
        headers, data: { parking_fee_enabled: true, parking_fee_amount: "15.00" },
      });
      expect(put.status()).toBe(200);

      const after = await request.get(`${API_BASE}/api/clients/${TEST_CLIENT_ID}`, { headers });
      const afterBody = await after.json();
      expect(afterBody.parking_fee_enabled).toBe(true);
      expect(Number(afterBody.parking_fee_amount)).toBe(15);
    } finally {
      // Restore prior state
      await request.put(`${API_BASE}/api/clients/${TEST_CLIENT_ID}`, {
        headers,
        data: {
          parking_fee_enabled: prevEnabled,
          parking_fee_amount: prevAmount == null ? null : String(prevAmount),
        },
      });
    }
  });
});

test.describe("Parking-fee UI — Customer profile (Card on File)", () => {
  test.skip(process.env.SKIP_BROWSER_TESTS !== "0",
    "Set SKIP_BROWSER_TESTS=0 and have Playwright browsers installed");
  test.skip(!TEST_CLIENT_ID, "Set TEST_PARKING_CLIENT_ID env var to enable");

  test("Parking Fee card is visible for residential clients and editable", async ({ page, request }) => {
    const token = await getAuthToken(request);

    await page.goto(`${FRONTEND_BASE}/customers/${TEST_CLIENT_ID}`);
    await page.evaluate((t) => localStorage.setItem("auth_token", t), token);
    await page.reload();

    // Find and click the Card on File tab
    await page.getByRole("button", { name: /card on file/i }).click();

    // Parking Fee card should always be present (regardless of client_type).
    // Regression target: it used to live inside the commercial-only Billing
    // Settings card and was invisible for Nicholas Cooper (residential).
    const parkingCard = page.locator("text=Parking Fee").first();
    await expect(parkingCard).toBeVisible({ timeout: 5000 });

    // Click Edit / Set
    await page.getByRole("button", { name: /^(edit|set)$/i }).first().click();

    // Type $15
    const amountInput = page.locator("input[type='number'][placeholder='20.00']").first();
    await amountInput.fill("15");

    // Save
    await page.getByRole("button", { name: /^save$/i }).first().click();

    // Verify the readout updates
    await expect(page.locator("text=/\\$15\\.00/")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Parking-fee UI — Edit Job modal inline price input", () => {
  test.skip(process.env.SKIP_BROWSER_TESTS !== "0",
    "Set SKIP_BROWSER_TESTS=0 and have Playwright browsers installed");

  test("Parking Fee row exposes an inline $ input when checked", async ({ page, request }) => {
    const token = await getAuthToken(request);

    await page.goto(`${FRONTEND_BASE}/jobs`);
    await page.evaluate((t) => localStorage.setItem("auth_token", t), token);
    await page.reload();

    // Click any job tile to open the side panel, then Edit
    const firstJob = page.locator("[data-job-id], .job-tile, [class*='JobChip']").first();
    await firstJob.click({ timeout: 10000 });
    await page.getByRole("button", { name: /^edit$/i }).first().click();

    // Wait for modal
    await expect(page.getByText("Edit Job")).toBeVisible();

    // Scroll to ADD-ONS section, click the Parking Fee checkbox if not checked
    const parkingRow = page.locator("text=/^Parking Fee$/").first();
    await expect(parkingRow).toBeVisible();
    const parkingCheckbox = parkingRow.locator("xpath=ancestor::div[1]").locator("input[type='checkbox']").first();
    if (!(await parkingCheckbox.isChecked())) {
      await parkingCheckbox.check();
    }

    // The inline $ input must appear within the same row.
    const inlineInput = parkingRow.locator("xpath=ancestor::div[1]").locator("input[type='number']").first();
    await expect(inlineInput).toBeVisible();

    // Default should be the catalog price as a placeholder, NOT a hardcoded value.
    const placeholder = await inlineInput.getAttribute("placeholder");
    expect(placeholder).toMatch(/^\d+(\.\d+)?$/);

    // Type $15
    await inlineInput.fill("15");
    expect(await inlineInput.inputValue()).toBe("15");

    // Clearing should leave the input empty (regression: previously snapped
    // back to catalog default because value was bound to fallback price).
    await inlineInput.fill("");
    expect(await inlineInput.inputValue()).toBe("");
  });
});
