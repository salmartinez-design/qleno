/**
 * Late-reschedule fee — charging for a move made too close to the visit.
 *
 * Maribel, 8/19: "when rescheduling a job within 48 hours, we should be able to
 * charge fee or to generate an invoice" — and, on the workaround the office had
 * been using: "doesnt make sense to have to cancel it and schedule it again,
 * this messes with the stats and isn't practical."
 *
 * She is right that the workaround is worse than the gap. Cancelling and
 * rebooking to collect a fee writes a cancellation into the record for a visit
 * that is still happening, so the cancellation reports, the client's history and
 * the recurring cadence all describe something that did not occur — and it costs
 * the office three screens to do.
 *
 * ── WHY THIS IS NOT resolveCancellationPolicy ────────────────────────────────
 *
 * A cancellation fee REPLACES the job's price: the visit is called off, the job
 * is stamped 'complete', and billed_amount becomes the fee so revenue picks it
 * up. A late-reschedule fee is the opposite shape — the visit STILL HAPPENS, on
 * the new date, at its full price. The fee is an ADDITIONAL charge sitting
 * beside it.
 *
 * Running it through the cancellation engine would overwrite billed_amount with
 * the fee and flip the job to 'complete' — destroying the price of a job that is
 * still on the calendar. Hence a separate resolver, a separate invoice, and a
 * cancellation_log row that stays cancel_action='move'.
 *
 * ── THE WINDOW ───────────────────────────────────────────────────────────────
 *
 * 48 hours, measured from NOW to the visit's ORIGINAL start — not the new one.
 * The customer is being charged for the notice they gave, and notice is about
 * the appointment they are moving away from: a Thursday 9 AM job moved on
 * Wednesday night is late whether it lands next week or next month.
 *
 * A shared constant for now, like LATE_THRESHOLD_MINUTES in the dispatch
 * status logic. Later → company_attendance_policy-style tenant settings.
 */
import { DEFAULT_TZ } from "./company-tz.js";

/** Notice below this many hours makes a move chargeable. */
export const LATE_RESCHEDULE_WINDOW_HOURS = 48;

/**
 * A date (YYYY-MM-DD) + a scheduled_time text as a Date in WALL-CLOCK frame —
 * UTC components hold the tenant's local digits, so it is comparable to
 * `tenantNowWallClock` below without either one touching the server's timezone.
 *
 * A job with no scheduled_time anchors at midnight: an all-day visit's notice is
 * measured from the start of its day, which is the reading that favours the
 * customer.
 */
export function scheduledStartWallClock(dateStr: string | null, timeStr: string | null): Date | null {
  if (!dateStr) return null;
  let hh = 0, mm = 0;
  if (timeStr) {
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i.exec(String(timeStr).trim());
    if (m) {
      hh = parseInt(m[1], 10);
      mm = parseInt(m[2], 10);
      const ap = m[3]?.toUpperCase();
      if (ap === "PM" && hh < 12) hh += 12;
      if (ap === "AM" && hh === 12) hh = 0;
      if (hh > 23 || mm > 59) { hh = 0; mm = 0; }
    }
  }
  const d = new Date(`${dateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** "Now" in the tenant's local digits, in the same wall-clock frame. */
export function tenantNowWallClock(instant: Date, tz: string = DEFAULT_TZ): Date {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(instant);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  let hh = g("hour"); if (hh === "24") hh = "00";
  return new Date(`${g("year")}-${g("month")}-${g("day")}T${hh}:${g("minute")}:${g("second")}Z`);
}

export interface RescheduleNotice {
  /** Hours between now and the ORIGINAL start. Negative once it has passed. */
  hours_notice: number | null;
  /** True when the move is inside the window (a fee may be charged). */
  is_late: boolean;
  window_hours: number;
}

export function resolveRescheduleNotice(opts: {
  scheduledDate: string | null;
  scheduledTime: string | null;
  now: Date;
  tz?: string;
  windowHours?: number;
}): RescheduleNotice {
  const windowHours = opts.windowHours ?? LATE_RESCHEDULE_WINDOW_HOURS;
  const start = scheduledStartWallClock(opts.scheduledDate, opts.scheduledTime);
  if (!start) return { hours_notice: null, is_late: false, window_hours: windowHours };
  const now = tenantNowWallClock(opts.now, opts.tz);
  const hours = (start.getTime() - now.getTime()) / 3_600_000;
  return {
    hours_notice: Math.round(hours * 100) / 100,
    // A visit already in the past is late too — the office moving yesterday's
    // missed job is the most short-notice case there is.
    is_late: hours < windowHours,
    window_hours: windowHours,
  };
}
