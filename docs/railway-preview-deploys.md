# Railway Preview Deploys

Railway PR preview environments give every PR a clickable URL where
Sal can hand-test the change before merging. They're additive to the
local-CI Playwright suite (which runs against an ephemeral Postgres
in the GitHub Actions runner) — together they remove the manual
click-loop on every PR.

> **Status:** doc-only on this PR. Configuration requires Sal's
> Railway dashboard access and the choice of DB strategy below.
> Until Railway is configured, Playwright runs against the
> in-CI ephemeral stack only.

## 1 — Enable PR preview environments

In the Railway dashboard:

1. Open **Project → qleno → Settings → Environments**.
2. Toggle **PR Environments** on.
3. Pick the **api-server** service as the preview-deployed service.
4. Confirm the GitHub App integration has `pull_request` permission
   on `salmartinez-design/qleno` (Settings → Integrations → GitHub).

Once on, every PR opened against `main` triggers a preview deploy.
Railway auto-comments the preview URL on the PR within ~60 s of the
deploy succeeding.

## 2 — Database strategy

Pick one. Document the choice in the api-server service's `README`
or here for future-self.

### Option A — fresh empty DB per preview (recommended)

Each preview gets a brand-new ephemeral Postgres. Schema bootstrapped
via `pnpm --filter @workspace/db run push-force`. Data seeded by
`seedIfNeeded()` + `runPhesDataMigration()` on api-server boot.

**Pros:**
- Hard isolation. A test that mutates / deletes can't touch
  production or staging data.
- Mirrors what CI's local stack uses — same code path is exercised.
- Predictable seed state — every preview starts from the same
  fixture.

**Cons:**
- Ephemeral Postgres adds ~30 s to preview boot.
- Preview can't surface live customer data for a Sal-eyeball check
  ("does this look right with Phes's actual jobs?"). For that, use
  Option B in addition (one shared staging DB) or hand-test against
  prod with a feature flag.

**How:**
1. In Railway, **add a new service to the project** of type
   "Postgres", named `qleno-postgres-preview`.
2. Mark it **PR-environment-only** (Service Settings → Environment
   Scope).
3. In the **api-server** service's preview environment variables,
   set `DATABASE_URL` to the preview Postgres's connection string
   (Railway exposes this as `${{ qleno-postgres-preview.DATABASE_URL }}`).
4. Confirm `seedIfNeeded()` plants the test owner user — the
   Playwright auth helper logs in with `E2E_TEST_OWNER_EMAIL` /
   `E2E_TEST_OWNER_PASSWORD`. Match those env vars to the seeded
   user's credentials.

### Option B — shared staging DB

Every preview points at a single long-lived staging Postgres.

**Pros:**
- Faster preview boot (no schema push, no seed).
- Real-world-like data — Sal can eyeball "does this match the
  actual Phes shape?".

**Cons:**
- Cross-preview pollution. PR A mutates a row, PR B sees the
  mutation. Bug repros become a race condition.
- Risky if a preview ships a destructive migration — it hits
  staging, not an isolated copy.
- Doesn't match what CI uses, so the "preview is green but CI is
  red" gap stays.

Picked only if Option A turns out to be too slow / flaky.

### Option C — CI-only ephemeral stack, no Railway preview DB

Skip Railway preview deploys entirely. Playwright runs against the
ephemeral local stack in `.github/workflows/e2e.yml`. Sal still gets
a manual clickable preview by running locally:
`PORT=5000 pnpm dev`.

**Pros:**
- Zero Railway config.
- Already works today.

**Cons:**
- No clickable preview URL on the PR.
- Sal has to pull the branch and boot it locally to eyeball UI
  changes.

This is the **fallback** when Options A and B aren't available
(Railway plan limits, billing, etc.).

## 3 — Confirm the preview URL is posted on the PR

Railway's GitHub App auto-comments the preview URL on the PR after
the first preview deploy succeeds. Look for a comment from the
Railway bot like:

> 🚂 Railway preview environment is ready: https://qleno-pr-XX.up.railway.app

If it doesn't show up:
- Check the Railway deploy logs on the PR's preview environment
  (Railway dashboard → Project → Deployments).
- Confirm the GitHub App has `pull_requests: write` permission.

## 4 — Wire Playwright to the preview URL

The Playwright suite currently reads `E2E_BASE_URL` (default
`http://localhost:3000`). To run against the preview:

1. Add a new GitHub Actions job that pulls the preview URL from the
   Railway-bot comment via the GitHub API.
2. Pass it to Playwright via `E2E_BASE_URL=$PREVIEW_URL pnpm test:e2e`.

Or — simpler — add `RAILWAY_PUBLIC_DOMAIN` as an env var on the
preview environment and use Railway's webhook to set
`E2E_BASE_URL` directly when the Playwright job dispatches.

This wiring lives behind the `RAILWAY_PREVIEW_E2E` feature flag in
`.github/workflows/e2e.yml`. Default off — flip on via repo
Settings → Variables → `RAILWAY_PREVIEW_E2E=true` after Railway
preview deploys are confirmed working.

## Plan limit note (Railway Hobby)

The Hobby plan supports PR preview environments, but with limits:
- 5 concurrent preview deploys (more cost extra)
- Service spins down after 30 min of no traffic (cold-starts add
  ~10 s the next time)
- No custom domain on previews (`*.up.railway.app` only)

For Phes's volume (~5 PRs / week, sequential), Hobby is fine. If
the 5-concurrent limit gets hit, oldest PRs auto-terminate their
preview — re-trigger by pushing a new commit.

## Sal action items (after merge)

1. Toggle PR Environments on in Railway dashboard.
2. Pick Option A / B / C above.
3. If Option A: add the preview Postgres service.
4. Add `E2E_TEST_OWNER_EMAIL` / `E2E_TEST_OWNER_PASSWORD` as
   GitHub Secrets (also needed for the in-CI ephemeral stack —
   `.github/workflows/e2e.yml` already references them).
5. Verify the Railway bot posts the preview URL on the next PR.
