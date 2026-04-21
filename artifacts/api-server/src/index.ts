import app from "./app";
import { seedIfNeeded } from "./seed";
import { runRecurringJobGeneration, startRecurringJobCron } from "./lib/recurring-jobs";
import { runPhesDataMigration } from "./phes-data-migration";
import { runReminderCron, runReviewRequestCron } from "./services/notificationService.js";
import { runRateLockNightlyChecks } from "./utils/rateLock.js";
import { processDueEnrollments } from "./services/followUpService.js";
import { runSmokeTests } from "./lib/smoke-test.js";

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
// Start listening immediately so health checks pass, then seed in the background
app.listen(port, "0.0.0.0", () => {
  console.log("Server running on port", process.env.PORT || 3000);
  const recurringEngineEnabled = process.env.RECURRING_ENGINE_ENABLED !== "false";
  seedIfNeeded()
    .then(() => runPhesDataMigration())
    .then(() => {
      if (recurringEngineEnabled) return runRecurringJobGeneration();
      console.log("[recurring-engine] Startup generation SKIPPED via RECURRING_ENGINE_ENABLED=false env var");
    })
    .catch((err) => {
      console.error("[startup] Background init error:", err);
    });
  if (recurringEngineEnabled) {
    startRecurringJobCron();
    console.log("[recurring-engine] Cron started");
  } else {
    console.log("[recurring-engine] Cron DISABLED via RECURRING_ENGINE_ENABLED=false env var");
  }
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
