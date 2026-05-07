/**
 * Visual regression — LMS per-module quiz screen.
 *
 * Snaps the quiz screen at:
 *   - desktop (default Chromium viewport)
 *   - mobile (iPhone 13 viewport, ~390x844)
 *
 * The test does NOT depend on a real authenticated session — it logs in
 * with the configured test credentials, navigates to /lms, opens the first
 * available module's quiz, and captures the screen. If your local env has
 * no test account or the dev API isn't running, set SKIP_LMS_VISUAL=1 to
 * skip these without failing.
 *
 * Run:
 *   pnpm --filter @workspace/tests test:e2e -- lms-quiz-visual.spec
 */
import { test, expect, devices } from "@playwright/test";

const TEST_EMAIL = process.env.TEST_EMAIL ?? "salmartinez@phes.io";
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? "phes1234";
const SKIP = process.env.SKIP_LMS_VISUAL === "1";

test.describe("LMS — quiz visual regression", () => {
  test.skip(SKIP, "SKIP_LMS_VISUAL=1");

  async function login(page: import("@playwright/test").Page, baseURL: string) {
    await page.goto(`${baseURL}/login`);
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/(dashboard|$)/, { timeout: 10_000 });
  }

  test("desktop — quiz screen renders without layout regressions", async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, baseURL!);

    await page.goto(`${baseURL}/lms`);

    // Open the first module that's unlocked (welcome by default).
    const firstModule = page.locator("button", { hasText: "Welcome" }).first();
    await expect(firstModule).toBeVisible({ timeout: 10_000 });
    await firstModule.click();

    // Click "Start quiz" on the module page.
    const startQuiz = page.getByRole("button", { name: /Start.*quiz|Start.*examen/i });
    await expect(startQuiz).toBeVisible({ timeout: 10_000 });
    await startQuiz.click();

    // Wait for the question card.
    await page.waitForSelector('button:has-text("Submit"), button:has-text("Next")', {
      timeout: 10_000,
    });

    // Stabilize: hide the deadline countdown (changes by clock).
    await page.addStyleTag({
      content: `[role="status"] { visibility: hidden !important; }`,
    });
    await expect(page).toHaveScreenshot("lms-quiz-desktop.png", {
      fullPage: false,
      maxDiffPixelRatio: 0.02,
    });
  });

  test("mobile (iPhone 13) — quiz screen one-handed layout", async ({
    browser,
    baseURL,
  }) => {
    const ctx = await browser.newContext({
      ...devices["iPhone 13"],
    });
    const page = await ctx.newPage();
    try {
      await login(page, baseURL!);
      await page.goto(`${baseURL}/lms`);

      const firstModule = page.locator("button", { hasText: "Welcome" }).first();
      await expect(firstModule).toBeVisible({ timeout: 10_000 });
      await firstModule.click();

      const startQuiz = page.getByRole("button", { name: /Start.*quiz/i });
      await expect(startQuiz).toBeVisible({ timeout: 10_000 });
      await startQuiz.click();

      await page.waitForSelector('button:has-text("Submit"), button:has-text("Next")', {
        timeout: 10_000,
      });
      await page.addStyleTag({
        content: `[role="status"] { visibility: hidden !important; }`,
      });
      await expect(page).toHaveScreenshot("lms-quiz-mobile.png", {
        fullPage: false,
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      await ctx.close();
    }
  });
});
