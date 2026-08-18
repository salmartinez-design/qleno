// ─────────────────────────────────────────────────────────────────────────────
// Turning an online booking into a real recurring series.
//
// [online-recurring 2026-07-20] A customer who picks "every 2 weeks" in the
// widget must end up with an actual recurring_schedule, not a single orphan
// visit the office has to notice and rebuild by hand (the Jennifer Nuno bug).
//
// [online-recurring-shared 2026-08-18] Lifted out of POST /book/confirm so the
// non-Stripe POST /book fallback runs the identical code. It used to have no
// recurring handling at all, so if Stripe were ever switched off, every
// recurring booking would silently degrade to a one-time visit — a failure that
// would only surface weeks later when the second cleaning never happened.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { findActiveScheduleForTarget } from "./recurring-tombstone.js";

export const RECURRING_CADENCES = ["weekly", "biweekly", "every_3_weeks", "monthly"];

/** jobs.frequency enum: weekly | biweekly | every_3_weeks | monthly | on_demand */
export function normalizeBookingFrequency(f: string | null | undefined): string {
  const v = (f || "").toLowerCase().replace(/[\s-]/g, "_");
  if (v === "onetime" || v === "one_time" || v === "one_time_standard" || v === "on_demand") return "on_demand";
  if (v === "biweekly" || v === "every_2_weeks") return "biweekly";
  if (v === "every_3_weeks") return "every_3_weeks";
  if (v === "monthly" || v === "every_4_weeks") return "monthly";
  if (v === "weekly") return "weekly";
  return "on_demand";
}

export interface OnlineRecurringInput {
  companyId: number;
  clientId: number;
  jobId: number;               // the visit already inserted for the chosen date
  frequency: string;           // already normalized
  firstVisitDate: string;      // YYYY-MM-DD
  serviceType: string;         // jobs.service_type enum slug
  scheduledTime: string | null;// "09:00:00"
  hours: number | null;        // per-visit hours, drives duration + allowed_hours
  perVisitPrice: number;       // the agreed price for one visit
  zip: string | null;          // for branch routing during generation
}

/**
 * Give an online booking a recurring series: adopt the customer's existing
 * schedule when they already have one, otherwise create theirs, then pull the
 * booked visit into it and materialize the upcoming occurrences.
 *
 * Never throws — a booking must not fail because the series couldn't be built.
 */
export async function adoptOnlineBookingIntoSeries(o: OnlineRecurringInput): Promise<void> {
  const durationMin = (o.hours != null && Number(o.hours) > 0) ? Math.round(Number(o.hours) * 60) : null;
  const allowedHrs = (o.hours != null && Number(o.hours) > 0) ? Number(o.hours).toFixed(2) : null;
  try {
    const { recurringSchedulesTable } = await import("@workspace/db/schema");

    // [recurring-uniqueness 2026-08-04] A returning customer who already
    // repeats must NOT get a second series stood up beside the first — that
    // is how one house ends up stacked on one day, and the DB now rejects it
    // outright, which would have failed the whole booking. Adopt them into
    // the schedule they already have.
    //
    // Deliberately reuse WITHOUT overwriting: this is a public, unauthenticated
    // endpoint, so a widget selection must never rewrite the cadence, price, or
    // visit length the office negotiated with an existing customer. The booked
    // visit still lands on the date they picked; the office gets told about the
    // mismatch rather than the system silently choosing a side.
    const existingSchedId = await findActiveScheduleForTarget(db, {
      companyId: o.companyId,
      clientId: o.clientId,
    });
    let sched: any;
    if (existingSchedId) {
      const existing = await db.execute(sql`
        SELECT * FROM recurring_schedules WHERE id = ${existingSchedId} LIMIT 1
      `);
      sched = (existing.rows as any[])[0];
      console.log(`[online-recurring] client ${o.clientId} already has schedule ${existingSchedId} (${sched?.frequency}) — adopting booking into it instead of creating a second series (widget asked for ${o.frequency})`);
      if (sched?.frequency !== o.frequency) {
        try {
          await db.execute(sql`
            INSERT INTO notifications (company_id, type, title, body, link)
            VALUES (
              ${o.companyId}, 'recurring_report',
              ${"Online booking asked for a different frequency"},
              ${`This customer books ${sched?.frequency} with us, but chose ${o.frequency} online. Their existing schedule was left as-is — confirm which one is right.`},
              ${`/clients/${o.clientId}`}
            )
          `);
        } catch { /* alert is best-effort; never fail a booking over it */ }
      }
    } else {
      [sched] = await db.insert(recurringSchedulesTable).values({
        company_id: o.companyId,
        customer_id: o.clientId,
        frequency: o.frequency as any,
        day_of_week: null,                 // null → cadence anchors on start_date's weekday
        start_date: o.firstVisitDate as any,
        end_date: null,
        service_type: o.serviceType as any,
        scheduled_time: o.scheduledTime as any,
        duration_minutes: durationMin,
        base_fee: String(o.perVisitPrice),  // = the first job's agreed per-visit price
        notes: `Created from online booking widget — customer selected ${o.frequency}.`,
      }).returning();
    }

    // Adopt the already-created first visit into the series (dedup skips this
    // slot; allowed_hours stamped so the first job's hours cell isn't blank).
    await db.execute(sql`
      UPDATE jobs
         SET recurring_schedule_id = ${sched.id},
             occurrence_date = ${o.firstVisitDate}::date,
             allowed_hours = COALESCE(allowed_hours, ${allowedHrs})
       WHERE id = ${o.jobId} AND company_id = ${o.companyId}
    `);

    // Materialize the upcoming occurrences now so the office sees the full
    // series immediately (single-schedule generation is safe; the first date
    // is deduped via the occurrence_date we just stamped on the first job).
    try {
      const { generateJobsFromSchedule, DAYS_AHEAD } = await import("./recurring-jobs.js");
      const genNow = new Date();
      const genHorizon = new Date(genNow.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
      const gen = await generateJobsFromSchedule(sched as any, genNow, genHorizon, null, o.zip ?? null);
      console.log(`[online-recurring] schedule ${sched.id} client ${o.clientId} (${o.frequency}) — first job ${o.jobId} adopted, ${gen.created} upcoming visit(s) generated`);
    } catch (genErr) {
      console.error("[online-recurring] inline generation failed (schedule created; 2 AM cron will backfill):", genErr);
    }
  } catch (recurErr) {
    console.error("[online-recurring] failed to create recurring_schedule for booking job", o.jobId, recurErr);
  }
}
