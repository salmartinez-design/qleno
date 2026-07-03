import app from "./app";
import { seedIfNeeded } from "./seed";
import { startRecurringJobCron } from "./lib/recurring-jobs";
import { runPhesDataMigration } from "./phes-data-migration";
import { runCutoverDataMigration } from "./cutover-data-migration";
import { verifyClockIntegrityConstraint } from "./lib/clock-integrity-self-check";
import { runUserCompaniesMigration } from "./user-companies-migration.js";
import { runReminderCron, runScheduledJobMessages } from "./services/notificationService.js";
import { runRateLockNightlyChecks } from "./utils/rateLock.js";
import { processDueEnrollments } from "./services/followUpService.js";
import { runSmokeTests } from "./lib/smoke-test.js";
import { runAnnualCycleAutoOpen } from "./lib/lms-annual-cycle-cron.js";
import { runLmsCompletionBackfill } from "./lib/lms-completion-backfill.js";
import { runLmsCertificateBackfill } from "./lib/lms-certificate-backfill.js";
import { ensureJobHistoryLiveBridgeSchema, syncJobHistoryLiveBridge } from "./lib/job-history-sync.js";
import { bootstrapOnboardingPasswords } from "./lib/onboarding-password-backfill.js";
import { runLeaveAccrualCron } from "./lib/leave-accrual-cron.js";
import { runScorecardCompositeCron } from "./lib/scorecard-composite.js";
import { setAppReady } from "./lib/readiness.js";
import { processScheduledSms } from "./lib/sms-scheduler.js";

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

    // Every hour → scheduled customer-message engine. Replaces the old fixed
    // 72h/24h reminder triggers: each tenant's offset messages (built-in
    // reminders + any custom ones the office adds) carry their OWN send_hour, so
    // the engine itself decides what's due this hour. It's idempotent via the
    // job_message_sends ledger, so an hourly cadence + catch-up never
    // double-sends. (runReminderCron is retained as a copy reference but no
    // longer scheduled.)
    // Every minute → send due scheduled SMS/MMS
    processScheduledSms().catch((e: Error) => console.error("[cron] scheduled_sms error:", e));

    const schedKey = `${ctDate}-${ctH}`;
    if (fired["scheduled_messages"] !== schedKey) {
      fired["scheduled_messages"] = schedKey;
      runScheduledJobMessages().catch((e: Error) => console.error("[cron] scheduled_messages error:", e));
    }
    // [scorecard-only 2026-06-30] The generic Google-review ask (runReviewRequestCron)
    // is DISABLED — per owner decision, the only post-job feedback message is the
    // scorecard satisfaction survey (sent on job completion from /api/satisfaction/send,
    // SMS + the review_request EMAIL template carrying the tokenized survey link).
    // Re-enable here if a separate public-review ask is wanted again.
    // const hrKey = `${ctDate}-${ctH}`;
    // if (fired["review_request"] !== hrKey) {
    //   fired["review_request"] = hrKey;
    //   runReviewRequestCron().catch((e: Error) => console.error("[cron] review_request error:", e));
    // }
    // 1 AM CT → rate lock nightly checks (service gap voids, expiry voids, renewal alerts)
    if (ctH === 1 && fired["rate_lock_nightly"] !== `${ctDate}-1`) {
      fired["rate_lock_nightly"] = `${ctDate}-1`;
      runRateLockNightlyChecks().catch((e: Error) => console.error("[cron] rate_lock_nightly error:", e));
    }
    // 2 AM CT → leave accrual: grant-on-eligibility (90-day sick / 1-year
    // PTO gates) + work-anniversary reset (re-front-load on each employee's
    // benefit-year boundary) for every leave-enabled tenant. Gated by
    // LEAVE_ACCRUAL_ENABLED (default OFF) — no balance writes until Sal
    // signs off and flips the Railway env var.
    if (ctH === 2 && fired["leave_accrual"] !== `${ctDate}-2`) {
      fired["leave_accrual"] = `${ctDate}-2`;
      runLeaveAccrualCron(ctDate).catch((e: Error) => console.error("[cron] leave_accrual error:", e));
    }
    // 3 AM CT → recompute the 90-day rolling composite scorecard for every tech
    // so the trailing window advances daily even on days with no survey /
    // attendance / complaint events. Event-driven recomputes (survey response,
    // attendance confirm, complaint) keep it fresh in between.
    if (ctH === 3 && fired["scorecard_composite"] !== `${ctDate}-3`) {
      fired["scorecard_composite"] = `${ctDate}-3`;
      runScorecardCompositeCron().catch((e: Error) => console.error("[cron] scorecard_composite error:", e));
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

// ── Boot-resilience timeout wrapper ───────────────────────────────────────────
// 2026-06-19 (production-outage hardening): a degraded DB — slow, recovering,
// or with a full volume — can make a query HANG indefinitely. A try/catch can
// NOT rescue a hang (it never throws), so a single stuck schema statement
// before app.listen() stalls boot and the platform returns 502. This wrapper
// races a pre-listen startup task against a hard timeout. On timeout we LOG and
// CONTINUE to listen rather than block: incomplete schema DDL is idempotent and
// retried on the next cold start, and binding the port lets the app serve reads
// while the DB recovers. The underlying promise keeps running detached, so we
// attach a no-op .catch to it to keep a late rejection from surfacing as an
// unhandledRejection and killing the process.
const SCHEMA_TIMEOUT_MS = 15_000;   // bounded ensure*/DDL + quick checks
const MIGRATION_TIMEOUT_MS = 45_000; // the larger mixed schema+seed migrations

function withBootTimeout<T>(
  label: string,
  ms: number,
  task: () => Promise<T>,
): Promise<T | void> {
  let promise: Promise<T>;
  try {
    promise = task();
  } catch (err) {
    // Synchronous throw before any await — surface to the caller's try/catch.
    return Promise.reject(err);
  }
  // Detach: if we time out, we stop awaiting but the task keeps running.
  // Swallow its eventual outcome so a late rejection can't crash the process.
  promise.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(
        `[startup] ${label} — exceeded ${ms}ms, continuing to listen (DDL is idempotent, retries next cold start)`,
      );
      resolve();
    }, ms);
  });

  return Promise.race([
    promise.then((v) => {
      if (timer) clearTimeout(timer);
      return v;
    }),
    timeout,
  ]);
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
//
// 2026-06-19 (production-outage hardening): the schema/migration work that
// MUST precede listen (so /quiz/submit and /handbook/sign never hit a missing
// column) now runs through withBootTimeout() so a degraded/full DB cannot hang
// boot forever — on timeout we log and listen anyway. Heavy NON-schema DATA
// work that does NOT gate request correctness (job-history live-bridge sync,
// onboarding-password bootstrap, LMS recompute backfills) moved AFTER listen,
// fire-and-forget. The schema DDL that those data ops depend on
// (ensureJobHistoryLiveBridgeSchema) STAYS before listen.
async function runStartupMigrations() {
  // [invoice-service-date 2026-07-03] Additive nullable column for the manual
  // service-date override. Runs FIRST and is instant (nullable, no default), so
  // the column exists before the API gate opens and before any query references
  // invoices.service_date. Idempotent — safe on every cold start.
  try {
    await withBootTimeout("addInvoiceServiceDateColumn", SCHEMA_TIMEOUT_MS, async () => {
      const { db } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS service_date date`);
    });
  } catch (err: any) {
    console.error("[startup] addInvoiceServiceDateColumn — non-fatal:", err?.message ?? err);
  }
  try {
    await withBootTimeout("seedIfNeeded", MIGRATION_TIMEOUT_MS, () => seedIfNeeded());
  } catch (err: any) {
    console.error("[startup] seedIfNeeded — non-fatal:", err?.message ?? err);
  }
  try {
    await withBootTimeout("runPhesDataMigration", MIGRATION_TIMEOUT_MS, () => runPhesDataMigration());
  } catch (err: any) {
    console.error("[startup] runPhesDataMigration — non-fatal:", err?.message ?? err);
  }
  try {
    await withBootTimeout("runUserCompaniesMigration", SCHEMA_TIMEOUT_MS, () => runUserCompaniesMigration());
  } catch (err: any) {
    console.error("[startup] runUserCompaniesMigration — non-fatal:", err?.message ?? err);
  }
  try {
    await withBootTimeout("runCutoverDataMigration", MIGRATION_TIMEOUT_MS, () => runCutoverDataMigration());
  } catch (err: any) {
    console.error("[startup] runCutoverDataMigration — non-fatal:", err?.message ?? err);
  }
  // [auto-promos 2026-06-21] auto_promos table + seed 15% offers for co1/co4.
  try {
    await withBootTimeout("runAutoPromosMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runAutoPromosMigration } = await import("./lib/auto-promos.js");
      await runAutoPromosMigration([1, 4]);
    });
  } catch (err: any) {
    console.error("[startup] runAutoPromosMigration — non-fatal:", err?.message ?? err);
  }
  // [help-guides 2026-06-21] guides table + placeholder tech guide seed.
  try {
    await withBootTimeout("runGuidesMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runGuidesMigration } = await import("./lib/guides-migrate.js");
      await runGuidesMigration();
    });
  } catch (err: any) {
    console.error("[startup] runGuidesMigration — non-fatal:", err?.message ?? err);
  }
  // [comms-opt-out 2026-06-21] clients.sms_opt_out_at / email_opt_out_at /
  // email_unsub_token columns + token backfill + unique index.
  try {
    await withBootTimeout("runCommsOptOutMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runCommsOptOutMigration } = await import("./lib/opt-out.js");
      await runCommsOptOutMigration();
    });
  } catch (err: any) {
    console.error("[startup] runCommsOptOutMigration — non-fatal:", err?.message ?? err);
  }
  // [team-photo-notes] team_photo_notes table (pictures + notes attached to a
  // job or made sticky to a customer/property).
  try {
    await withBootTimeout("runTeamPhotoNotesMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runTeamPhotoNotesMigration } = await import("./lib/team-photo-notes-migrate.js");
      await runTeamPhotoNotesMigration();
    });
  } catch (err: any) {
    console.error("[startup] runTeamPhotoNotesMigration — non-fatal:", err?.message ?? err);
  }
  // [customer-messages 2026-06-26] customer_message_schedules + job_message_sends
  // tables + ledger backfill from the legacy reminder_*_sent flags (so the new
  // engine never re-sends an already-reminded job).
  try {
    await withBootTimeout("runCustomerMessagesMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runCustomerMessagesMigration } = await import("./lib/customer-messages.js");
      await runCustomerMessagesMigration();
    });
  } catch (err: any) {
    console.error("[startup] runCustomerMessagesMigration — non-fatal:", err?.message ?? err);
  }
  // [reschedule-label-backfill 2026-06-29] correct historical reschedules that the
  // legacy cancellation-log path stored with a NULL action, so the Activity feed
  // stops showing past reschedules as "Cancelled". Scoped to rows whose note marks
  // them a reschedule; never touches a genuine cancellation. Idempotent.
  try {
    await withBootTimeout("runRescheduleLabelBackfill", SCHEMA_TIMEOUT_MS, async () => {
      const { runRescheduleLabelBackfill } = await import("./lib/reschedule-label-backfill.js");
      await runRescheduleLabelBackfill();
    });
  } catch (err: any) {
    console.error("[startup] runRescheduleLabelBackfill — non-fatal:", err?.message ?? err);
  }
  // [notif-prefs] customer_notification_preferences — per-client/per-account
  // sparse override table controlling WHICH customer messages fire on WHICH
  // channel. No rows seeded: absence = inherit tenant default (all on).
  try {
    await withBootTimeout("runNotificationPreferencesMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runNotificationPreferencesMigration } = await import("./lib/notification-preferences.js");
      await runNotificationPreferencesMigration();
    });
  } catch (err: any) {
    console.error("[startup] runNotificationPreferencesMigration — non-fatal:", err?.message ?? err);
  }
  // [booking-confirmation GAP1] token column + job_scheduled SMS template (all tenants)
  try {
    await withBootTimeout("ensureBookingConfirmationSetup", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureBookingConfirmationSetup } = await import("./lib/booking-confirmation.js");
      await ensureBookingConfirmationSetup();
    });
  } catch (err: any) {
    console.error("[startup] ensureBookingConfirmationSetup — non-fatal:", err?.message ?? err);
  }
  // [time-change-notice 2026-06-30] jobs.time_change_pending / time_change_from
  // columns + job_time_updated SMS+email templates (all tenants).
  try {
    await withBootTimeout("ensureTimeChangeNoticeSetup", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureTimeChangeNoticeSetup } = await import("./lib/time-change-notice.js");
      await ensureTimeChangeNoticeSetup();
    });
  } catch (err: any) {
    console.error("[startup] ensureTimeChangeNoticeSetup — non-fatal:", err?.message ?? err);
  }
  // [invoicing-engine] backfill clients.payment_source (stripe if card on file, else square)
  try {
    await withBootTimeout("ensurePaymentSourceBackfill", SCHEMA_TIMEOUT_MS, async () => {
      const { ensurePaymentSourceBackfill } = await import("./lib/payment-source-backfill.js");
      await ensurePaymentSourceBackfill();
    });
  } catch (err: any) {
    console.error("[startup] ensurePaymentSourceBackfill — non-fatal:", err?.message ?? err);
  }
  // [GAP3] office-reply columns on scorecard_entries
  try {
    await withBootTimeout("ensureScorecardReplyColumns", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureScorecardReplyColumns } = await import("./lib/scorecard-engine.js");
      await ensureScorecardReplyColumns();
    });
  } catch (err: any) {
    console.error("[startup] ensureScorecardReplyColumns — non-fatal:", err?.message ?? err);
  }
  // [90d-composite] users.score_*_90d / scorecard_composite_90d + companies
  // .score_weight_* columns for the rolling composite scorecard.
  try {
    await withBootTimeout("ensureCompositeScoreColumns", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureCompositeScoreColumns } = await import("./lib/scorecard-composite.js");
      await ensureCompositeScoreColumns();
    });
  } catch (err: any) {
    console.error("[startup] ensureCompositeScoreColumns — non-fatal:", err?.message ?? err);
  }
  // [sms Pass3] short-link table + customer-facing SMS copy upgrade
  try {
    await withBootTimeout("sms Pass3 setup", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureShortLinkTable } = await import("./lib/short-link.js");
      await ensureShortLinkTable();
      const { upgradeCustomerSmsCopy } = await import("./lib/sms-copy.js");
      await upgradeCustomerSmsCopy();
    });
  } catch (err: any) {
    console.error("[startup] sms Pass3 setup — non-fatal:", err?.message ?? err);
  }
  // [multi-frequency] quotes.frequency_options snapshot column
  try {
    await withBootTimeout("ensureQuotePricingSetup", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureQuotePricingSetup } = await import("./lib/quote-pricing.js");
      await ensureQuotePricingSetup();
    });
  } catch (err: any) {
    console.error("[startup] ensureQuotePricingSetup — non-fatal:", err?.message ?? err);
  }
  try {
    await withBootTimeout("ensurePayrollP0Setup", SCHEMA_TIMEOUT_MS, async () => {
      const { ensurePayrollP0Setup } = await import("./lib/payroll-migrate.js");
      await ensurePayrollP0Setup();
    });
  } catch (err: any) {
    console.error("[startup] ensurePayrollP0Setup — non-fatal:", err?.message ?? err);
  }
  try {
    await withBootTimeout("ensurePayrollSnapshotSetup", SCHEMA_TIMEOUT_MS, async () => {
      const { ensurePayrollSnapshotSetup } = await import("./lib/payroll-snapshot.js");
      await ensurePayrollSnapshotSetup();
    });
  } catch (err: any) {
    console.error("[startup] ensurePayrollSnapshotSetup — non-fatal:", err?.message ?? err);
  }
  // [sms-mms-scheduling] media_urls column + scheduled_sms table
  try {
    await withBootTimeout("ensureSmsMmsSchema", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureSmsMmsSchema } = await import("./lib/sms-mms-schema.js");
      await ensureSmsMmsSchema();
    });
  } catch (err: any) {
    console.error("[startup] ensureSmsMmsSchema — non-fatal:", err?.message ?? err);
  }
  // [revenue-connect 2026-06-12] job_history live bridge — mirrors completed
  // jobs into the revenue ledger past each tenant's MC-import end date, so
  // the dashboard forecast / business health / client history stay live
  // after the MC cutover instead of freezing at the last imported week.
  // Only the SCHEMA is ensured here (the hourly sync + dashboard reads depend
  // on it); the heavy data SYNC that walks completed jobs moved AFTER listen
  // (see runPostListenDataTasks) so it can't stall boot on a degraded DB.
  try {
    await withBootTimeout("ensureJobHistoryLiveBridgeSchema", SCHEMA_TIMEOUT_MS, () =>
      ensureJobHistoryLiveBridgeSchema(),
    );
  } catch (err: any) {
    console.error("[startup] ensureJobHistoryLiveBridgeSchema — non-fatal:", err?.message ?? err);
  }
  // [refunds 2026-06-27] invoices.refunded_amount / refund_reason / refunded_at columns.
  try {
    await withBootTimeout("ensureInvoiceRefundColumns", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureInvoiceRefundColumns } = await import("./lib/invoice-refund-migrate.js");
      await ensureInvoiceRefundColumns();
    });
  } catch (err: any) {
    console.error("[startup] ensureInvoiceRefundColumns — non-fatal:", err?.message ?? err);
  }
  // [commission-override 2026-06-27] jobs.commission_override_pct — per-job pool rate override.
  try {
    await withBootTimeout("ensureCommissionOverrideColumn", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureCommissionOverrideColumn } = await import("./lib/commission-override-migrate.js");
      await ensureCommissionOverrideColumn();
    });
  } catch (err: any) {
    console.error("[startup] ensureCommissionOverrideColumn — non-fatal:", err?.message ?? err);
  }
}

// [boot-resilience 2026-06-24] Bind the port FIRST, then run the migration
// chain in the background AFTER the server is listening. Health (/api/health,
// /api/healthz) answers the instant the port is bound, so Railway's healthcheck
// passes immediately — ending the chronic deploy-healthcheck failures caused by
// the migrations-before-listen ordering (the old code ran all 16 guarded
// migrations before app.listen(); under a slow/locked DB the cumulative
// withBootTimeout budget exceeded even a 600s healthcheck window). The
// readiness gate in app.ts holds all OTHER /api routes at 503 until the chain
// completes, so no request can hit partially-migrated schema (preserves the
// 2026-05-17 read/write-divergence fix). withBootTimeout still bounds each step,
// so the gate always opens within a bounded time even on a degraded DB.
async function startup() {
  app.listen(port, "0.0.0.0", async () => {
    console.log("Server running on port", process.env.PORT || 3000);
    // [DR runbook 2026-04-30] Static reminder visible on every cold
    // start. Surfaces backup-state in Railway logs without requiring
    // a RAILWAY_API_TOKEN credential we'd then have to manage. The
    // intent is to keep "verify backups quarterly" in the operator's
    // eyeline, not to give live timestamp data — Railway Hobby's
    // backup state changes maybe twice a year.
    // Procedure + RPO/RTO targets: docs/disaster-recovery.md
    console.log("[backup-check] static reminder: Railway Hobby plan provides daily backups, 7-day retention. Verify quarterly via dashboard. Procedure: docs/disaster-recovery.md");

    // Run the schema/data migration chain now that the port is bound. Until
    // this resolves, the app.ts readiness gate returns 503 for every non-health
    // /api route. withBootTimeout bounds each step, so the gate always opens.
    await runStartupMigrations();
    setAppReady(true);
    console.log("[startup] migrations complete — API readiness gate opened");

    // [boot-resilience 2026-06-19] Heavy NON-schema data work that does not
    // gate request correctness runs here, AFTER the port is bound, so a slow
    // or recovering DB delays these tasks instead of the whole boot (→ 502).
    // Fire-and-forget: each task self-logs and is independently guarded.
    void runPostListenDataTasks();

    // [2026-06-24] Cron control moved to the per-company
    // companies.recurring_engine_enabled flag — enforced per-tenant inside
    // generateRecurringJobs() and guarded by a per-company advisory lock, so a
    // running cron only ever generates for enabled tenants (Oak Lawn yes,
    // Schaumburg no). The legacy RECURRING_ENGINE_ENABLED env kill-switch is
    // retired now the phase/dedup fixes are in + audited.
    // RECURRING_ENGINE_ENABLED=off still forces a hard global stop (break-glass).
    // [2026-04-22 J3] Startup invocation of runRecurringJobGeneration() stays
    // removed — Railway restart cascades caused 5x concurrent runs / 270 dup
    // rows. The engine only fires via the 2 AM cron registered below.
    void (async () => {
      if (process.env.RECURRING_ENGINE_ENABLED === "off") {
        console.log("[recurring-engine] Cron HARD-STOPPED via RECURRING_ENGINE_ENABLED=off");
        return;
      }
      try {
        const { db } = await import("@workspace/db");
        const { companiesTable } = await import("@workspace/db/schema");
        const { eq } = await import("drizzle-orm");
        const enabled = await db
          .select({ id: companiesTable.id })
          .from(companiesTable)
          .where(eq(companiesTable.recurring_engine_enabled, true));
        if (enabled.length > 0) {
          startRecurringJobCron();
          console.log(`[recurring-engine] Cron started — ${enabled.length} tenant(s) enabled (DB flag)`);
        } else {
          console.log("[recurring-engine] Cron not started — no tenant has recurring_engine_enabled=true");
        }
      } catch (err) {
        console.error("[recurring-engine] cron-start flag check failed — not starting:", err);
      }
    })();

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

  // [revenue-connect 2026-06-12] Hourly job_history re-sync — keeps the
  // revenue ledger current so yesterday's completions appear in the
  // dashboard forecast next morning (the forecast reads past days from
  // job_history, not the jobs table). Cheap: set-based statements gated
  // by NOT EXISTS / IS DISTINCT FROM.
  setInterval(async () => {
    try {
      const r = await syncJobHistoryLiveBridge();
      if (r.inserted || r.updated || r.removed) {
        console.log(`[job-history-bridge] sync: +${r.inserted} ~${r.updated} -${r.removed}`);
      }
    } catch (err: any) {
      console.error("[job-history-bridge] tick failed:", err?.message);
    }
  }, 60 * 60 * 1000);

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

// [boot-resilience 2026-06-19] Post-listen data tasks. These were previously
// awaited BEFORE app.listen(); on a degraded/full DB any one of them could hang
// and stall boot → 502. They do NOT gate request correctness (the schema they
// touch is ensured before listen), so they now run after the port is bound.
// Sequential (not Promise.all) so we don't slam a recovering DB with parallel
// table scans. Each keeps its original per-task try/catch + non-fatal logging.
async function runPostListenDataTasks() {
  // [revenue-connect] job_history live bridge — mirrors completed jobs into the
  // revenue ledger so dashboard forecast / business health stay live post-cutover.
  try {
    const r = await syncJobHistoryLiveBridge();
    if (r.inserted || r.updated || r.removed) {
      console.log(`[job-history-bridge] startup sync: +${r.inserted} ~${r.updated} -${r.removed}`);
    }
  } catch (err: any) {
    console.error("[startup] job-history bridge — non-fatal:", err?.message ?? err);
  }
  // [onboarding-password 2026-06-16] Narrow login bootstrap for a stuck new
  // hire during the comms-off cutover (temp-password email can't send while
  // COMMS_ENABLED=false). Allowlist-scoped + never-logged-in guarded, so it
  // can't clobber any active password. Self-limiting: once they log in,
  // last_login_at is set and the UPDATE never matches them again.
  try {
    const n = await bootstrapOnboardingPasswords();
    if (n > 0) {
      console.log(`[onboarding-password] bootstrapped ${n} stuck onboarding login(s)`);
    }
  } catch (err: any) {
    console.error("[startup] onboarding-password bootstrap — non-fatal:", err?.message ?? err);
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
}

// Kick off startup. Any unhandled rejection here is fatal — we never
// got to app.listen, so there's nothing to serve.
startup().catch((err) => {
  console.error("[startup] FATAL:", err);
  process.exit(1);
});
