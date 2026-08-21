import { db } from "@workspace/db";
import { recurringSchedulesTable, clientsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { generateJobsFromSchedule, DAYS_AHEAD } from "./recurring-jobs.js";
import { normalizeRecurringFreq } from "./recurring-cadences.js";
import { findActiveScheduleForTarget } from "./recurring-tombstone.js";

// [mcp-writes 2026-08-19] The one implementation of "make this customer repeat".
//
// Same reasoning as lib/quote-send.ts and lib/employee-admin.ts: creating a
// schedule is not one INSERT, it is a uniqueness decision, a cadence
// normalization, a day-of-week normalization, and then ninety days of visits
// written to the board. Two copies of that drift, and the drift shows up as
// visits on the wrong days that nobody catches until the invoices come out.
//
// ONE ACTIVE SCHEDULE PER CLIENT. The DB enforces it, so a second call for a
// client who already repeats is a cadence CHANGE, not a request for a parallel
// series — it updates the existing row. `skipped_dates` is deliberately left
// alone: visits the office deleted must not come back because the cadence
// changed.

export type RecurringCreateInput = {
  companyId: number;
  customer_id: number;
  frequency: string;
  start_date: string;
  /** 0=Sun..6=Sat. Several-times-a-week cadences live here, not in day_of_week. */
  days_of_week?: number[] | null;
  day_of_week?: string | null;
  end_date?: string | null;
  scheduled_time?: string | null;
  assigned_employee_id?: number | null;
  service_type?: string | null;
  duration_minutes?: number | null;
  base_fee?: string | number | null;
  notes?: string | null;
};

export type RecurringCreateResult = {
  row: any;
  /** True when an existing active schedule was rewritten instead of a new one inserted. */
  updated_existing: boolean;
  jobs_generated: number;
  jobs_skipped: number;
  /** Set when the 90-day generation threw. The row still exists; the cron will catch it. */
  generation_error: string | null;
};

/**
 * Normalize a several-times-a-week cadence.
 *
 * The engine reads `days_of_week` (an int array) on the daily / weekdays /
 * custom_days path and the scalar `day_of_week` on the weekly path. When both
 * are set it warns and prefers the array, so sending an array CLEARS the scalar
 * here rather than leaving a contradiction on the row for a future reader to
 * resolve differently.
 */
export function normalizeDaysOfWeek(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const days = Array.from(
    new Set(raw.map((d: any) => Number(d)).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6)),
  ).sort((a, b) => a - b);
  return days.length ? days : null;
}

export async function createRecurringSchedule(input: RecurringCreateInput): Promise<RecurringCreateResult> {
  const companyId = input.companyId;

  // [biweekly-fix 2026-07-27] Canonicalize every_2_weeks -> biweekly so the
  // recurring_frequency enum insert doesn't reject it (and the engine agrees).
  const frequency = normalizeRecurringFreq(input.frequency);
  const multiDays = normalizeDaysOfWeek(input.days_of_week);

  const existingId = await findActiveScheduleForTarget(db, {
    companyId,
    clientId: Number(input.customer_id),
  });

  const values = {
    company_id: companyId,
    customer_id: Number(input.customer_id),
    frequency: frequency as any, // normalizeRecurringFreq returns string; column wants the enum union
    day_of_week: multiDays?.length ? null : (input.day_of_week || null),
    days_of_week: multiDays?.length ? multiDays : null,
    start_date: input.start_date,
    end_date: input.end_date || null,
    scheduled_time: input.scheduled_time || null,
    assigned_employee_id: input.assigned_employee_id || null,
    service_type: input.service_type || null,
    duration_minutes: input.duration_minutes || null,
    base_fee: input.base_fee != null && input.base_fee !== "" ? String(input.base_fee) : null,
    notes: input.notes || null,
  };

  const [row] = existingId
    ? await db.update(recurringSchedulesTable).set(values as any)
        .where(and(
          eq(recurringSchedulesTable.id, existingId),
          eq(recurringSchedulesTable.company_id, companyId),
        )).returning()
    : await db.insert(recurringSchedulesTable).values(values as any).returning();

  if (existingId) {
    console.log(`[recurring create] client ${input.customer_id} already had schedule ${existingId} — updated it instead of creating a duplicate`);
  }

  // [scheduling-engine 2026-04-29] Synchronously generate the next 90 days of
  // occurrences so the dispatch board, the client calendar, and the routing
  // system all see the schedule immediately — not after the 2 AM cron. Without
  // this, the office creates a recurring schedule and stares at an empty board
  // for hours wondering if the engine is broken. The engine's own dedupe
  // (recurring_schedule_id + scheduled_date) makes the sync run idempotent if
  // the cron also fires for these dates.
  let generated = { created: 0, skipped: 0 };
  let generationError: string | null = null;
  try {
    const cl = await db.select({ zip: clientsTable.zip })
      .from(clientsTable)
      .where(eq(clientsTable.id, Number(input.customer_id)))
      .limit(1);
    const clientZip = (cl[0]?.zip as any) ?? null;
    const today = new Date();
    const horizon = new Date(today.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
    generated = await generateJobsFromSchedule(row as any, today, horizon, null, clientZip);
  } catch (genErr: any) {
    // Don't fail the schedule creation if generation hiccups — the nightly cron
    // will catch it. But surface the error to the caller so the operator knows
    // to check the logs rather than assuming an empty board means an empty
    // schedule.
    generationError = genErr?.message ?? String(genErr);
    console.warn("[recurring create] sync generation failed:", generationError);
  }

  return {
    row,
    updated_existing: !!existingId,
    jobs_generated: generated.created,
    jobs_skipped: generated.skipped,
    generation_error: generationError,
  };
}
