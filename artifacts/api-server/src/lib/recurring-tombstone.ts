import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/**
 * [tombstone-both-dates 2026-08-04] ONE writer for "this occurrence must never
 * come back". Both the DELETE path (routes/jobs.ts) and the cancellation SKIP
 * path (routes/cancellation.ts) used to inline their own copy of this, and both
 * copies carried the same two defects:
 *
 *   1. They tombstoned `occurrence_date ?? scheduled_date` — the cadence slot
 *      ONLY. A moved visit sits on a different day than the slot it was born
 *      from, so cancelling it protected the ORIGINAL day and left the day it
 *      actually occupies wide open. The engine then regenerated a fresh visit
 *      right on top of the one the office had just cancelled. (Maribel, Aug 3:
 *      cancelled Chris Schultz's 8/6 visit — job 5740, occurrence 8/3 — and it
 *      came back the next morning because only 8/3 was tombstoned.) A 2026-08-04
 *      audit found 28 cancelled moved visits sitting in exactly that state.
 *
 *   2. They resolved the schedule with `ORDER BY is_active DESC, id DESC
 *      LIMIT 1` — ONE schedule. Nine Phes clients carry more than one active
 *      schedule (Daniel Walter 9, KMA 6, Kathryn Galley 6, Cucci 4...), so the
 *      skip landed on one of them and every sibling regenerated the occurrence
 *      on the next nightly run. This is the mechanical half of "we cancel it
 *      and Qleno keeps rebooking it".
 *
 * Both dates, every matching schedule. Idempotent — safe to call twice, and
 * safe on a job with no recurring linkage at all (no-op).
 *
 * MUST run inside the same transaction as the delete/cancel it belongs to (pass
 * `exec`): a delete without its tombstone is exactly the state the engine
 * repopulates. See [stale-alert-fix 2026-07-07].
 */
export async function tombstoneOccurrence(
  exec: any,
  args: {
    companyId: number;
    scheduleId?: number | null;
    clientId?: number | null;
    accountId?: number | null;
    accountPropertyId?: number | null;
    /** the cadence slot the visit was born from (jobs.occurrence_date) */
    occurrenceDate?: string | Date | null;
    /** the day the visit actually sits on (jobs.scheduled_date) */
    scheduledDate?: string | Date | null;
  },
): Promise<{ schedules: number[]; dates: string[] }> {
  const toStr = (d: string | Date | null | undefined): string | null => {
    if (!d) return null;
    if (d instanceof Date) {
      // Local-midnight formatting — a UTC slice() shifts the date back a day
      // for any timestamp west of Greenwich (KNOWN_BUGS.md #4).
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
    return String(d).slice(0, 10);
  };

  const dates = Array.from(
    new Set([toStr(args.occurrenceDate), toStr(args.scheduledDate)].filter(Boolean) as string[]),
  );
  if (dates.length === 0) return { schedules: [], dates: [] };

  // Every schedule that could regenerate this slot for this target — not just
  // the one the job happens to be linked to. Unlinked jobs (recurring_schedule_id
  // NULL, the MaidCentral-import norm) resolve purely by target, which is why the
  // target lookup runs even when scheduleId is set.
  const isAcct = args.accountId != null;
  const ids = new Set<number>();
  if (args.scheduleId != null) ids.add(Number(args.scheduleId));

  if (isAcct || args.clientId != null) {
    const found = await exec.execute(sql`
      SELECT id FROM recurring_schedules
       WHERE company_id = ${args.companyId}
         AND (is_active OR paused_by_suspension)
         AND ${isAcct
        ? sql`account_id = ${args.accountId} AND account_property_id IS NOT DISTINCT FROM ${args.accountPropertyId ?? null}`
        : sql`customer_id = ${args.clientId}`}
    `);
    for (const r of found.rows as any[]) ids.add(Number(r.id));
  }
  if (ids.size === 0) return { schedules: [], dates };

  // `= ANY(${jsArray})` never binds through Drizzle — see the ANY(array) trap in
  // KNOWN_BUGS. Expand both lists explicitly.
  const idList = sql.join(Array.from(ids).map((i) => sql`${i}`), sql`, `);
  const dateList = sql.join(dates.map((d) => sql`${d}::date`), sql`, `);

  await exec.execute(sql`
    UPDATE recurring_schedules
       SET skipped_dates = ARRAY(
             SELECT DISTINCT unnest(COALESCE(skipped_dates, '{}'::date[]) || ARRAY[${dateList}])
           )
     WHERE company_id = ${args.companyId}
       AND id IN (${idList})
  `);

  return { schedules: Array.from(ids), dates };
}

/**
 * [no-parallel-schedules 2026-08-04] Returns the id of the ACTIVE recurring
 * schedule that already covers this target (a residential client, or an
 * account+property), or null.
 *
 * Callers that are about to create a schedule must reuse the returned id
 * instead of inserting a second one. Editing a recurrence used to INSERT
 * unconditionally, so every save produced a brand-new parallel series anchored
 * one occurrence later than the last. Kathryn Galley (client 1226) ended up
 * with six active biweekly schedules created within five minutes on 2026-07-27
 * — start dates 8/20, 9/3, 9/17, 10/1, 10/15, 10/29 — and because every-other-
 * week from six staggered anchors converges, all six landed a visit on
 * 2026-10-29. The dispatch board showed her stacked six deep. Nine Phes clients
 * and six account properties were in this state when the audit ran.
 *
 * Scope note: the target for an account schedule is account + PROPERTY, not the
 * account. One account legitimately runs many properties, each with its own
 * cadence (Daniel Walter / KMA / Cucci). Collapsing to account_id alone would
 * merge unrelated buildings.
 */
export async function findActiveScheduleForTarget(
  exec: any,
  args: {
    companyId: number;
    clientId?: number | null;
    accountId?: number | null;
    accountPropertyId?: number | null;
    /** exclude a schedule being edited in place */
    excludeId?: number | null;
  },
): Promise<number | null> {
  const isAcct = args.accountId != null;
  if (!isAcct && args.clientId == null) return null;
  const res = await exec.execute(sql`
    SELECT id FROM recurring_schedules
     WHERE company_id = ${args.companyId}
       AND is_active
       AND ${args.excludeId != null ? sql`id <> ${args.excludeId}` : sql`TRUE`}
       AND ${isAcct
      ? sql`account_id = ${args.accountId} AND account_property_id IS NOT DISTINCT FROM ${args.accountPropertyId ?? null}`
      : sql`account_id IS NULL AND customer_id = ${args.clientId}`}
     ORDER BY id ASC
     LIMIT 1
  `);
  const id = (res.rows[0] as any)?.id;
  return id != null ? Number(id) : null;
}

/** Convenience wrapper for callers that already hold the job row. */
export async function tombstoneJobOccurrence(
  exec: any,
  companyId: number,
  job: {
    recurring_schedule_id?: number | null;
    occurrence_date?: string | Date | null;
    occ?: string | null;
    scheduled_date?: string | Date | null;
    sched?: string | null;
    client_id?: number | null;
    account_id?: number | null;
    account_property_id?: number | null;
  } | null | undefined,
) {
  if (!job) return { schedules: [], dates: [] };
  return tombstoneOccurrence(exec ?? db, {
    companyId,
    scheduleId: job.recurring_schedule_id ?? null,
    clientId: job.client_id ?? null,
    accountId: job.account_id ?? null,
    accountPropertyId: job.account_property_id ?? null,
    occurrenceDate: job.occurrence_date ?? job.occ ?? null,
    scheduledDate: job.scheduled_date ?? job.sched ?? null,
  });
}
