/**
 * Is this job still a visit someone drives to?
 *
 * THE BUG THIS CLOSES (Maribel, 8/19): "Very important. When we skip a service
 * with fee, it doesn't disappear from the cleaners schedule." — "They can still
 * see it."
 *
 * Peggy Hanlon, every-2-weeks visit #10, 1:00–4:00 PM, note reading
 * `[cancel_fee_charged: $195.00 (100%)]`. The office had called the visit off
 * and billed the fee, and the card was still sitting on the cleaner's day
 * looking exactly like work: allowed hours, arrival window, Add note, Before
 * Photos.
 *
 * WHY IT LOOKED LIVE. A CHARGED cancellation is deliberately stored as
 * `status = 'complete'` with billed_amount set to the fee, so revenue reports
 * pick it up cleanly (see routes/cancellation.ts). A FREE one is stored as
 * `status = 'cancelled'`, which the tech app already greys out. So the charged
 * case — the one that costs the customer money and sends nobody — was the one
 * case the tech app had no way to recognise. Neither tech read path
 * (/api/tech/today, /api/jobs/my-jobs) filtered on status at all; the free
 * cancels were only ever caught by a client-side `status !== "cancelled"`.
 *
 * The authority is the cancellation_log row, not the status column: status is
 * overloaded ('complete' means both "cleaned" and "billed a fee for nothing"),
 * while the log says plainly what was done and by whom. Same predicate shape
 * the post-visit survey already uses to avoid thanking a customer for a visit
 * that never happened ([stale-alert-fix 2026-07-07] in notificationService).
 *
 * A tech left looking at a phantom job doesn't just waste a drive — they can
 * clock into it, and every hours, efficiency and commission number downstream
 * believes the clock.
 */
import { sql, type SQL } from "drizzle-orm";
import { NO_VISIT_ACTIONS } from "./cancellation-policy.js";

const NO_VISIT_LIST = sql.join(
  [...NO_VISIT_ACTIONS].map((a) => sql`${a}`),
  sql`, `,
);

/**
 * SQL predicate: TRUE when this job still belongs on `userId`'s schedule.
 *
 * Pass the jobs id column/expression and the viewing tech. Add it to the WHERE
 * of any read that answers "what am I doing today" for a cleaner. Do NOT add it
 * to office surfaces — dispatch has to show a charged cancellation (it renders
 * a charged_cancel badge and the fee), and so do the billing screens.
 *
 * THE OPEN-PUNCH ESCAPE HATCH. A lockout is discovered ON SITE: the crew drives
 * over, cannot get in, and by then they may already be clocked in. Hiding the
 * job the moment the office records the cancellation would strand that punch —
 * and an open punch is not harmless, it BLOCKS the tech's next clock-in
 * ("You're still clocked in at Peggy Hanlon…", the one-clock-at-a-time rule in
 * routes/timeclock.ts). They would have to phone the office to be freed for
 * their next house.
 *
 * So a called-off job stays visible to a tech who still has it running, and
 * only to them, until they clock out. Everyone else loses it immediately.
 */
export function jobVisitStillHappens(jobId: SQL | unknown, userId: SQL | unknown): SQL {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM cancellation_log cl
       WHERE cl.job_id = ${jobId}
         AND cl.cancel_action IN (${NO_VISIT_LIST})
    )
    OR EXISTS (
      SELECT 1 FROM timeclock tc
       WHERE tc.job_id = ${jobId}
         AND tc.user_id = ${userId}
         AND tc.clock_out_at IS NULL
    )
  )`;
}
