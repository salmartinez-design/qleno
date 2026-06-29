import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [reschedule-label-backfill 2026-06-29] One-time correction for the client
// Activity feed. The reschedule modal logged through the legacy
// POST /api/cancellations, which never stored cancel_action, so the feed (which
// labels any row that isn't move/bump as "Cancelled — customer request") showed
// every past reschedule as a cancellation. The forward fix sets
// cancel_action='move' on new reschedules; this corrects the historical rows.
//
// Reschedule rows are uniquely identifiable by the note the modal writes
// ("Rescheduled to <date> at <time> — <reason>"), so this ONLY touches
// reschedules and never a genuine cancellation. Idempotent: after it runs, no
// NULL-action 'Rescheduled to%' rows remain, so re-running is a no-op.
export async function runRescheduleLabelBackfill(): Promise<void> {
  const res = await db.execute(sql`
    UPDATE cancellation_log
       SET cancel_action = 'move'
     WHERE cancel_action IS NULL
       AND notes LIKE 'Rescheduled to%'`);
  const n = (res as any).rowCount ?? ((res as any).rows?.length ?? 0);
  if (n > 0) {
    console.log(`[reschedule-label-backfill] corrected ${n} reschedule row(s) previously mislabeled as cancellations`);
  }
}
