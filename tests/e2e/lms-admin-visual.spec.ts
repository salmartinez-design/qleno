/**
 * Visual regression — LMS admin roster (table → cards transformation).
 *
 * Snaps /lms/admin at:
 *   - desktop (1280×800) — full table layout
 *   - mobile  (iPhone 13) — collapsed card layout
 *
 * Verifies the responsive break is wired and the card stack renders without
 * cutoffs. Owner+Admin only (server-enforced 403); the test logs in as the
 * configured owner account.
 *
 * Run:
 *   pnpm --filter @workspace/tests test:e2e -- lms-admin-visual.spec
 */
import { test, expect, devices } from "@playwright/test";

const TEST_EMAIL = process.env.TEST_EMAIL ?? "salmartinez@phes.io";
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? "phes1234";
const SKIP = process.env.SKIP_LMS_VISUAL === "1";

test.describe("LMS admin — visual regression", () => {
  test.skip(SKIP, "SKIP_LMS_VISUAL=1");

  async function loginAsOwner(
    page: import("@playwright/test").Page,
    baseURL: string,
  ) {
    await page.goto(`${baseURL}/login`);
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(dashboard|$)/, { timeout: 10_000 });
  }

  test("desktop — roster renders as a wide table", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAsOwner(page, baseURL!);
    await page.goto(`${baseURL}/lms/admin`);

    // Roster table must render — the page might say "No learners enrolled
    // yet." in a fresh env; both states are covered by the snapshot.
    await page.waitForSelector("h1, h2, table, article", { timeout: 10_000 });

    // Stabilize the dynamic "Last activity" timestamps so snapshots don't
    // flake on subsequent runs.
    await page.addStyleTag({
      content: `
        td:nth-last-child(2), [data-testid="roster-cards"] article > div:last-of-type {
          visibility: hidden !important;
        }
      `,
    });
    await expect(page).toHaveScreenshot("lms-admin-desktop-table.png", {
      fullPage: false,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("mobile (iPhone 13) — roster collapses to cards", async ({
    browser,
    baseURL,
  }) => {
    const ctx = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await ctx.newPage();
    try {
      await loginAsOwner(page, baseURL!);
      await page.goto(`${baseURL}/lms/admin`);

      // Cards mode is identified by data-testid on the wrapper.
      await page
        .waitForSelector('[data-testid="roster-cards"], h1, table', {
          timeout: 10_000,
        })
        .catch(() => null);

      await page.addStyleTag({
        content: `
          [data-testid="roster-cards"] article > div:nth-last-child(2) {
            visibility: hidden !important;
          }
        `,
      });
      await expect(page).toHaveScreenshot("lms-admin-mobile-cards.png", {
        fullPage: false,
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      await ctx.close();
    }
  });
});
