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
import { runComplaintScoreBackfill } from "./lib/complaint-score-backfill.js";
import { ensureJobHistoryLiveBridgeSchema, syncJobHistoryLiveBridge } from "./lib/job-history-sync.js";
import { bootstrapOnboardingPasswords } from "./lib/onboarding-password-backfill.js";
import { runLeaveAccrualCron } from "./lib/leave-accrual-cron.js";
import { runAutoTardySweep } from "./lib/auto-tardy.js";
import { runScorecardCompositeCron } from "./lib/scorecard-composite.js";
import { runMileageAutoCompute } from "./lib/mileage-auto-cron.js";
import { runSuspensionReminders } from "./lib/suspension.js";
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
    // [auto-tardy 2026-07-07] 1:30 AM window (runs on the 1 AM tick after
    // rate-lock) → sweep YESTERDAY's punched clock-ins: first job of each
    // tech's day, >20 min past scheduled start = a tardy occurrence through
    // the same ladder writer the office form uses. Nightly only — no boot
    // run, so an office deletion of a mistaken auto-tardy is never
    // re-inserted by a redeploy. No backfill (starts with the first run).
    if (ctH === 1 && fired["auto_tardy"] !== `${ctDate}-1`) {
      fired["auto_tardy"] = `${ctDate}-1`;
      const yd = new Date(`${ctDate}T00:00:00Z`);
      yd.setUTCDate(yd.getUTCDate() - 1);
      runAutoTardySweep(yd.toISOString().slice(0, 10)).catch((e: Error) => console.error("[cron] auto_tardy error:", e));
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
    // [mc-migration 2026-07-07] Also run ONCE at boot (first tick) when the
    // flag is enabled — flipping LEAVE_ACCRUAL_ENABLED in Railway otherwise
    // only takes effect at the next 2 AM, which left employees without
    // balances all day. Idempotent: the engine no-ops once the benefit
    // year's grant has landed.
    if (!fired["leave_accrual_boot"]) {
      fired["leave_accrual_boot"] = "done";
      runLeaveAccrualCron(ctDate, "boot").catch((e: Error) => console.error("[boot] leave_accrual error:", e));
    }
    // 3 AM CT → recompute the 90-day rolling composite scorecard for every tech
    // so the trailing window advances daily even on days with no survey /
    // attendance / complaint events. Event-driven recomputes (survey response,
    // attendance confirm, complaint) keep it fresh in between.
    if (ctH === 3 && fired["scorecard_composite"] !== `${ctDate}-3`) {
      fired["scorecard_composite"] = `${ctDate}-3`;
      runScorecardCompositeCron().catch((e: Error) => console.error("[cron] scorecard_composite error:", e));
    }
    // 4 AM CT → auto-compute mileage for every mileage-enabled tenant's open
    // period(s). The engine (On My Way → clock-sequence → scheduled failsafe)
    // existed but nothing triggered it, so payroll showed $0. This is that
    // trigger. COMPUTE only — legs land status='computed' for the office to
    // review; no pay moves. Idempotent + distance-cached, so re-runs are cheap.
    // Gated by MILEAGE_AUTO_COMPUTE_ENABLED (default ON; "off" kills it).
    if (ctH === 4 && fired["mileage_auto"] !== `${ctDate}-4` && process.env.MILEAGE_AUTO_COMPUTE_ENABLED !== "off") {
      fired["mileage_auto"] = `${ctDate}-4`;
      runMileageAutoCompute()
        .then((r) => console.log(`[cron] mileage_auto: ${r.inserted} legs across ${r.periods} period(s), ${r.companies} tenant(s)`))
        .catch((e: Error) => console.error("[cron] mileage_auto error:", e));
    }
    // Boot run (once, first tick) so flipping the env / deploying doesn't leave
    // mileage stale until 4 AM. Idempotent — inserts only new legs.
    if (!fired["mileage_auto_boot"] && process.env.MILEAGE_AUTO_COMPUTE_ENABLED !== "off") {
      fired["mileage_auto_boot"] = "done";
      runMileageAutoCompute()
        .then((r) => console.log(`[boot] mileage_auto: ${r.inserted} legs across ${r.periods} period(s), ${r.companies} tenant(s)`))
        .catch((e: Error) => console.error("[boot] mileage_auto error:", e));
    }
    // [cadence 2026-07-22] 5 AM CT → close bundled ACCOUNT billing windows.
    // Weekly accounts (National Able) fold Mon–Fri into one issued invoice on
    // Friday and email the billing contact; monthly accounts (Cucci, KMA,
    // Daveco) fold the month once it has ended, issued silently. per_job
    // accounts + residential never reach here — those already issue per visit
    // on completion. A no-op on non-close days, and idempotent per window, so
    // a redeploy or double-fire cannot bill the same week twice.
    if (ctH === 5 && fired["invoice_cadence_close"] !== `${ctDate}-5`) {
      fired["invoice_cadence_close"] = `${ctDate}-5`;
      import("./lib/invoice-cadence.js")
        .then(({ runInvoiceCadenceCron }) => runInvoiceCadenceCron(ctDate))
        .then((r) => { if (r.closed) console.log(`[cron] invoice_cadence_close: ${r.closed} window(s) closed, ${r.emailed} emailed across ${r.companies} tenant(s)`); })
        .catch((e: Error) => console.error("[cron] invoice_cadence_close error:", e));
    }
    // [service-suspension 2026-07-11] 8 AM CT → suspension lifecycle messages:
    // the 30-days-before-expiry "want to resume?" reminder + the at-expiry
    // final notice (flag for office; NO automatic cancel/resume). Idempotent
    // via the clients.suspend_*_sent_at stamps, so the once-daily cadence never
    // double-sends. Each send goes through sendNotification (COMMS_ENABLED gate
    // + email/SMS opt-out) on the editable suspension_* templates.
    if (ctH === 8 && fired["suspension_reminders"] !== `${ctDate}-8`) {
      fired["suspension_reminders"] = `${ctDate}-8`;
      runSuspensionReminders(ctDate).catch((e: Error) => console.error("[cron] suspension_reminders error:", e));
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

// [boot-guard 2026-07-22] The cold-start tasks below don't just create schema —
// they WRITE BUSINESS ROWS (super-admin upserts, the Jim Schultz job_history
// insert, and a `DELETE FROM jobs WHERE client_id = 23 ...`). Because DATABASE_URL
// points at production, simply starting the API locally to look at a page fired
// those writes against prod. Railway injects RAILWAY_ENVIRONMENT on every deploy,
// so production boots are unchanged; a laptop boot has neither variable and skips.
// Set RUN_STARTUP_MIGRATIONS=true to opt in deliberately (e.g. seeding a local DB).
const RUN_DATA_MIGRATIONS =
  !!process.env.RAILWAY_ENVIRONMENT || process.env.RUN_STARTUP_MIGRATIONS === "true";

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
    await withBootTimeout("addInvoiceColumns", SCHEMA_TIMEOUT_MS, async () => {
      const { db } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS service_date date`);
      await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_to_name text`);
      // [parking-commission 2026-07-23] Parking is a pass-through fee, never
      // commissionable. The affects_commission grandfather (ADD COLUMN DEFAULT
      // TRUE backfill, then default→false) flagged every pre-existing add-on —
      // parking included — as commissionable, so parking inflated tech
      // commission (Sal: "when we add a parking fee it seems to cascade over to
      // their commission"). Fix in two idempotent steps, gated on the flag still
      // being true so a re-run is a no-op:
      //   1. Remove the wrongly-added parking dollars from the STORED
      //      commission_base (universal — works for both residential fee-split
      //      and commercial, since it just backs out the parking amount that was
      //      added; a from-scratch recompute would need the two different
      //      formulas). Only touches jobs whose commission_base is set.
      //   2. Flip those parking add-on rows to affects_commission=false.
      // Order matters: subtract BEFORE flipping, both gated on the current TRUE
      // flag, so the second run finds nothing to subtract or flip.
      // Already-paid history isn't un-paid — payroll locks the amount at pay
      // time; this only corrects the stored base for open/future commission.
      await db.execute(sql`
        UPDATE jobs j
           SET commission_base = GREATEST(0, (j.commission_base)::numeric - park.total)
          FROM (
            SELECT ja.job_id, SUM(ja.subtotal)::numeric AS total
              FROM job_add_ons ja
              JOIN pricing_addons pa ON pa.id = ja.pricing_addon_id
             WHERE lower(pa.name) = 'parking fee' AND ja.affects_commission = true
             GROUP BY ja.job_id
          ) park
         WHERE j.id = park.job_id AND j.commission_base IS NOT NULL`);
      await db.execute(sql`
        UPDATE job_add_ons ja SET affects_commission = false
          FROM pricing_addons pa
         WHERE ja.pricing_addon_id = pa.id
           AND lower(pa.name) = 'parking fee'
           AND ja.affects_commission = true`);
      // [commission-base-stale 2026-07-23] Residential price edits refreshed
      // base_fee + billed_amount but not the STORED commission_base (the
      // recompute was commercial-only), so the tech's fee split kept paying off
      // the OLD price (Molly Rippert: billed $240 → $300, commission still on
      // ~$240). Heal existing rows, but ONLY where it's provably safe — a
      // residential, non-override job with NO add-ons and NO commissionable
      // rate-mods, where the correct commission_base is exactly base_fee. Jobs
      // WITH add-ons are left untouched (residential base_fee is all-in, so
      // resetting could double-count). Idempotent: only rows that actually
      // differ change. The going-forward fix (delta on price edit, routes/jobs.ts)
      // prevents recurrence.
      await db.execute(sql`
        UPDATE jobs j SET commission_base = (j.base_fee)::numeric
         WHERE j.commission_base IS NOT NULL
           AND (j.base_fee)::numeric IS DISTINCT FROM (j.commission_base)::numeric
           AND j.account_id IS NULL
           AND COALESCE(j.manual_rate_override, false) = false
           AND NOT EXISTS (SELECT 1 FROM job_add_ons ja WHERE ja.job_id = j.id)
           AND NOT EXISTS (SELECT 1 FROM job_rate_mods jm WHERE jm.job_id = j.id AND jm.affects_commission = true)
           AND COALESCE((SELECT c.client_type FROM clients c WHERE c.id = j.client_id), '') <> 'commercial'`);
      // [manual-edit-detach 2026-07-06] Stamped when the office hand-edits an
      // invoice's line items / tip via PUT. While set, the invoice is DETACHED
      // from job mirroring: the mark-paid pre-payment recalc and the job-edit
      // draft re-sync both skip it (Maribel: "we edit the invoice, click paid,
      // and it goes back to the old amount"). Cleared by the explicit
      // "Recalc from job" action, which deliberately re-attaches it.
      await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS manually_edited_at timestamp`);
      // [job-card-invoice-link 2026-07-06] The dispatch job card resolves a
      // job's invoice by direct FK OR by line_items containment (consolidated
      // account invoices / merge parents carry jobs inside line_items with
      // job_id NULL). Index both lookup paths.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_invoices_line_items_gin ON invoices USING gin (line_items jsonb_path_ops)`);
      // [custom-hours 2026-07-07] Time-off requests for an explicit time window
      // ("work 9am to 1pm") — new enum value + the window columns. ADD VALUE is
      // idempotent and runs outside any transaction here (plain execute).
      await db.execute(sql`ALTER TYPE leave_day_unit ADD VALUE IF NOT EXISTS 'custom'`);
      await db.execute(sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS start_time time`);
      await db.execute(sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS end_time time`);
      // [time-off-ticket 2026-07-07] Employee time-off submissions also create a
      // contact ticket on the employee (profile + Contact Tickets report).
      await db.execute(sql`ALTER TYPE contact_ticket_type ADD VALUE IF NOT EXISTS 'time_off_request'`);
      // [sms-thread-notes 2026-07-22] Internal notes on a customer conversation
      // (GHL-style). They ride in communication_log rather than a new table, so
      // they cascade to the client's Communication log for free — that timeline
      // already unions communication_log by customer_id. A note is neither
      // inbound nor outbound and isn't a real channel, hence two new enum
      // values. ADD VALUE is idempotent and must run outside a transaction
      // (plain execute), same as the leave_day_unit line above.
      await db.execute(sql`ALTER TYPE comm_channel ADD VALUE IF NOT EXISTS 'note'`);
      await db.execute(sql`ALTER TYPE comm_direction ADD VALUE IF NOT EXISTS 'internal'`);
      // Notes are looked up per conversation on every thread open.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_comm_log_note_customer
        ON communication_log(company_id, customer_id) WHERE channel = 'note'`);
      // [quote-details-carry 2026-07-07] Full widget-quote snapshot (bedrooms/
      // bathrooms/sqft/frequency/add-ons/referral/step_reached) on the lead +
      // abandoned-booking rows, so the office alert and Lead Pipeline show
      // exactly what the visitor filled out.
      await db.execute(sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS details jsonb`);
      await db.execute(sql`ALTER TABLE abandoned_bookings ADD COLUMN IF NOT EXISTS details jsonb`);
      // [source-precedence 2026-07-09] Guarantee leads.lead_source exists before
      // the public widget path writes it (upsertWidgetLead now stamps it = source
      // so online leads stop showing the "Office" chip). Mirrors the value in
      // phes-data-migration; idempotent, so no-op where it already exists.
      await db.execute(sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_source text NOT NULL DEFAULT 'manual'`);
      // [dispatch-visibility 2026-07-09] Per-employee opt-out from the dispatch
      // board. Default true so every existing tech keeps showing; the office
      // turns it OFF for placeholder / QA-test accounts (Trainee Placeholder,
      // Test Auditor) via the User Account tab toggle. NOT NULL + DEFAULT true
      // is safe on existing rows (they backfill to true). Idempotent.
      await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS show_on_dispatch boolean NOT NULL DEFAULT true`);
      // [property-link-heal 2026-07-07] Account jobs/schedules carry BOTH a
      // property link (account_property_id) and their own service address; a
      // setup mistake can point the link at the WRONG building (Daveco: the
      // 18440 Torrence schedule linked to the 18428 property), which duplicated
      // addresses on the account calendar and mis-filtered per-property views.
      // Heal: when a row's own street EXACTLY matches (case/space-insensitive)
      // the address of exactly ONE property of the same account, and the
      // currently linked property does NOT match, re-link it. Idempotent —
      // once links agree with addresses, both UPDATEs match zero rows.
      await db.execute(sql`
        UPDATE recurring_schedules rs SET account_property_id = m.pid
        FROM (
          SELECT rs2.id AS sid, MIN(ap.id) AS pid
          FROM recurring_schedules rs2
          JOIN account_properties ap ON ap.account_id = rs2.account_id
            AND lower(regexp_replace(btrim(ap.address), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(rs2.service_address_street), '\\s+', ' ', 'g'))
          WHERE rs2.account_id IS NOT NULL AND NULLIF(btrim(rs2.service_address_street), '') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM account_properties cur WHERE cur.id = rs2.account_property_id
                AND lower(regexp_replace(btrim(cur.address), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(rs2.service_address_street), '\\s+', ' ', 'g'))
            )
          GROUP BY rs2.id HAVING COUNT(DISTINCT ap.id) = 1
        ) m
        WHERE rs.id = m.sid AND rs.account_property_id IS DISTINCT FROM m.pid
      `);
      await db.execute(sql`
        UPDATE jobs j SET account_property_id = m.pid
        FROM (
          SELECT j2.id AS jid, MIN(ap.id) AS pid
          FROM jobs j2
          JOIN account_properties ap ON ap.account_id = j2.account_id
            AND lower(regexp_replace(btrim(ap.address), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(j2.address_street), '\\s+', ' ', 'g'))
          WHERE j2.account_id IS NOT NULL AND NULLIF(btrim(j2.address_street), '') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM account_properties cur WHERE cur.id = j2.account_property_id
                AND lower(regexp_replace(btrim(cur.address), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(j2.address_street), '\\s+', ' ', 'g'))
            )
          GROUP BY j2.id HAVING COUNT(DISTINCT ap.id) = 1
        ) m
        WHERE j.id = m.jid AND j.account_property_id IS DISTINCT FROM m.pid
      `);
      // [account-recurrence 2026-07-03] Account recurrences have no client; the
      // account is the billing entity. Idempotent (no-op once dropped).
      await db.execute(sql`ALTER TABLE recurring_schedules ALTER COLUMN customer_id DROP NOT NULL`);
      // [account-payment 2026-07-03] A payment on a commercial/account invoice
      // has no individual client — Mark Paid on Cucci/PPM/National Able 500'd on
      // the payments.client_id NOT NULL constraint. Drop it. Idempotent.
      await db.execute(sql`ALTER TABLE payments ALTER COLUMN client_id DROP NOT NULL`);
    });
  } catch (err: any) {
    console.error("[startup] addInvoiceColumns — non-fatal:", err?.message ?? err);
  }
  // [dispatch-events 2026-07-14] Non-job board entries (tech blocks, company-day
  // markers, non-job client visits) created from + New → Event. Additive table,
  // no FK touches existing rows, so this is safe on every cold start. Idempotent.
  try {
    await withBootTimeout("ensureDispatchEventsSchema", SCHEMA_TIMEOUT_MS, async () => {
      const { db } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS dispatch_events (
          id serial PRIMARY KEY,
          company_id integer NOT NULL REFERENCES companies(id),
          branch_id integer REFERENCES branches(id),
          kind text NOT NULL DEFAULT 'tech_block',
          title text NOT NULL,
          assigned_user_id integer REFERENCES users(id),
          client_id integer REFERENCES clients(id),
          event_date date NOT NULL,
          start_time time,
          end_time time,
          all_day boolean NOT NULL DEFAULT false,
          notes text,
          color text,
          created_by_user_id integer REFERENCES users(id),
          created_at timestamp NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_dispatch_events_company_date ON dispatch_events(company_id, event_date)`);
      // [event-address 2026-07-15] Additive column on the existing table.
      await db.execute(sql`ALTER TABLE dispatch_events ADD COLUMN IF NOT EXISTS address text`);
    });
  } catch (err: any) {
    console.error("[startup] ensureDispatchEventsSchema — non-fatal:", err?.message ?? err);
  }
  // [one-on-ones 2026-07-14] Owner-only quarterly 1-on-1 records. Additive table
  // (depends on dispatch_events above for the optional block link). Idempotent.
  try {
    await withBootTimeout("ensureOneOnOnesSchema", SCHEMA_TIMEOUT_MS, async () => {
      const { db } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS one_on_ones (
          id serial PRIMARY KEY,
          company_id integer NOT NULL REFERENCES companies(id),
          employee_id integer NOT NULL REFERENCES users(id),
          manager_id integer REFERENCES users(id),
          period_label text NOT NULL,
          event_date date NOT NULL,
          dispatch_event_id integer REFERENCES dispatch_events(id),
          scorecard_pct numeric,
          scorecard_snapshot jsonb,
          questions jsonb,
          responses jsonb,
          notes text,
          status text NOT NULL DEFAULT 'scheduled',
          created_by_user_id integer REFERENCES users(id),
          created_at timestamp NOT NULL DEFAULT now(),
          completed_at timestamp
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_one_on_ones_company_emp ON one_on_ones(company_id, employee_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_one_on_ones_company_period ON one_on_ones(company_id, period_label)`);
    });
  } catch (err: any) {
    console.error("[startup] ensureOneOnOnesSchema — non-fatal:", err?.message ?? err);
  }
  // [event-clock 2026-07-15] A tech's clock-in/out on a dispatch event (paid
  // hourly, separate from the job timeclock). Additive; depends on
  // dispatch_events above. Idempotent.
  try {
    await withBootTimeout("ensureEventTimeclockSchema", SCHEMA_TIMEOUT_MS, async () => {
      const { db } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS event_timeclock (
          id serial PRIMARY KEY,
          company_id integer NOT NULL REFERENCES companies(id),
          dispatch_event_id integer NOT NULL REFERENCES dispatch_events(id),
          user_id integer NOT NULL REFERENCES users(id),
          clock_in_at timestamptz NOT NULL DEFAULT now(),
          clock_out_at timestamptz,
          paid_hours numeric(6,2),
          paid_rate numeric(10,2),
          pay_adjustment_id integer,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS event_timeclock_event_user_idx ON event_timeclock(dispatch_event_id, user_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS event_timeclock_company_user_idx ON event_timeclock(company_id, user_id)`);
    });
  } catch (err: any) {
    console.error("[startup] ensureEventTimeclockSchema — non-fatal:", err?.message ?? err);
  }
  // [square-map 2026-07-22] Square ↔ Qleno customer map. Resolves an incoming
  // Square customer_id to the Qleno client / account / property that owns it,
  // so payments can be reconciled back to invoices. Additive table only — it
  // does not touch clients/accounts here, and creating it charges nothing.
  // Populated on demand by lib/square-customer-map.ts (idempotent). Idempotent.
  try {
    await withBootTimeout("ensureSquareCustomerMapSchema", SCHEMA_TIMEOUT_MS, async () => {
      const { db } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS square_customer_map (
          id serial PRIMARY KEY,
          company_id integer NOT NULL REFERENCES companies(id),
          square_customer_id text NOT NULL,
          square_customer_name text,
          square_email text,
          square_company_name text,
          square_phone text,
          square_address text,
          square_postal text,
          square_created_at timestamptz,
          client_id integer REFERENCES clients(id),
          account_id integer REFERENCES accounts(id),
          account_property_id integer REFERENCES account_properties(id),
          square_card_id text,
          card_brand text,
          card_last4 text,
          card_exp text,
          card_count integer NOT NULL DEFAULT 0,
          status text NOT NULL DEFAULT 'needs_review',
          match_method text,
          match_score numeric(5,2),
          review_reason text,
          email_mismatch boolean NOT NULL DEFAULT false,
          is_account_primary boolean NOT NULL DEFAULT false,
          linked_at timestamptz,
          linked_by_user_id integer REFERENCES users(id),
          reviewed_at timestamptz,
          reviewed_by_user_id integer REFERENCES users(id),
          first_seen_at timestamptz NOT NULL DEFAULT now(),
          last_synced_at timestamptz NOT NULL DEFAULT now(),
          candidates jsonb
        )
      `);
      // The idempotency key the sync upserts on.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_square_map_company_customer ON square_customer_map(company_id, square_customer_id)`);
      // The webhook lookup path: a payment arrives carrying a Square customer_id.
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_square_map_square_customer ON square_customer_map(square_customer_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_square_map_client ON square_customer_map(client_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_square_map_account ON square_customer_map(account_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_square_map_status ON square_customer_map(company_id, status)`);
    });
  } catch (err: any) {
    console.error("[startup] ensureSquareCustomerMapSchema — non-fatal:", err?.message ?? err);
  }
  try {
    // [auto-issue-toggle 2026-07-22] The two manual overrides on auto-invoicing.
    // Both default to "auto-issue behaves as before", so an existing row is
    // never silently switched off by the migration itself.
    await withBootTimeout("ensureAutoIssueOverrideSchema", SCHEMA_TIMEOUT_MS, async () => {
      const { db } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS auto_issue_enabled boolean NOT NULL DEFAULT true`);
      await db.execute(sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS invoice_hold boolean NOT NULL DEFAULT false`);
    });
  } catch (err: any) {
    console.error("[startup] ensureAutoIssueOverrideSchema — non-fatal:", err?.message ?? err);
  }
  try {
    // [manual-charging-policy 2026-07-22] Auto-charge is OFF by default.
    // Charging is a manual act (Square, then mark paid by hand), so a newly
    // created account must never auto-charge until someone enables it.
    //
    // SET DEFAULT only changes what a future INSERT gets when the column is
    // omitted. It does NOT rewrite, re-validate, or even scan existing rows —
    // no table rewrite, no lock beyond a brief ACCESS EXCLUSIVE on the
    // catalog entry. The 22 existing accounts were flipped as a separate,
    // snapshotted data write; this statement deliberately backfills nothing,
    // so an account someone later turns ON stays on across deploys.
    await withBootTimeout("ensureAutoChargeDefaultOff", SCHEMA_TIMEOUT_MS, async () => {
      const { db } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`ALTER TABLE accounts ALTER COLUMN auto_charge_on_completion SET DEFAULT false`);
    });
  } catch (err: any) {
    console.error("[startup] ensureAutoChargeDefaultOff — non-fatal:", err?.message ?? err);
  }
  try {
    // [square-webhook 2026-07-22] Square payment reconciliation ledger. The
    // unique index is the idempotency guarantee — Square retries any non-2xx,
    // and without it a retry would credit the same invoice twice.
    await withBootTimeout("ensureSquarePaymentEventsSchema", SCHEMA_TIMEOUT_MS, async () => {
      const { db } = await import("@workspace/db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS square_payment_events (
          id serial PRIMARY KEY,
          company_id integer NOT NULL REFERENCES companies(id),
          square_payment_id text NOT NULL,
          square_customer_id text,
          square_order_id text,
          square_location_id text,
          event_type text,
          square_status text,
          amount numeric(10,2) NOT NULL,
          currency text NOT NULL DEFAULT 'USD',
          card_brand text,
          card_last4 text,
          square_created_at timestamp,
          resolution text NOT NULL DEFAULT 'needs_review',
          review_reason text,
          resolved_client_id integer REFERENCES clients(id),
          resolved_account_id integer REFERENCES accounts(id),
          matched_invoice_id integer REFERENCES invoices(id),
          applied_payment_id integer REFERENCES payments(id),
          candidate_invoice_ids jsonb,
          raw jsonb,
          created_at timestamp NOT NULL DEFAULT now(),
          processed_at timestamp,
          reviewed_at timestamp,
          reviewed_by_user_id integer
        )`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_square_payment_company_payment ON square_payment_events (company_id, square_payment_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_square_payment_customer ON square_payment_events (square_customer_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_square_payment_resolution ON square_payment_events (company_id, resolution)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_square_payment_invoice ON square_payment_events (matched_invoice_id)`);
      // Distinct from stripe_payment_id so the originating processor of any
      // payment row stays unambiguous.
      await db.execute(sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS square_payment_id text`);
    });
  } catch (err: any) {
    console.error("[startup] ensureSquarePaymentEventsSchema — non-fatal:", err?.message ?? err);
  }
  if (!RUN_DATA_MIGRATIONS) {
    console.log("[startup] skipping seedIfNeeded + data migrations — not a Railway boot (set RUN_STARTUP_MIGRATIONS=true to force)");
  }
  if (RUN_DATA_MIGRATIONS) {
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
  }
  try {
    await withBootTimeout("runUserCompaniesMigration", SCHEMA_TIMEOUT_MS, () => runUserCompaniesMigration());
  } catch (err: any) {
    console.error("[startup] runUserCompaniesMigration — non-fatal:", err?.message ?? err);
  }
  if (RUN_DATA_MIGRATIONS) {
    try {
      await withBootTimeout("runCutoverDataMigration", MIGRATION_TIMEOUT_MS, () => runCutoverDataMigration());
    } catch (err: any) {
      console.error("[startup] runCutoverDataMigration — non-fatal:", err?.message ?? err);
    }
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
  // [attendance-attachments 2026-07-11] attendance_attachments table (files on
  // an unexcused-absence / tardy record — injury photos, doctor's notes).
  try {
    await withBootTimeout("runAttendanceAttachmentsMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runAttendanceAttachmentsMigration } = await import("./lib/attendance-attachments-migrate.js");
      await runAttendanceAttachmentsMigration();
    });
  } catch (err: any) {
    console.error("[startup] runAttendanceAttachmentsMigration — non-fatal:", err?.message ?? err);
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
  // [service-suspension 2026-07-11] clients.suspend_* columns + recurring_
  // schedules.paused_by_suspension marker.
  try {
    await withBootTimeout("runSuspensionMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runSuspensionMigration } = await import("./lib/suspension.js");
      await runSuspensionMigration();
    });
  } catch (err: any) {
    console.error("[startup] runSuspensionMigration — non-fatal:", err?.message ?? err);
  }
  // [lead-referral-source 2026-07-22] leads.referral_source column + backfill of
  // the answers the booking widget already collected into details.
  try {
    await withBootTimeout("runLeadReferralSourceMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runLeadReferralSourceMigration } = await import("./routes/leads.js");
      await runLeadReferralSourceMigration();
    });
  } catch (err: any) {
    console.error("[startup] runLeadReferralSourceMigration — non-fatal:", err?.message ?? err);
  }
  // [system-schedule-log 2026-07-21] Relax job_audit_log.user_id NOT NULL so the
  // recurrence engine can log "Qleno scheduled this" as a system actor.
  try {
    await withBootTimeout("runAutoScheduleAuditMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runAutoScheduleAuditMigration } = await import("./lib/recurring-jobs.js");
      await runAutoScheduleAuditMigration();
    });
  } catch (err: any) {
    console.error("[startup] runAutoScheduleAuditMigration — non-fatal:", err?.message ?? err);
  }
  // [monthly-weekday 2026-07-21] Add 'monthly_weekday' to the jobs frequency enum
  // so last-Friday-of-month recurrences can be created/generated.
  try {
    await withBootTimeout("runMonthlyWeekdayEnumMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runMonthlyWeekdayEnumMigration } = await import("./lib/recurring-jobs.js");
      await runMonthlyWeekdayEnumMigration();
    });
  } catch (err: any) {
    console.error("[startup] runMonthlyWeekdayEnumMigration — non-fatal:", err?.message ?? err);
  }
  // [tech-pref-accounts 2026-07-21] technician_preferences.account_id + relax
  // client_id NOT NULL so tech preferences can be scoped to a commercial account.
  try {
    await withBootTimeout("ensureTechPrefAccountColumns", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureTechPrefAccountColumns } = await import("./routes/accounts.js");
      await ensureTechPrefAccountColumns();
    });
  } catch (err: any) {
    console.error("[startup] ensureTechPrefAccountColumns — non-fatal:", err?.message ?? err);
  }
  // [redo-service 2026-07-10] jobs.redo_of_job_id / non_billable +
  // quality_complaints.reason_category / areas / redo_job_id.
  try {
    await withBootTimeout("runRedoServiceMigration", SCHEMA_TIMEOUT_MS, async () => {
      const { runRedoServiceMigration } = await import("./lib/redo-service.js");
      await runRedoServiceMigration();
    });
  } catch (err: any) {
    console.error("[startup] runRedoServiceMigration — non-fatal:", err?.message ?? err);
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
  // [referral-program] referrals table + program columns (widget Give $25 /
  // Get $25 flow: referrer capture, lead link, credited stamp).
  try {
    await withBootTimeout("ensureReferralSetup", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureReferralSetup } = await import("./lib/referrals.js");
      await ensureReferralSetup();
    });
  } catch (err: any) {
    console.error("[startup] ensureReferralSetup — non-fatal:", err?.message ?? err);
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
  // [agreement-multi-view] last_viewed_at + view_count on form_submissions
  try {
    await withBootTimeout("ensureAgreementViewColumns", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureAgreementViewColumns, ensureLateFeeTermsColumn, ensureAgreementClauseColumns } = await import("./lib/agreement-view-tracking.js");
      await ensureAgreementViewColumns();
      await ensureLateFeeTermsColumn();
      await ensureAgreementClauseColumns();
    });
  } catch (err: any) {
    console.error("[startup] ensureAgreementViewColumns — non-fatal:", err?.message ?? err);
  }
  // [card-link-chargeable] recover clients.stripe_payment_method_id from Stripe for
  // cards saved via the card-on-file link before 2026-07-22 (display fields were
  // stored but not the chargeable id). MUST run BEFORE ensurePaymentSourceBackfill
  // so a recovered card derives to 'stripe' rather than defaulting to 'square'.
  try {
    await withBootTimeout("ensureStripePaymentMethodBackfill", SCHEMA_TIMEOUT_MS, async () => {
      const { ensureStripePaymentMethodBackfill } = await import("./lib/stripe-payment-method-backfill.js");
      await ensureStripePaymentMethodBackfill();
    });
  } catch (err: any) {
    console.error("[startup] ensureStripePaymentMethodBackfill — non-fatal:", err?.message ?? err);
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
      const { upgradeCustomerSmsCopy, ensurePerPackageBookingSms } = await import("./lib/sms-copy.js");
      await upgradeCustomerSmsCopy();
      await ensurePerPackageBookingSms();
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
  // [complaint-satisfaction 2026-07-24] Backfill the 1-of-4 satisfaction hit for
  // cleaners who already had valid complaints / redos before the feature shipped
  // (PR #1241). Self-terminating — only touches un-scored jobs, so it does no
  // work after the first cold start. Non-fatal.
  try {
    const r = await runComplaintScoreBackfill();
    if (r.jobs_synced > 0 || r.errors > 0) {
      console.log(
        `[complaint-score-backfill] scanned=${r.jobs_scanned} synced=${r.jobs_synced} errors=${r.errors}`,
      );
    }
  } catch (err: any) {
    console.error("[startup] runComplaintScoreBackfill — non-fatal:", err?.message ?? err);
  }
}

// Kick off startup. Any unhandled rejection here is fatal — we never
// got to app.listen, so there's nothing to serve.
startup().catch((err) => {
  console.error("[startup] FATAL:", err);
  process.exit(1);
});
