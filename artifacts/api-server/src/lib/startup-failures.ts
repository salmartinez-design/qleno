// [startup-failures-loud 2026-08-09] A registry for cold-start migration steps
// that failed.
//
// WHY THIS EXISTS: every step in runStartupMigrations() sits in its own
// try/catch that logs one line — "[startup] <name> — non-fatal:" — and moves on.
// That is the right BOOT behaviour (one broken step must never block the port
// from binding), but it is terrible VISIBILITY behaviour: the line scrolls past
// in a 400-line boot log between two hundred successful steps, and nobody ever
// reads it. Two real incidents came out of exactly that:
//   • #1349 shipped invoice_job_links EMPTY in production — its backfill threw,
//     the guard swallowed it as "non-fatal", and every billed visit read as
//     unbilled until #1352.
//   • The [commission-base-stale 2026-07-23] heal has NEVER once run. Its
//     COALESCE(..., '') against the client_type enum throws on every single
//     cold start and has been swallowed every single time since July.
//
// So: keep the non-blocking behaviour, drop the silence. Each failure is
// recorded here, a loud banner listing all of them prints at the END of the
// chain (where an operator actually looks), and /api/health reports them so a
// broken step is visible without reading logs at all.

export type StartupFailure = {
  step: string;
  message: string;
  at: string;
};

const failures: StartupFailure[] = [];

/**
 * Record a startup step that failed, and log it. Boot continues — this is
 * bookkeeping plus a log line, never a throw.
 */
export function recordStartupFailure(step: string, err: unknown): void {
  let message =
    err instanceof Error ? err.message : String((err as any)?.message ?? err);
  // Drizzle wraps driver errors as "Failed query: <the entire SQL>" and hides the
  // actual Postgres message on .cause. Without this the banner shows a wall of
  // SQL and never the one line that says WHY — which is how "invalid input value
  // for enum client_type" stayed invisible for two weeks.
  const cause = (err as any)?.cause;
  const causeMessage = cause?.message ? String(cause.message) : null;
  if (causeMessage && !message.includes(causeMessage)) {
    message = `${causeMessage} — ${message}`;
  }
  // Keep the banner readable; the full SQL is rarely the useful part.
  if (message.length > 400) message = `${message.slice(0, 400)}…`;
  failures.push({ step, message, at: new Date().toISOString() });
  console.error(`[startup] ${step} — FAILED (non-fatal, boot continues):`, message);
}

export function getStartupFailures(): StartupFailure[] {
  return failures.slice();
}

/**
 * Print the end-of-chain summary. Called once, right before the readiness gate
 * opens, so it lands at the bottom of the boot log instead of buried mid-scroll.
 */
export function reportStartupFailures(): void {
  if (failures.length === 0) {
    console.log("[startup] all migration steps completed with no failures");
    return;
  }
  const bar = "!".repeat(72);
  console.error(bar);
  console.error(
    `[startup] !!! ${failures.length} STARTUP STEP${failures.length === 1 ? "" : "S"} FAILED — the API is serving traffic anyway.`,
  );
  console.error("[startup] !!! Each one below did NOT run. Schema or data it was");
  console.error("[startup] !!! responsible for is missing or stale RIGHT NOW.");
  for (const f of failures) {
    console.error(`[startup] !!!   - ${f.step}: ${f.message}`);
  }
  console.error("[startup] !!! Also visible at GET /api/health -> startup_failures");
  console.error(bar);
}
