/**
 * Cutover 2A (corrective) — Mileage computation core.
 *
 * Pure async function: given a set of on-my-way legs, a way to
 * resolve job → client coordinates, a dated rate lookup function, a
 * driving-distance provider, and the tenant's timezone, returns the
 * per-leg outcomes (eligible / six skip reasons).
 *
 * What it pays: client-to-client legs that are NOT the day's bookends.
 *
 * Explicit bookend exclusion (not by field-app convention):
 *
 *   - First leg of the tech's calendar day → skip_first_leg_of_day.
 *     This catches the home→first-job leg even if the field app one
 *     day starts writing from_job_id for that first OMW. The first
 *     leg is the one with the earliest sent_at per (user_id,
 *     calendar day).
 *
 *   - Office / home / any non-job waypoint → skip_no_from_job.
 *     A leg is reimbursable ONLY when the tech is leaving an actual
 *     client job (from_job_id NOT NULL). An OMW fired from the
 *     office or from home naturally lacks from_job_id and is dropped.
 *
 *   - Last-job → home: NO OMW fires after the last clock-out, so no
 *     row exists for this leg in on_my_way_events. It is excluded by
 *     data shape, not by code; the test suite documents this.
 *
 * Dated rate: caller passes a function (date) → rate$/mi or null.
 * Pre-2A-corrective used `companies.mileage_rate` directly; this
 * version routes through mileage_rates so a rate change preserves
 * history.
 *
 * Computed-not-paid: the output spec carries `amount_cents` and the
 * provenance, but the route INSERTs into mileage_legs (status:
 * 'computed'). Nothing flows into pay_adjustments or pay_period
 * gross_total until 2B applies the leg.
 */
import type { DistanceProvider, LegMeasurement } from "./distance-provider.js";

/** Minimal shape from `on_my_way_events` that mileage cares about. */
export type MileageLegInput = {
  /** PK from on_my_way_events. Becomes source_on_my_way_event_id. */
  id: number;
  user_id: number;
  /** Job the tech is LEAVING. Null = not leaving a client job
   *  (home, office, supply run). Drops as skip_no_from_job. */
  from_job_id: number | null;
  /** Job the OMW is heading TO. Always present (NOT NULL in schema). */
  to_job_id: number;
  /** The tech actually sent the OMW; null = draft → skip. */
  sent_at: Date | null;
};

/** Coordinate lookup result for a job's client. */
export type JobCoords = {
  lat: number;
  lng: number;
};

/** Outcome per leg. */
export type LegOutcome =
  | { kind: "eligible"; spec: MileageLegSpec }
  | {
      kind:
        | "skip_first_leg_of_day"
        | "skip_no_from_job"
        | "skip_no_sent_at"
        | "skip_no_from_coords"
        | "skip_no_to_coords"
        | "skip_no_rate"
        | "skip_provider_null";
      leg_id: number;
      user_id: number;
    };

/** One row to be INSERTed into mileage_legs (status: 'computed'). */
export type MileageLegSpec = {
  source_on_my_way_event_id: number;
  user_id: number;
  from_job_id: number;
  to_job_id: number;
  /** Calendar date of the leg (tenant TZ). The rate row used was the
   *  one in effect on this date. */
  leg_date: string;
  miles: number;
  minutes: number;
  rate_per_mile: number;
  amount_cents: number;
  measurement_source: LegMeasurement["source"];
  measurement_is_estimated: boolean;
};

/** Round to 2 decimal places without float drift. */
export function roundMiles(miles: number): number {
  return Math.round(miles * 100) / 100;
}

/** miles × rate → integer cents. Both operands are scaled to
 *  integers before multiplying so JS float drift (e.g. 3 × 0.725
 *  yielding 2.17499999…) cannot push a half-up case to the wrong
 *  cent. Safe domain: miles up to 1_000_000, rate up to 1.0 →
 *  product well under 2^53. */
export function computeAmountCents(miles: number, ratePerMile: number): number {
  const milesHundredths = Math.round(miles * 100);
  const rateTenThousandths = Math.round(ratePerMile * 10000);
  return Math.round((milesHundredths * rateTenThousandths) / 10000);
}

const METERS_PER_MILE = 1609.344;

/** Format a Date as the tenant's calendar day (YYYY-MM-DD). 2A only
 *  ships Phes today (America/Chicago), but rather than hardcode that,
 *  the caller passes a function. Tests use a UTC formatter. */
export type DateToCalendarDay = (d: Date) => string;

/** Rate-as-of-date lookup. Returns null when no rate row applies. */
export type RateForDate = (date: string) => number | null;

/**
 * Compute mileage leg specs for a batch of legs.
 *
 * @param legs              Legs to evaluate.
 * @param coordsByJobId     Pre-loaded job → client coords.
 * @param rateForDate       Dated rate lookup (mileage_rates).
 * @param provider          DistanceProvider (cached + adapted by the
 *                          factory at the route level).
 * @param toCalendarDay     Date → YYYY-MM-DD in the tenant's TZ.
 */
export async function computeMileageForLegs(
  legs: ReadonlyArray<MileageLegInput>,
  coordsByJobId: ReadonlyMap<number, JobCoords>,
  rateForDate: RateForDate,
  provider: DistanceProvider,
  toCalendarDay: DateToCalendarDay,
): Promise<LegOutcome[]> {
  // Identify the first leg of each (user_id, calendar day). The set
  // of legs to drop = the legs with the earliest sent_at in their
  // (user, day) group. Drafts (sent_at = null) cannot be "first" —
  // they're skipped separately as skip_no_sent_at.
  const firstLegIdByUserDay = new Map<string, number>();
  const earliestSentByUserDay = new Map<string, number>();
  for (const leg of legs) {
    if (leg.sent_at == null) continue;
    const key = `${leg.user_id}|${toCalendarDay(leg.sent_at)}`;
    const ts = leg.sent_at.getTime();
    const prev = earliestSentByUserDay.get(key);
    if (prev == null || ts < prev) {
      earliestSentByUserDay.set(key, ts);
      firstLegIdByUserDay.set(key, leg.id);
    }
  }

  const outcomes: LegOutcome[] = [];
  for (const leg of legs) {
    if (leg.sent_at == null) {
      outcomes.push({
        kind: "skip_no_sent_at",
        leg_id: leg.id,
        user_id: leg.user_id,
      });
      continue;
    }
    const dayKey = toCalendarDay(leg.sent_at);
    const userDayKey = `${leg.user_id}|${dayKey}`;
    if (firstLegIdByUserDay.get(userDayKey) === leg.id) {
      // Bookend: first leg of the tech's day is home→first-job.
      // Excluded regardless of from_job_id.
      outcomes.push({
        kind: "skip_first_leg_of_day",
        leg_id: leg.id,
        user_id: leg.user_id,
      });
      continue;
    }
    if (leg.from_job_id == null) {
      // Not leaving a client job (office / home / supply run /
      // anything not modeled as a client visit).
      outcomes.push({
        kind: "skip_no_from_job",
        leg_id: leg.id,
        user_id: leg.user_id,
      });
      continue;
    }
    const from = coordsByJobId.get(leg.from_job_id);
    if (!from) {
      outcomes.push({
        kind: "skip_no_from_coords",
        leg_id: leg.id,
        user_id: leg.user_id,
      });
      continue;
    }
    const to = coordsByJobId.get(leg.to_job_id);
    if (!to) {
      outcomes.push({
        kind: "skip_no_to_coords",
        leg_id: leg.id,
        user_id: leg.user_id,
      });
      continue;
    }
    const ratePerMile = rateForDate(dayKey);
    if (ratePerMile == null) {
      // No mileage_rates row in effect for this date. Flag, do not
      // fall back to a hardcoded rate.
      outcomes.push({
        kind: "skip_no_rate",
        leg_id: leg.id,
        user_id: leg.user_id,
      });
      continue;
    }
    const measurement = await provider.measureLeg(
      from.lat,
      from.lng,
      to.lat,
      to.lng,
    );
    if (measurement == null) {
      outcomes.push({
        kind: "skip_provider_null",
        leg_id: leg.id,
        user_id: leg.user_id,
      });
      continue;
    }
    const miles = roundMiles(measurement.meters / METERS_PER_MILE);
    const amountCents = computeAmountCents(miles, ratePerMile);
    outcomes.push({
      kind: "eligible",
      spec: {
        source_on_my_way_event_id: leg.id,
        user_id: leg.user_id,
        from_job_id: leg.from_job_id,
        to_job_id: leg.to_job_id,
        leg_date: dayKey,
        miles,
        minutes: measurement.minutes,
        rate_per_mile: ratePerMile,
        amount_cents: amountCents,
        measurement_source: measurement.source,
        measurement_is_estimated: measurement.is_estimated,
      },
    });
  }
  return outcomes;
}

/** Default UTC calendar-day formatter — fine for tests. Production
 *  callers should pass a TZ-aware formatter; see the route. */
export const utcCalendarDay: DateToCalendarDay = (d) =>
  d.toISOString().slice(0, 10);
