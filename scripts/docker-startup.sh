#!/bin/sh
# Production startup script for the api-server container.
#
# Why this exists: in May 2026 we shipped multiple PRs that added
# columns to lib/db schema files but never reached production because
# the Dockerfile didn't run drizzle-kit push on deploy. The result was
# a 567-statement schema-catchup script applied by hand. This script
# is the safety net so that gap can't recur.
#
# Safety story:
#   * The script NEVER exits non-zero (`set -e` is intentionally NOT
#     set). We always reach the `exec node ...` at the bottom so the
#     api-server boots no matter what.
#   * Each step is wrapped so failures only log + continue.
#   * If drizzle-kit isn't installed (e.g. pnpm pruned devDeps in this
#     image variant), we skip silently and rely on the api-server's
#     idempotent cutover-data-migration.ts safety net.
#
# For destructive schema changes (DROP COLUMN, RENAME, type changes),
# run `cd lib/db && pnpm push-force` locally against the prod DB
# BEFORE pushing the code. This script handles the additive 95% case.

echo "[startup] qleno container starting at $(date)"

# Skip schema sync if RUN_SCHEMA_PUSH=false (env override for emergency
# deploys where we know schema is already in sync and want to skip
# the push step).
if [ "$RUN_SCHEMA_PUSH" = "false" ]; then
  echo "[startup] RUN_SCHEMA_PUSH=false — skipping drizzle-kit push."
elif [ -z "$DATABASE_URL" ]; then
  echo "[startup] WARN: DATABASE_URL not set — skipping schema push. Api-server will likely fail at first query."
else
  echo "[startup] Running drizzle-kit push (additive schema sync)..."
  # Wrap in subshell + ||: so any failure (drizzle-kit missing, network,
  # destructive change detected) doesn't break boot. We're NOT using
  # `set -e` outside the subshell, but belt-and-suspenders here too.
  (
    cd /app/lib/db || exit 0
    # Check drizzle-kit is reachable before invoking — if pnpm pruned
    # it, we want a clean "skipped" log instead of cryptic error noise.
    if ! pnpm exec drizzle-kit --version >/dev/null 2>&1; then
      echo "[startup] drizzle-kit not available in this image — skipping push (rely on cutover-data-migration.ts)."
      exit 0
    fi
    # Run push with a hard 60s timeout so we never hang the container
    # boot waiting for an interactive prompt that won't come in non-TTY.
    timeout 60 pnpm exec drizzle-kit push --config=drizzle.config.ts 2>&1 \
      || echo "[startup] WARN: drizzle-kit push exited non-zero (or timed out). Schema may be out of date — investigate logs above. Continuing so cutover-data-migration.ts can run."
  ) || true
fi

echo "[startup] Starting api-server..."
exec node /app/artifacts/api-server/dist/index.mjs
