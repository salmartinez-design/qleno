// [PR #28 / 2026-04-30] Playwright e2e infrastructure.
//
// Goal: every future PR can include automated browser-level
// verification, eliminating Sal's manual click-through verification
// loop. This config is deliberately minimal — chromium-only,
// short timeouts, screenshots on failure — so the first wave of
// tests stays fast and stable.
//
// Target environment: local stack only. CI spins up Postgres + the
// api-server + the frontend in a workflow runner. We do NOT run
// against production. Destructive tests cloning Jaira to a TEST_
// client run inside the ephemeral CI database; production has no
// knowledge of this layer.
//
// Env vars consumed:
//   E2E_BASE_URL  — defaults to http://localhost:3000 (CI) /
//                   http://localhost:5173 (Vite dev server)
//                   Override for local debugging if needed.
//   CI            — present in GitHub Actions; toggles retries on,
//                   --reporter=html off in favor of github
//                   reporter, parallel workers reduced.

import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests/e2e",
  // 30s per test cap. Tightens the feedback loop and surfaces
  // accidentally-slow tests early. Tests that legitimately need
  // longer (e.g. a multi-page workflow) override per-test.
  timeout: 30_000,
  // 1 retry in CI to absorb network blips against the local stack;
  // 0 retries locally so Sal sees flake immediately during dev.
  retries: isCI ? 1 : 0,
  // Single worker in CI keeps the local Postgres + api-server free
  // of cross-test contention; we can crank this up once we have
  // tests that don't share fixtures (i.e. once cloneClient yields
  // unique TEST_ ids per test).
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // Screenshots only on failure — keeps the artifact size sane.
    // Video off for the same reason; flip to "retain-on-failure"
    // if a flake gets stubborn and we need to see the playback.
    screenshot: "only-on-failure",
    video: "off",
    trace: "retain-on-failure",
    // Tighten action defaults — element clicks etc. fail-fast at
    // 5s instead of Playwright's 30s default.
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // firefox + webkit deliberately omitted on the first wave.
    // Add later if/when we hit a chrome-only assertion failure
    // worth catching cross-browser.
  ],
});
