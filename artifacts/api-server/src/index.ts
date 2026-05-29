import app from "./app";
import { seedIfNeeded } from "./seed";
import { startRecurringJobCron } from "./lib/recurring-jobs";
import { runPhesDataMigration } from "./phes-data-migration";
import { runCutoverDataMigration } from "./cutover-data-migration";
import { verifyClockIntegrityConstraint } from "./lib/clock-integrity-self-check";
import { runReminderCron, runReviewRequestCron } from "./services/notificationService.js";
import { runRateLockNightlyChecks } from "./utils/rateLock.js";
import { processDueEnrollments } from "./services/followUpService.js";
import { runSmokeTests } from "./lib/smoke-test.js";
import { runAnnualCycleAutoOpen } from "./lib/lms-annual-cycle-cron.js";
import { runLmsCompletionBackfill } from "./lib/lms-completion-backfill.js";
import { runLmsCertificateBackfill } from "./lib/lms-certificate-backfill.js";

const port = Number(process.env.PORT) || 3000;

// ── Environment Variable Validation ─────────────────────────────────────────
console.log("[Qleno] Starting server...");

const REQUIRED_VARS = ["DATABASE_URL", "JWT_SECRET"];
const OPTIONAL_VARS: Record<string, string> = {
  STRIPE_SECRET_KEY: "payments disabled",
  RESEND_API_KEY: "emails disabled",
  TWILIO_ACCOUNT_SID: "SMS disabled",
  GOOGLE_MAPS_API_KEY: "geocoding disabled",
  CLOUDFLARE_R2_ACCESS_KEY: "file uploads disabled",
};

let criticalMissing = false;
for (const v of REQUIRED_VARS) {
  if (!process.env[v]) {
    console.error(`[Qleno] FATAL: Required env var ${v} is missing`);
    criticalMissing = true;
  }
}

for (const [v, fallback] of Object.entries(OPTIONAL_VARS)) {
  if (!process.env[v]) {
    console.warn(`[Qleno] ${v}: NOT CONFIGURED — ${fallback}`);
  } else {
    console.log(`[Qleno] ${v}: configured`);
  }
}

if (criticalMissing) {
  console.error("[Qleno] Missing critical env vars — server may not function correctly");
}

// ── Notification cron scheduler (CT timezone) ─────────────────────────────
// Fires reminder_3day at 9 AM CT, reminder_1day at 4 PM CT, review_request hourly
function startNotificationCron() {
  // Track last-fired dates to avoid duplicate runs
  const fired: Record<string, string> = {};

  const tick = () => {
    // CT offset: standard = -6, daylight = -5
    const now = new Date();
    const jan = new Date(now.getFullYear(), 0, 1);
    const jul = new Date(now.getFullYear(), 6, 1);
    const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
    const isDST = now.getTimezoneOffset() < stdOffset;
    const ctOffset = isDST ? -5 : -6;
    const ctMs = now.getTime() + ctOffset * 3600000 + now.getTimezoneOffset() * 60000;
    const ctNow = new Date(ctMs);
    const ctH   = ctNow.getUTCHours();
    const ctDate = ctNow.toISOString().slice(0, 10);
    const ctMonth = ctNow.getUTCMonth(); // 0-indexed; December = 11
    const ctDay   = ctNow.getUTCDate();

    // 9 AM CT → reminder_3day (jobs in 3 days)
    if (ctH === 9 && fired["reminder_3day"] !== `${ctDate}-9`) {
      fired["reminder_3day"] = `${ctDate}-9`;
      runReminderCron(3).catch((e: Error) => console.error("[cron] reminder_3day error:", e));
    }
    // 4 PM CT → reminder_1day (jobs tomorrow)
    if (ctH === 16 && fired["reminder_1day"] !== `${ctDate}-16`) {
      fired["reminder_1day"] = `${ctDate}-16`;
      runReminderCron(1).catch((e: Error) => console.error("[cron] reminder_1day error:", e));
    }
    // Every hour → review_request
    const hrKey = `${ctDate}-${ctH}`;
    if (fired["review_request"] !== hrKey) {
      fired["review_request"] = hrKey;
      runReviewRequestCron().catch((e: Error) => console.error("[cron] review_request error:", e));
    }
    // 1 AM CT → rate lock nightly checks (service gap voids, expiry voids, renewal alerts)
    if (ctH === 1 && fired["rate_lock_nightly"] !== `${ctDate}-1`) {
      fired["rate_lock_nightly"] = `${ctDate}-1`;
      runRateLockNightlyChecks().catch((e: Error) => console.error("[cron] rate_lock_nightly error:", e));
    }
    // December 1 at 9 AM CT → annual re-acknowledgment cycle auto-open
    // for every tenant. Idempotent: skips tenants with an existing
    // cycle for the current calendar year.
    if (
      ctMonth === 11 &&
      ctDay === 1 &&
      ctH === 9 &&
      fired["annual_cycle_auto_open"] !== `${ctDate}-9`
    ) {
      fired["annual_cycle_auto_open"] = `${ctDate}-9`;
      runAnnualCycleAutoOpen()
        .then((results) => {
          const opened = results.filter((r) => r.status === "opened").length;
          const skipped = results.filter((r) => r.status === "skipped_exists").length;
          const errored = results.filter((r) => r.status === "error").length;
          console.log(
            `[cron] annual_cycle_auto_open: ${opened} opened, ${skipped} skipped, ${errored} errored`,
          );
        })
        .catch((e: Error) =>
          console.error("[cron] annual_cycle_auto_open error:", e),
        );
    }
  };

  setInterval(tick, 60 * 1000); // check every minute
  console.log("[Qleno] Notification cron scheduler started (CT timezone)");
}

// ── Follow-up sequence cron (every 30 minutes) ───────────────────────────────
function startFollowUpCron() {
  const run = () => {
    processDueEnrollments().catch((e: Error) =>
      console.error("[cron] follow_up error:", e));
  };
  // Delay initial run by 60 s so schema guard finishes before first tick
  setTimeout(run, 60_000);
  setInterval(run, 30 * 60 * 1000);
  console.log("[Qleno] Follow-up sequence cron started (every 30 min)");
}

// ── Startup ──────────────────────────────────────────────────────────────────
// 2026-05-17 (read/write divergence cleanup): migrations now run BEFORE
// app.listen(). Previous order accepted traffic immediately and ran
// migrations as a background .then() chain. That left a window of
// seconds–minutes where /quiz/submit and /handbook/sign could land
// against partially-migrated rows (e.g. status='in_progress' but the
// recompute hadn't reached the row yet). The race surfaced after PR #125
// + PR #126 and is closed by sequencing migrations ahead of listen.
//
// Each migration is wrapped in its own try/catch with the existing
// non-fatal logging so a single migration failure does NOT prevent
// boot — exactly matches the previous .catch() behaviour, just earlier
// in the lifecycle. Crons + smoke tests still start inside the listen
// callback (after listen), unchanged.
async function startup() {
  try {
    await seedIfNeeded();
  } catch (err: any) {
    console.error("[startup] seedIfNeeded — non-fatal:", err?.message ?? err);
  }
  try {
    await runPhesDataMigration();
  } catch (err: any) {
    console.error("[startup] runPhesDataMigration — non-fatal:", err?.message ?? err);
  }
  try {
    await runCutoverDataMigration();
  } catch (err: any) {
    console.error("[startup] runCutoverDataMigration — non-fatal:", err?.message ?? err);
  }
  // Cutover 1E — self-check that the 1C GPS-integrity CHECK constraint
  // is live AND enforced in production. Non-fatal: pay computation
  // independently filters at the application layer, but the deploy log
  // makes the DB-layer guarantee visible to anyone watching.
  try {
    await verifyClockIntegrityConstraint();
  } catch (err: any) {
    console.error("[startup] clock-integrity self-check — non-fatal:", err?.message ?? err);
  }
  try {
    const r = await runLmsCompletionBackfill();
    if (r.enrollments_reverted > 0 || r.final_rows_revoked > 0) {
      console.log(
        `[lms-backfill] scanned=${r.enrollments_scanned} reverted=${r.enrollments_reverted} final_revoked=${r.final_rows_revoked}`,
      );
    }
  } catch (err: any) {
    console.error("[startup] runLmsCompletionBackfill — non-fatal:", err?.message ?? err);
  }
  try {
    const r = await runLmsCertificateBackfill();
    if (
      r.certs_issued > 0 ||
      r.tenant_mismatches_skipped > 0 ||
      r.errors > 0
    ) {
      console.log(
        `[lms-cert-backfill] scanned=${r.rows_scanned} issued=${r.certs_issued} tenant_skipped=${r.tenant_mismatches_skipped} errors=${r.errors}`,
      );
    }
  } catch (err: any) {
    console.error("[startup] runLmsCertificateBackfill — non-fatal:", err?.message ?? err);
  }

  app.listen(port, "0.0.0.0", () => {
    console.log("Server running on port", process.env.PORT || 3000);
    // [DR runbook 2026-04-30] Static reminder visible on every cold
    // start. Surfaces backup-state in Railway logs without requiring
    // a RAILWAY_API_TOKEN credential we'd then have to manage. The
    // intent is to keep "verify backups quarterly" in the operator's
    // eyeline, not to give live timestamp data — Railway Hobby's
    // backup state changes maybe twice a year.
    // Procedure + RPO/RTO targets: docs/disaster-recovery.md
    console.log("[backup-check] static reminder: Railway Hobby plan provides daily backups, 7-day retention. Verify quarterly via dashboard. Procedure: docs/disaster-recovery.md");
    const recurringEngineEnabled = process.env.RECURRING_ENGINE_ENABLED !== "false";
    // [2026-04-22 J3] Startup invocation of runRecurringJobGeneration() removed —
    // Railway restart cascades caused 5x concurrent engine runs on the
    // 2026-04-22 overnight cron, creating 270 duplicate rows. The engine now
    // only fires via the 2 AM cron registered below. Seed + PHES data migration
    // already completed above (await chain before listen).
    if (recurringEngineEnabled) {
    startRecurringJobCron();
    console.log("[recurring-engine] Cron started");
  } else {
    console.log("[recurring-engine] Cron DISABLED via RECURRING_ENGINE_ENABLED=false env var");
  }

  // [AI] Per-tenant engine flag visibility. Future sessions verifying the
  // disabled state can grep this line. Runs after migrations complete so
  // the column is guaranteed to exist.
  setTimeout(async () => {
    try {
      const { db } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");
      const r = await db.execute(sql`
        SELECT id, name, recurring_engine_enabled
        FROM companies
        ORDER BY id
      `);
      const states = (r.rows as Array<{ id: number; name: string; recurring_engine_enabled: boolean }>)
        .map(c => `company_id=${c.id} (${c.name}) enabled=${c.recurring_engine_enabled}`)
        .join(", ");
      console.log(`[recurring-engine] Flag state: ${states}`);
      console.log(`[recurring-engine] Env override: RECURRING_ENGINE_ENABLED=${process.env.RECURRING_ENGINE_ENABLED ?? "(unset, defaults true)"}`);
    } catch (err) {
      console.warn("[recurring-engine] Could not load flag state:", err);
    }
  }, 5000); // 5s delay to let migrations finish
  startNotificationCron();
  startFollowUpCron();

  // QuickBooks sync queue drain worker — every 60s, runs syncAll() for each
  // QB-connected tenant. Retries failed rows up to attempts<3 (logic lives in
  // syncAll). Gated by env var for emergency kill switch, same pattern as
  // the recurring engine. No worker = silent sync failures accumulate, which
  // is unacceptable at multi-tenant scale.
  if (process.env.QB_QUEUE_WORKER_ENABLED !== "false") {
    setInterval(async () => {
      try {
        const { db } = await import("@workspace/db");
        const { sql } = await import("drizzle-orm");
        const { syncAll } = await import("./services/quickbooks-sync.js");
        const rows = await db.execute(sql.raw("SELECT id FROM companies WHERE qb_connected = true ORDER BY id"));
        for (const c of (rows.rows as Array<{ id: number }>)) {
          try { await syncAll(c.id); } catch (err: any) {
            console.error(`[qb-worker] company ${c.id} syncAll failed:`, err?.message);
          }
        }
      } catch (err: any) {
        console.error("[qb-worker] tick failed:", err?.message);
      }
    }, 60 * 1000);
    console.log("[qb-worker] Queue drain started (60s interval)");
  } else {
    console.log("[qb-worker] DISABLED via QB_QUEUE_WORKER_ENABLED=false env var");
  }

  // Post-deploy smoke tests — 3 s delay to let DB settle after deploy
  if (process.env.NODE_ENV === "production") {
    setTimeout(() => {
      runSmokeTests().catch((err) => {
        console.error("[SMOKE] Smoke test runner failed:", err.message);
      });
    }, 3000);
  }
  });
}

// Kick off startup. Any unhandled rejection here is fatal — we never
// got to app.listen, so there's nothing to serve.
startup().catch((err) => {
  console.error("[startup] FATAL:", err);
  process.exit(1);
});
