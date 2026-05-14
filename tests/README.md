# `@workspace/tests`

End-to-end Playwright suite for Qleno + Phes LMS.

## Run the full suite

```bash
pnpm --filter @workspace/tests test:e2e
```

## Run a single spec

```bash
pnpm --filter @workspace/tests test:e2e -- lms-onboarding-flows.spec
pnpm --filter @workspace/tests test:e2e -- lms-full-flow.spec
```

## Headed mode (watch the browser)

```bash
TEST_BASE_URL=http://localhost:3000 \
  pnpm --filter @workspace/tests test:e2e:headed -- lms-onboarding-flows.spec
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEST_BASE_URL` | `http://localhost:80` | Frontend URL the browser visits |
| `TEST_API_BASE` | `http://localhost:8080` | API server URL (read by some specs directly) |
| `TEST_EMAIL` | `salmartinez@phes.io` | Owner login |
| `TEST_PASSWORD` | `Chicago23` | Owner password |
| `TEST_EMPLOYEE_EMAIL` | _unset_ | Non-owner technician login (specs that need an employee skip when unset) |
| `TEST_EMPLOYEE_PASSWORD` | `Chicago23` | Technician password |
| `TEST_GRANDFATHERED_EMAIL` | _unset_ | A tech whose enrollment was healed by the truly-complete backfill; the spec asserts the RecomputeBanner appears for them |
| `TEST_GRANDFATHERED_PASSWORD` | `Chicago23` | Grandfathered tech password |
| `SKIP_LMS_VISUAL` | `0` | Set to `1` to skip the visual-regression specs |
| `SKIP_LMS_E2E` | `0` | Set to `1` to skip the full-flow spec |
| `SKIP_LMS_ONBOARDING_E2E` | `0` | Set to `1` to skip the onboarding-flows spec |

## Specs in this directory

| Spec | Coverage |
| --- | --- |
| `lms-full-flow.spec.ts` | Owner-side admin buttons + dialog open + CSV download (PR #108) |
| `lms-onboarding-flows.spec.ts` | Fresh employee, recompute banner, language toggle, mobile viewport, Journey page (final sprint PR 6) |
| `lms-quiz-visual.spec.ts` | Visual regression on the per-module quiz screen |
| `lms-admin-visual.spec.ts` | Visual regression on `/lms/admin` |
| `bundle-discount.spec.ts` | Bundle discount pricing |
| `parking-fee.spec.ts` | Parking-fee per-occurrence engine |

## Test-database notes

These specs run against whatever the configured `TEST_BASE_URL` points at. There is no isolated test database today; the suite is read-mostly. The only mutation paths are:

- The CSV download test triggers a `GET /lms/admin-audit/summary.csv` — read-only on the server.
- The recompute-banner dismiss test writes a `localStorage` key (browser-side; doesn't touch the database).

If you add destructive tests later, point them at an isolated DB via `DATABASE_URL` injected into the server process.

## CI

Specs are NOT run on every PR (Playwright suite is slow and depends on a live API). They are intended for local validation pre-deploy and for ad-hoc QA. When you want CI coverage, add a GitHub Actions workflow that spins up the server + frontend dev servers and runs `pnpm --filter @workspace/tests test:e2e`.
