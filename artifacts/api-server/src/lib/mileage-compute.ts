/**
 * Cutover 2A — Mileage automation core.
 *
 * Pure async function: given a set of on-my-way legs, a way to resolve
 * job → client coordinates, a driving-distance provider, and the
 * tenant's per-mile rate, returns the mileage-adjustment specs ready
 * to be inserted by the route layer. Pure on purpose — the route
 * wires the DB I/O and the partial unique index handles dedup, so the
 * unit tests can swap in a fake provider and prove the math + filter.
 *
 * What it pays: client-to-client legs. A leg is reimbursable when the
 * on_my_way row has BOTH `from_job_id` (we know where the tech is
 * leaving) AND `sent_at` (the tech actually launched the trip; an
 * un-sent row is a draft, not a leg). Home-to-first-job is NOT
 * reimbursable per the Phes handbook and the data shape backs that —
 * the field app does not write `from_job_id` for the first job of the
 * day.
 *
 * What it captures: BOTH the driving distance (paid) AND the driving
 * minutes (office visibility). The handbook today pays distance only
 * (`mileage_rate` $/mi). Capturing minutes future-proofs the schema
 * for a policy change to "we now also pay drive time" without a
 * migration; the column lives on pay_adjustments and the route's
 * recompute trivially folds it into pay when a rate column lands.
 *
 * Idempotency: each leg's `on_my_way_events.id` becomes the
 * `source_on_my_way_event_id` on its adjustment row. The partial
 * unique index `pay_adjustments_mileage_source_uq` makes a second
 * insert of the same leg a no-op (`ON CONFLICT DO NOTHING`).
 *
 * Eligibility outcomes the route logs as flags on each adjustment:
 *   - eligible          → INSERT (provider returned a measurement)
 *   - skip_no_from_job  → leg has no from_job_id (first job of day)
 *   - skip_no_sent_at   → tech never actually sent the OMW message
 *   - skip_no_from_coords / skip_no_to_coords  → cannot measure
 *   - skip_provider_null → provider failed AND haversine fallback
 *                          also returned nothing
 *
 * Money math: miles is stored as numeric(7,2); rate is numeric(6,4);
 * the route converts to cents via dollarsToCents(miles * rate) which
 * round-trips through string. No floats persist.
 */
import type { DistanceProvider, LegMeasurement } from "./distance-provider.js";

/** Minimal shape from `on_my_way_events` that mileage cares about.
 *  The route projects this from the DB row; tests construct it
 *  directly. */
export type MileageLegInput = {
  /** PK from on_my_way_events. Becomes source_on_my_way_event_id. */
  id: number;
  user_id: number;
  /** Job the tech is LEAVING. Null for first-job-of-day → skip. */
  from_job_id: number | null;
  /** Job the OMW is heading TO. Always present (NOT NULL in schema). */
  to_job_id: number;
  /** The tech actually sent the OMW; null = draft → skip. */
  sent_at: Date | null;
};

/** Coordinate lookup result for a job's client. The route resolves
 *  these from a join on jobs.client_id → clients.lat/lng. */
export type JobCoords = {
  lat: number;
  lng: number;
};

/** Outcome of evaluating a single leg. */
export type LegOutcome =
  | { kind: "eligible"; spec: MileageAdjustmentSpec }
  | {
      kind:
        | "skip_no_from_job"
        | "skip_no_sent_at"
        | "skip_no_from_coords"
        | "skip_no_to_coords"
        | "skip_provider_null";
      leg_id: number;
      user_id: number;
    };

/** One row to be INSERTed into pay_adjustments. The route fills in
 *  company_id, pay_period_id, created_by_user_id, amount (from miles
 *  × rate), and adjustment_type='mileage' on its side. */
export type MileageAdjustmentSpec = {
  source_on_my_way_event_id: number;
  user_id: number;
  from_job_id: number;
  to_job_id: number;
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

/** miles × rate → integer cents. Both operands are scaled to integers
 *  before multiplying so JS float drift (e.g. 3 × 0.725 yielding
 *  2.17499999… in raw float math) cannot push a half-up case to the
 *  wrong cent. Safe domain: miles up to 1_000_000, rate up to 1.0 →
 *  product well under 2^53. */
export function computeAmountCents(miles: number, ratePerMile: number): number {
  const milesHundredths = Math.round(miles * 100);
  const rateTenThousandths = Math.round(ratePerMile * 10000);
  return Math.round((milesHundredths * rateTenThousandths) / 10000);
}

const METERS_PER_MILE = 1609.344;

/**
 * Compute mileage adjustment specs for a batch of legs.
 *
 * @param legs                Legs to evaluate (already filtered to the
 *                            target period + tenant by the caller).
 * @param coordsByJobId       Pre-loaded job → client coords. The route
 *                            pre-joins this; tests pass a Map.
 * @param ratePerMile         Tenant's per-mile rate. Pulled from
 *                            companies.mileage_rate by the route.
 * @param provider            DistanceProvider implementation. Tests
 *                            inject a deterministic fake; production
 *                            uses defaultDistanceProvider.
 *
 * @returns Per-leg outcomes in input order. The route inserts every
 *          eligible spec with ON CONFLICT DO NOTHING on the partial
 *          unique index and logs skip outcomes for the office to see.
 */
export async function computeMileageForLegs(
  legs: ReadonlyArray<MileageLegInput>,
  coordsByJobId: ReadonlyMap<number, JobCoords>,
  ratePerMile: number,
  provider: DistanceProvider,
): Promise<LegOutcome[]> {
  const outcomes: LegOutcome[] = [];
  for (const leg of legs) {
    if (leg.from_job_id == null) {
      outcomes.push({
        kind: "skip_no_from_job",
        leg_id: leg.id,
        user_id: leg.user_id,
      });
      continue;
    }
    if (leg.sent_at == null) {
      outcomes.push({
        kind: "skip_no_sent_at",
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

/** Exported so the route + tests pull the same constant. */
export const MILEAGE_ADJUSTMENT_TYPE = "mileage";
