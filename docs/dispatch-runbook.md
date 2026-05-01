# Dispatch Runbook

Rules of engagement for the overnight autonomous Dispatch session.

> **Premise:** Sal sets up the rails, Dispatch ships scoped work
> overnight, Sal wakes up to a clean morning report. The point of the
> rails is so Sal does *not* wake up to put out a fire.

## A — Whitelist (allowed overnight)

Dispatch may, without further approval:

1. **Fix bugs from the explicit backlog** in
   [`dispatch-backlog.md`](./dispatch-backlog.md). One bug per PR.
2. **Convert raw `sql\`\`\`` template-tag SQL to Drizzle ORM**
   (continuation of PRs #40 / #41). One file per PR.
3. **Chip at TS strict-mode errors** — pick one file from the 748,
   fix the typing without changing behavior, ship one PR per file.
   Net error count must not increase.
4. **Add tests for existing untested code paths.** No new test
   infrastructure; use the harness PR #28 ships.
5. **Fix lint warnings** within a single file's existing scope.
6. **Update documentation** — `CLAUDE.md`, `docs/*.md`, in-code
   comments where the WHY is non-obvious.
7. **Refactor within a single file's existing scope** when it makes
   the bug-fix above tractable. No cross-file moves.

## B — Blacklist (must not do overnight)

Hard stop on any of these. Queue them for Sal's morning review with
the precise question that triggered the stop.

1. **Schema migrations** — column add / drop / alter, enum changes,
   table create / drop, index changes. Anything in `packages/db/`
   or any `drizzle.config.*`.
2. **New env vars.** Sal adds env vars to Railway by hand from the
   dashboard. A PR that needs a new env var must be queued.
3. **New npm dependencies.** No `pnpm add`. Existing deps only.
4. **Database row deletes.** No `DELETE` statements that hit prod
   data. Soft-delete (`is_active=false`) is fine if the column
   already exists.
5. **Touching `artifacts/api-server/src/phes-data-migration.ts`.**
   Boot-time logic — a bad change here takes prod down on the next
   deploy. Off-limits.
6. **Auth / JWT / RLS code.** `lib/auth.ts`, `middlewares/`, any
   RLS policy, any token signing.
7. **Stripe / Square / QuickBooks / Twilio / Resend integrations.**
   The integration glue in `routes/stripe-webhook.ts`,
   `routes/payments.ts`, `routes/job-sms.ts`, `routes/messages.ts`,
   `lib/quickbooks.ts`, `services/twilio*.ts`, `services/resend*.ts`.
   These have side effects on production money / customer comms.
8. **Recurring engine cron timing.** `lib/recurring-jobs.ts`'s cron
   schedule, the `RECURRING_ENGINE_ENABLED` gate in `index.ts`, the
   anchor-date logic. Off-limits.
9. **More than 1 PR open at a time.** Queue, don't stack. The next
   PR opens after the current PR merges + smoke-checks green.
10. **More than 3 PRs merged per hour.** Pause and wait. If the
    backlog has more than 3 hours of work in it, pace it across the
    night.
11. **Merging while production smoke check is failing.** Revert and
    halt.
12. **Merging while Playwright is red on the PR's branch.**
13. **Anything outside the explicit backlog.** Adjacent finds get
    queued for Sal — they don't get folded into the current PR.

## C — Smoke check protocol (after every merge)

Mandatory after each PR merges to `main`. If any step fails, revert
the merge and halt the session.

1. **Wait 90 seconds** for Railway's auto-deploy to roll the new
   commit out.
2. **Hit the health endpoint:**
   ```sh
   curl -fsS https://app.qleno.com/api/health
   ```
   Required:
   - HTTP 200
   - JSON body `ok: true`
   - JSON body `db: "ok"`
   - JSON body `version` matches the merged commit's short SHA
     (first 7 chars). If `version` is still the previous SHA, Railway
     hasn't rolled — wait another 60 seconds, retry once. Two
     misses → treat as a hard stop.
3. **Run the Playwright canary suite** against the deployed URL:
   ```sh
   cd artifacts/qleno
   E2E_BASE_URL=https://app.qleno.com pnpm run test:e2e -- \
     --grep "@canary"
   ```
   The `@canary` tag covers four spec files:
   - `proof-of-life.spec.ts` — `/api/healthz` + `/api/health` +
     SPA shell smoke (always runs, no creds needed)
   - `match-schedule.spec.ts` — Match schedule button reads
     `days_of_week` from dispatch payload (skipped if creds unset)
   - `cascade-this-and-future.spec.ts` — frequency change cascades
     to future Tue–Fri (skipped if creds unset)
   - `parking-day-of-week.spec.ts` — parking stamps Mon-Fri,
     skips weekends (skipped if creds unset)

   All running tests must pass. Skipped-because-no-creds tests
   are not pass / not fail — Sal must add the GitHub Secrets
   (`E2E_TEST_OWNER_EMAIL` / `E2E_TEST_OWNER_PASSWORD`) for the
   auth-requiring tests to flip on.
4. **If all three steps pass:** advance to the next backlog item.
5. **If any step fails:**
   - Revert the merge:
     ```sh
     gh pr revert <merged-pr-number>
     ```
     (or via the GitHub MCP — `mcp__github__create_pull_request`
     with the revert commit, then auto-merge).
   - Halt the session.
   - Write the failure into the morning report (Section D).
   - Do **not** open the next PR.

## D — Morning report

Generate at 06:00 local time as
`docs/dispatch-reports/<YYYY-MM-DD>.md`.

Format:

```md
# Dispatch report — <YYYY-MM-DD>

**Status: GREEN | YELLOW | RED**

(GREEN = no reverts, no queued items, all smoke checks passed.
YELLOW = items queued for AM review, no reverts.
RED = at least one revert and / or session halted.)

## PRs merged

- #<num> <title> — <+lines / -lines>, Playwright <pass|fail|n/a>,
  deploy <UTC timestamp>

## PRs reverted

- #<num> <title> — <reason>, revert PR #<num>

## PRs queued for AM review

- <backlog item / question> — <reason it was queued instead of
  shipped>

## Production smoke

- Last check: <UTC timestamp>
- Result: <ok | failed: <reason>>
- `db` ping: <ok | failed: <reason>>
- Recurring engine: <enabled | disabled>

## Critical-path status (May 12 / June 1 cutover)

- <each remaining item with one-line status>

## Anomalies in Railway logs

- <any unusual error patterns from /api/health logs, recurring
  engine logs, or stripe webhook logs>
```

Commit the report on a dedicated branch
`claude/dispatch-report-<YYYY-MM-DD>` and open a PR for Sal's
review. Do **not** auto-merge the report PR.

## E — Kill switch procedures

Three independent layers, in escalating order. Each can be triggered
from Sal's phone.

### Layer 1 — DISPATCH_AUTONOMOUS_MODE env var

**When:** Dispatch is doing too much, or you want to halt overnight
work but keep prod running normally.

**How:**
1. Open Railway dashboard on phone:
   `https://railway.app/project/<qleno-project-id>` →
   `api-server` service → **Variables** tab.
2. Set `DISPATCH_AUTONOMOUS_MODE=false` (or remove the variable).
3. Save. Railway redeploys (~60 s).
4. The next request from Dispatch to `/api/admin` returns 503 with
   message "Dispatch mode disabled by operator."

**Effect:** Dispatch's privileged-API actions are blocked. Sal's
normal authenticated admin access is unaffected (the gate fires
only on requests with `X-Dispatch-Agent: true`).

### Layer 2 — .dispatch-stop file in repo

**When:** Dispatch is merging bad PRs and you can't reach Railway.

**How:**
1. Open GitHub mobile app → `salmartinez-design/qleno` → Code tab.
2. Tap **Add file** → **Create new file**.
3. Filename: `.dispatch-stop`.
4. Content: a brief reason ("halt — bad merges 03:14 AM").
5. Commit directly to `main` (or to a branch + immediate PR if
   `main` is locked).

**Effect:** All CI workflows fail at the
`dispatch-stop-guard` job. With branch protection set up, no PR
can merge while the file exists. Dispatch sees red CI on every
attempt and queues for AM review.

### Layer 3 — RECURRING_ENGINE_ENABLED env var

**When:** The recurring engine itself is misbehaving (generating
bad jobs, double-firing, hanging on a tx).

**How:**
1. Same Railway env var workflow as Layer 1.
2. Set `RECURRING_ENGINE_ENABLED=false`.
3. Save. Next deploy starts api-server with the cron disabled.

**Effect:** The recurring engine's cron stops firing. Existing
jobs and direct API calls still work.

### Total panic

If Dispatch is actively damaging the database / making outbound
comms / etc., do all three layers above **plus**:

4. Revoke Dispatch's GitHub PAT:
   `https://github.com/settings/tokens` → revoke the Dispatch
   token. Dispatch can no longer open or merge PRs.
5. Page yourself: text the Phes ops team that Dispatch is paused.
   Don't sleep through the recovery window.

## F — Hard stop conditions

Dispatch must halt the session and queue everything else for AM
review when any of these are true:

- `/api/health` returns non-200, or `db` is not `ok`, after a
  smoke check.
- A PR's Playwright canary suite is red.
- A revert was just shipped.
- The .dispatch-stop file appeared on `main`.
- An exception bubbled out of the agent's own loop (whatever
  Dispatch's runtime considers an error).
- The PRs-per-hour rate limit (Section B.10) was hit.

## G — Sal-voice

> "Don't add work to my morning. Either ship it green or queue it
> with a precise question."
