/**
 * LMS helpers — small pure utilities used by `routes/lms.ts` and exercised
 * directly by the LMS test suite. Extracted so the deadline math (and the
 * webhook firing) can be unit-tested without dragging in the db driver,
 * which is what `routes/lms.ts` would otherwise load at import time.
 */

/**
 * Fire a webhook to the configured Make.com endpoint. Fire-and-forget — we
 * await locally to surface errors in logs but never let a webhook failure
 * fail the user request. URL comes from MAKE_LMS_WEBHOOK_URL env; if unset,
 * we log and skip (matches the OPTIONAL_VARS pattern at server boot).
 *
 * Lives in this helpers file (not routes/lms.ts) so the webhook test can
 * import it without triggering the drizzle/pg driver to load against the
 * test's stub DATABASE_URL.
 */
export async function fireLmsWebhook(
  event: "module_complete" | "all_complete",
  payload: Record<string, unknown>,
): Promise<void> {
  const url = process.env.MAKE_LMS_WEBHOOK_URL;
  if (!url) {
    console.warn(`[lms] MAKE_LMS_WEBHOOK_URL not configured; skipped ${event}`);
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, ...payload }),
    });
    if (!res.ok) {
      console.error(
        `[lms] webhook ${event} returned ${res.status}; payload=${JSON.stringify(
          payload,
        )}`,
      );
    }
  } catch (err) {
    console.error(`[lms] webhook ${event} threw:`, err);
  }
}

/** Add `days` (UTC) to a base Date, returning a new Date. Idempotent. */
export function addDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Days remaining until `deadline`. Uses Math.floor on BOTH branches so:
 *   - 6.7 days → 6  (the tech still has 6 full calendar days)
 *   - -0.3 days → -1 (the tech is overdue by 1 day's worth of calendar time)
 *
 * Math.ceil on the negative branch hides the first day of overdue (the
 * spec calls this out explicitly: "Use Math.floor on negative daysUntil so
 * overdue renders correctly"). Using floor uniformly keeps the function
 * monotonic — slightly past midnight becomes -1 cleanly.
 */
export function daysUntil(
  deadline: Date | string,
  now: Date = new Date(),
): number {
  const d = typeof deadline === "string" ? new Date(deadline) : deadline;
  const ms = d.getTime() - now.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}
