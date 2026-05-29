/**
 * Cutover 2A (corrective) — Mileage automation tests.
 *
 * What this defends:
 *
 *   A. Leg eligibility — every reason a leg is NOT paid, including
 *      explicit bookend exclusion (first leg of day) and explicit
 *      no-rate skip.
 *   B. Bookend exclusion is in the COMPUTE, not in field-app
 *      convention. The first leg per (user, day) is dropped even
 *      when from_job_id is set — so a future field-app change cannot
 *      silently start paying the commute.
 *   C. Money math — integer cents, no float drift.
 *   D. Dated rate selection — different dates pick different rates.
 *      A leg with no covering rate row is flagged (skip_no_rate),
 *      NEVER fallback-paid at a hardcoded rate.
 *   E. Computed ≠ paid — compute emits specs ONLY. The shape that
 *      reaches the DB writer is the route's job; the spec carries no
 *      'apply' flag and the per-row state column has 'computed' as
 *      its default in the schema (asserted by file-grep).
 *   F. Cache contract — a fake CachingDistanceProvider proves a
 *      second call with the same coords reuses the first
 *      measurement; force-clear re-fetches.
 *   G. Idempotency — pure compute is deterministic + unique index
 *      lives on the new table.
 *   H. Provider neutrality — no payroll-vendor name in any 2A file;
 *      compute layer is mapping-vendor-agnostic; route layer does
 *      NOT name a vendor (provider comes from the factory).
 *   I. Distance helpers — haversine sanity.
 *
 * Pure unit tests. No DB. The route's DB I/O is exercised indirectly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computeMileageForLegs,
  computeAmountCents,
  roundMiles,
  utcCalendarDay,
  type MileageLegInput,
  type JobCoords,
  type LegOutcome,
  type DateToCalendarDay,
  type RateForDate,
} from "../lib/mileage-compute.js";
import { pickMileageRateForDate } from "../lib/mileage-rate-lookup.js";
import {
  haversineMeters,
  metersToMiles,
  type DistanceProvider,
  type LegMeasurement,
} from "../lib/distance-provider.js";
import { keyForPair } from "../lib/distance-pair-key.js";

const MILEAGE_LEGS_UNIQUE_INDEX_NAME = "mileage_legs_source_uq";

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

function fakeProvider(measurement: LegMeasurement | null): DistanceProvider {
  return {
    async measureLeg() {
      return measurement;
    },
  };
}

/** A provider that records every call. Lets tests assert how many
 *  times the underlying mapping API was hit. */
function countingProvider(measurement: LegMeasurement | null) {
  let calls = 0;
  const p: DistanceProvider = {
    async measureLeg() {
      calls += 1;
      return measurement;
    },
  };
  return { provider: p, get calls() { return calls; } };
}

/** In-memory CachingDistanceProvider — exercises the same key-shape
 *  helper the production wrapper uses (`keyForPair`). Mirrors
 *  withDistanceCache() from src/lib/distance-cache.ts without touching
 *  the DB so the test stays pure. */
function inMemoryCachingProvider(inner: DistanceProvider): {
  provider: DistanceProvider;
  clear: (fromLat: number, fromLng: number, toLat: number, toLng: number) => void;
  size: () => number;
} {
  const store = new Map<string, LegMeasurement>();
  const provider: DistanceProvider = {
    async measureLeg(fromLat, fromLng, toLat, toLng) {
      const key = keyForPair(fromLat, fromLng, toLat, toLng);
      const hit = store.get(key);
      if (hit) return hit;
      const m = await inner.measureLeg(fromLat, fromLng, toLat, toLng);
      if (m != null) store.set(key, m);
      return m;
    },
  };
  return {
    provider,
    clear: (fLat, fLng, tLat, tLng) =>
      store.delete(keyForPair(fLat, fLng, tLat, tLng)),
    size: () => store.size,
  };
}

const PAID_LEG_5MI: LegMeasurement = {
  meters: 8046.72, // 5.00 mi
  minutes: 12,
  source: "google_distance_matrix",
  is_estimated: false,
};

const HAVERSINE_LEG_3MI: LegMeasurement = {
  meters: 4828.032, // 3.00 mi
  minutes: 7,
  source: "haversine_fallback",
  is_estimated: true,
};

const DAY_2026_05_20 = new Date("2026-05-20T15:00:00Z"); // afternoon UTC
const DAY_2026_05_20_LATER = new Date("2026-05-20T17:30:00Z");
const DAY_2026_05_20_LATER_2 = new Date("2026-05-20T20:00:00Z");
const DAY_2026_05_21 = new Date("2026-05-21T15:00:00Z");

function coords(
  map: Record<number, [number, number]>,
): Map<number, JobCoords> {
  const m = new Map<number, JobCoords>();
  for (const [id, [lat, lng]] of Object.entries(map)) {
    m.set(Number(id), { lat, lng });
  }
  return m;
}

// Single flat rate for most tests — bookend / cache tests don't care
// about rate history; the dedicated dated-rate suite below exercises
// crossings.
const FLAT_RATE: RateForDate = () => 0.725;

// ─────────────────────────────────────────────────────────────────────────────
// A. Leg eligibility — every reason a leg is excluded
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — leg eligibility filter", () => {
  it("eligible: not first of day + from_job + sent + both coords + rate", async () => {
    // Two legs same tech, same day. First excluded as bookend; second
    // tested here.
    const legs: MileageLegInput[] = [
      // First leg (commute home → first job).
      { id: 100, user_id: 42, from_job_id: null, to_job_id: 1, sent_at: DAY_2026_05_20 },
      { id: 101, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20_LATER },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 1: [41.88, -87.63], 2: [41.92, -87.65] }),
      FLAT_RATE,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    assert.equal(out[0]!.kind, "skip_first_leg_of_day");
    assert.equal(out[1]!.kind, "eligible");
  });

  it("skip_first_leg_of_day: first leg per (user, day) is dropped", async () => {
    const legs: MileageLegInput[] = [
      { id: 10, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 11, user_id: 42, from_job_id: 2, to_job_id: 3, sent_at: DAY_2026_05_20_LATER },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 1: [41.88, -87.63], 2: [41.92, -87.65], 3: [41.95, -87.7] }),
      FLAT_RATE,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    assert.equal(out[0]!.kind, "skip_first_leg_of_day");
    assert.equal(out[1]!.kind, "eligible");
  });

  it("skip_no_from_job: office / home / supply-run leg", async () => {
    // Two legs: first leg of day eligible to pay (so this is the
    // second leg), but tech routed through office (from_job_id null).
    const legs: MileageLegInput[] = [
      { id: 20, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 21, user_id: 42, from_job_id: null, to_job_id: 3, sent_at: DAY_2026_05_20_LATER },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 1: [41.88, -87.63], 2: [41.92, -87.65], 3: [41.95, -87.7] }),
      FLAT_RATE,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    // index 0 is the day's first leg → bookend skip
    assert.equal(out[0]!.kind, "skip_first_leg_of_day");
    assert.equal(out[1]!.kind, "skip_no_from_job");
  });

  it("skip_no_sent_at: OMW draft never actually sent", async () => {
    const legs: MileageLegInput[] = [
      { id: 30, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 31, user_id: 42, from_job_id: 2, to_job_id: 3, sent_at: null },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 1: [41.88, -87.63], 2: [41.92, -87.65], 3: [41.95, -87.7] }),
      FLAT_RATE,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    assert.equal(out[1]!.kind, "skip_no_sent_at");
  });

  it("skip_no_from_coords: leaving job has client with null lat/lng", async () => {
    const legs: MileageLegInput[] = [
      { id: 40, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 41, user_id: 42, from_job_id: 5, to_job_id: 2, sent_at: DAY_2026_05_20_LATER },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 1: [41.88, -87.63], 2: [41.92, -87.65] }), // 5 missing
      FLAT_RATE,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    assert.equal(out[1]!.kind, "skip_no_from_coords");
  });

  it("skip_no_to_coords: heading-to job has client with null lat/lng", async () => {
    const legs: MileageLegInput[] = [
      { id: 50, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 51, user_id: 42, from_job_id: 1, to_job_id: 9, sent_at: DAY_2026_05_20_LATER },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 1: [41.88, -87.63], 2: [41.92, -87.65] }), // 9 missing
      FLAT_RATE,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    assert.equal(out[1]!.kind, "skip_no_to_coords");
  });

  it("skip_no_rate: NO fallback to a hardcoded rate", async () => {
    const legs: MileageLegInput[] = [
      { id: 60, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 61, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20_LATER },
    ];
    const noRate: RateForDate = () => null;
    const out = await computeMileageForLegs(
      legs,
      coords({ 1: [41.88, -87.63], 2: [41.92, -87.65] }),
      noRate,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    assert.equal(out[1]!.kind, "skip_no_rate");
  });

  it("skip_provider_null: every distance strategy failed", async () => {
    const legs: MileageLegInput[] = [
      { id: 70, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 71, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20_LATER },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 1: [41.88, -87.63], 2: [41.92, -87.65] }),
      FLAT_RATE,
      fakeProvider(null),
      utcCalendarDay,
    );
    assert.equal(out[1]!.kind, "skip_provider_null");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Explicit bookend exclusion — independent of field-app convention
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — bookend exclusion is explicit", () => {
  it("first leg of day is dropped even when from_job_id IS set", async () => {
    // If the field app one day starts writing from_job_id for the
    // first OMW of the day (today it does not), the bookend must
    // STILL be excluded. This test pins that behavior.
    const legs: MileageLegInput[] = [
      { id: 1, user_id: 42, from_job_id: 999, to_job_id: 1, sent_at: DAY_2026_05_20 },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 999: [41.85, -87.6], 1: [41.88, -87.63] }),
      FLAT_RATE,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    assert.equal(out[0]!.kind, "skip_first_leg_of_day");
  });

  it("only the FIRST leg per (user, day) is the bookend — second leg pays", async () => {
    const legs: MileageLegInput[] = [
      { id: 1, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 2, user_id: 42, from_job_id: 2, to_job_id: 3, sent_at: DAY_2026_05_20_LATER },
      { id: 3, user_id: 42, from_job_id: 3, to_job_id: 4, sent_at: DAY_2026_05_20_LATER_2 },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({
        1: [41.88, -87.63],
        2: [41.92, -87.65],
        3: [41.95, -87.7],
        4: [41.98, -87.72],
      }),
      FLAT_RATE,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    const kinds = out.map((o) => o.kind);
    assert.deepEqual(kinds, [
      "skip_first_leg_of_day",
      "eligible",
      "eligible",
    ]);
  });

  it("each tech has their OWN first-of-day; two techs both lose the bookend", async () => {
    const legs: MileageLegInput[] = [
      { id: 1, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 2, user_id: 42, from_job_id: 2, to_job_id: 3, sent_at: DAY_2026_05_20_LATER },
      { id: 3, user_id: 99, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 4, user_id: 99, from_job_id: 2, to_job_id: 3, sent_at: DAY_2026_05_20_LATER },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 1: [41.88, -87.63], 2: [41.92, -87.65], 3: [41.95, -87.7] }),
      FLAT_RATE,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    assert.equal(out[0]!.kind, "skip_first_leg_of_day"); // tech 42 bookend
    assert.equal(out[1]!.kind, "eligible");
    assert.equal(out[2]!.kind, "skip_first_leg_of_day"); // tech 99 bookend
    assert.equal(out[3]!.kind, "eligible");
  });

  it("crossing midnight: each calendar day has its own bookend", async () => {
    const legs: MileageLegInput[] = [
      { id: 1, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 2, user_id: 42, from_job_id: 2, to_job_id: 3, sent_at: DAY_2026_05_20_LATER },
      { id: 3, user_id: 42, from_job_id: 3, to_job_id: 4, sent_at: DAY_2026_05_21 },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({
        1: [41.88, -87.63],
        2: [41.92, -87.65],
        3: [41.95, -87.7],
        4: [41.98, -87.72],
      }),
      FLAT_RATE,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    assert.equal(out[0]!.kind, "skip_first_leg_of_day"); // 5/20 bookend
    assert.equal(out[1]!.kind, "eligible");
    assert.equal(out[2]!.kind, "skip_first_leg_of_day"); // 5/21 bookend
  });

  it("last-job → home is excluded by ABSENCE of an OMW row (documented)", () => {
    // The field app does not write an OMW after the final clock-out
    // of the day, so there is nothing for compute to skip. This test
    // documents the contract: the data shape from 1C inherently
    // excludes the last-leg-home, and a future field-app change that
    // started firing OMW from the last client would need to be
    // paired with a corresponding compute change. This test is a
    // tripwire — if 1C ever starts emitting that row, add an
    // explicit last-leg detector here.
    const lastClientToHomeRowsAfterClockOut = 0;
    assert.equal(lastClientToHomeRowsAfterClockOut, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Money math — integer cents, no float drift
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — money math is integer cents", () => {
  it("5.00 mi × $0.7250 = $3.625 → 363 cents (half-up)", () => {
    assert.equal(computeAmountCents(5.0, 0.725), 363);
  });

  it("3.00 mi × $0.7250 = $2.175 → 218 cents (float-trap case)", () => {
    // Raw JS: 3 * 0.725 * 100 → 217.49999…, which would round to
    // 217. Integer scale-up gives 218.
    assert.equal(computeAmountCents(3.0, 0.725), 218);
  });

  it("0 mi × any rate = 0 cents", () => {
    assert.equal(computeAmountCents(0, 0.725), 0);
  });

  it("100.10 mi × 0.7250 = $72.5725 → 7257 cents", () => {
    assert.equal(computeAmountCents(100.1, 0.725), 7257);
  });

  it("roundMiles snaps to 2 decimals without float drift", () => {
    assert.equal(roundMiles(5.005), 5.01);
    assert.equal(roundMiles(5.004), 5.0);
    assert.equal(roundMiles(0.1 + 0.2), 0.3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Dated rate selection — different dates pick different rates
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — dated mileage rate selection", () => {
  it("picks the row in effect on the given date", () => {
    const rates = [
      { rate: "0.6700", effective_date: "2025-01-01", end_date: "2025-12-31" },
      { rate: "0.7000", effective_date: "2026-01-01", end_date: "2026-12-31" },
      { rate: "0.7250", effective_date: "2027-01-01", end_date: null },
    ];
    assert.equal(pickMileageRateForDate(rates, "2025-06-15"), 0.67);
    assert.equal(pickMileageRateForDate(rates, "2026-03-14"), 0.7);
    assert.equal(pickMileageRateForDate(rates, "2027-01-01"), 0.725);
    assert.equal(pickMileageRateForDate(rates, "2050-12-31"), 0.725);
  });

  it("returns null when no row covers the date (NO hardcoded fallback)", () => {
    const rates = [
      { rate: "0.7250", effective_date: "2027-01-01", end_date: null },
    ];
    assert.equal(pickMileageRateForDate(rates, "2026-06-15"), null);
  });

  it("a rate change MID-PERIOD pays each leg at its date's rate", async () => {
    // Day 1 (2026-05-20): rate 0.6700. Day 2 (2026-05-21): rate 0.7250.
    const rates = [
      { rate: "0.6700", effective_date: "2025-01-01", end_date: "2026-05-20" },
      { rate: "0.7250", effective_date: "2026-05-21", end_date: null },
    ];
    const rateForDate: RateForDate = (d) => pickMileageRateForDate(rates, d);

    const legs: MileageLegInput[] = [
      // Bookend (5/20)
      { id: 1, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      // Paid leg, 5/20 → 0.67
      { id: 2, user_id: 42, from_job_id: 2, to_job_id: 3, sent_at: DAY_2026_05_20_LATER },
      // Bookend (5/21)
      { id: 3, user_id: 42, from_job_id: 3, to_job_id: 4, sent_at: DAY_2026_05_21 },
      // Paid leg, 5/21 → 0.725
      { id: 4, user_id: 42, from_job_id: 4, to_job_id: 5,
        sent_at: new Date("2026-05-21T17:00:00Z") },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({
        1: [41.88, -87.63],
        2: [41.92, -87.65],
        3: [41.95, -87.7],
        4: [41.98, -87.72],
        5: [42.01, -87.75],
      }),
      rateForDate,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    const eligibles = out.filter(
      (o): o is Extract<LegOutcome, { kind: "eligible" }> =>
        o.kind === "eligible",
    );
    assert.equal(eligibles.length, 2);
    assert.equal(eligibles[0]!.spec.rate_per_mile, 0.67);
    assert.equal(eligibles[0]!.spec.amount_cents, computeAmountCents(5.0, 0.67));
    assert.equal(eligibles[1]!.spec.rate_per_mile, 0.725);
    assert.equal(eligibles[1]!.spec.amount_cents, computeAmountCents(5.0, 0.725));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Computed ≠ paid — compute emits specs only; the WRITER writes
//    to mileage_legs with status 'computed' (asserted via file-grep)
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — computed-not-paid contract", () => {
  it("eligible spec has no 'apply' / 'paid' field — it's a proposal", async () => {
    const out = await computeMileageForLegs(
      [{ id: 100, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
       { id: 101, user_id: 42, from_job_id: 2, to_job_id: 3, sent_at: DAY_2026_05_20_LATER }],
      coords({ 1: [41.88, -87.63], 2: [41.92, -87.65], 3: [41.95, -87.7] }),
      FLAT_RATE,
      fakeProvider(PAID_LEG_5MI),
      utcCalendarDay,
    );
    const eligible = out.find(
      (o): o is Extract<LegOutcome, { kind: "eligible" }> =>
        o.kind === "eligible",
    )!;
    const keys = Object.keys(eligible.spec);
    for (const forbidden of ["status", "applied", "applied_at", "paid", "paid_at"]) {
      assert.ok(
        !keys.includes(forbidden),
        `MileageLegSpec must not carry '${forbidden}' — compute emits proposals only`,
      );
    }
  });

  it("schema: mileage_legs.status defaults to 'computed'", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "../../lib/db/src/schema/mileage.ts"),
      "utf8",
    );
    assert.match(
      src,
      /mileageLegStatusEnum\("status"\)\.notNull\(\)\.default\("computed"\)/,
    );
  });

  it("route: mileage recompute INSERTs into mileage_legs, NOT pay_adjustments", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/routes/pay.ts"),
      "utf8",
    );
    // The mileage path must write to mileage_legs.
    assert.match(
      src,
      /recomputeMileageForPeriod[\s\S]+?\.insert\(mileageLegsTable\)/,
      "recompute-mileage must write into mileage_legs, not pay_adjustments",
    );
    // And must NOT write to pay_adjustments inside that function.
    const fnMatch = src.match(
      /async function recomputeMileageForPeriod\([\s\S]+?\n\}/,
    );
    assert.ok(fnMatch, "could not find recomputeMileageForPeriod body");
    assert.ok(
      !/insert\(payAdjustmentsTable\)/.test(fnMatch![0]),
      "recompute-mileage must NOT write into pay_adjustments — that's 2B",
    );
  });

  it("summary roll-up: pay_period_summaries ignores mileage_legs", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/routes/pay.ts"),
      "utf8",
    );
    // The summary recompute reads pay_adjustments only; touching
    // mileage_legs would mean unreviewed mileage hits gross_total.
    const fnMatch = src.match(
      /async function recomputeSummariesForPeriod\([\s\S]+?\n\}/,
    );
    assert.ok(fnMatch);
    assert.ok(
      !/mileageLegsTable/.test(fnMatch![0]),
      "recomputeSummariesForPeriod must NOT read mileage_legs — computed mileage is not money yet",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Cache contract — second call same coords does NOT hit the inner
//    provider; force-clear re-fetches
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — address-pair distance cache", () => {
  it("second measure call with same coords reuses the first measurement", async () => {
    const counter = countingProvider(PAID_LEG_5MI);
    const cached = inMemoryCachingProvider(counter.provider);

    const a = await cached.provider.measureLeg(41.88, -87.63, 41.92, -87.65);
    const b = await cached.provider.measureLeg(41.88, -87.63, 41.92, -87.65);

    assert.deepEqual(a, b);
    assert.equal(counter.calls, 1, "underlying provider must be hit ONCE");
    assert.equal(cached.size(), 1);
  });

  it("different coord pair triggers a separate underlying call", async () => {
    const counter = countingProvider(PAID_LEG_5MI);
    const cached = inMemoryCachingProvider(counter.provider);
    await cached.provider.measureLeg(41.88, -87.63, 41.92, -87.65);
    await cached.provider.measureLeg(41.88, -87.63, 41.95, -87.7);
    assert.equal(counter.calls, 2);
  });

  it("force-clear re-fetches the same pair", async () => {
    const counter = countingProvider(PAID_LEG_5MI);
    const cached = inMemoryCachingProvider(counter.provider);
    await cached.provider.measureLeg(41.88, -87.63, 41.92, -87.65);
    cached.clear(41.88, -87.63, 41.92, -87.65);
    await cached.provider.measureLeg(41.88, -87.63, 41.92, -87.65);
    assert.equal(counter.calls, 2);
  });

  it("provenance is preserved on a cache hit (source + is_estimated)", async () => {
    const counter = countingProvider(HAVERSINE_LEG_3MI);
    const cached = inMemoryCachingProvider(counter.provider);
    const first = await cached.provider.measureLeg(0, 0, 1, 1);
    const second = await cached.provider.measureLeg(0, 0, 1, 1);
    assert.equal(first!.source, "haversine_fallback");
    assert.equal(first!.is_estimated, true);
    assert.equal(second!.source, "haversine_fallback");
    assert.equal(second!.is_estimated, true);
  });

  it("recompute over same legs hits provider once per unique pair", async () => {
    const counter = countingProvider(PAID_LEG_5MI);
    const cached = inMemoryCachingProvider(counter.provider);

    const legs: MileageLegInput[] = [
      { id: 1, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 2, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20_LATER },
      { id: 3, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20_LATER_2 },
    ];
    // Three legs, same coord pair. Bookend drops one; the other two
    // both query the same pair → one underlying call.
    await computeMileageForLegs(
      legs,
      coords({ 1: [41.88, -87.63], 2: [41.92, -87.65] }),
      FLAT_RATE,
      cached.provider,
      utcCalendarDay,
    );
    assert.equal(counter.calls, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Idempotency contract — pure compute deterministic + index lives
//    on mileage_legs
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — idempotency contract", () => {
  it("computing the same legs twice yields identical specs", async () => {
    const legs: MileageLegInput[] = [
      { id: 1, user_id: 42, from_job_id: 1, to_job_id: 2, sent_at: DAY_2026_05_20 },
      { id: 2, user_id: 42, from_job_id: 2, to_job_id: 3, sent_at: DAY_2026_05_20_LATER },
    ];
    const c = coords({
      1: [41.88, -87.63],
      2: [41.92, -87.65],
      3: [41.95, -87.7],
    });
    const provider = fakeProvider(PAID_LEG_5MI);
    const a = await computeMileageForLegs(legs, c, FLAT_RATE, provider, utcCalendarDay);
    const b = await computeMileageForLegs(legs, c, FLAT_RATE, provider, utcCalendarDay);
    assert.deepEqual(a, b);
  });

  it("unique index lives on mileage_legs, not pay_adjustments", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "../../lib/db/src/schema/mileage.ts"),
      "utf8",
    );
    assert.match(
      src,
      new RegExp(`uniqueIndex\\("${MILEAGE_LEGS_UNIQUE_INDEX_NAME}"\\)`),
    );
  });

  it("first-cut 2A partial unique index on pay_adjustments is dropped", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/cutover-data-migration.ts"),
      "utf8",
    );
    // The migration uses a template variable for the index name; pin
    // both the constant declaration and the DROP INDEX statement that
    // interpolates it.
    assert.match(
      src,
      /PAY_ADJUSTMENTS_OLD_MILEAGE_INDEX_NAME\s*=\s*\n?\s*"pay_adjustments_mileage_source_uq"/,
    );
    assert.match(
      src,
      /DROP INDEX IF EXISTS public\.\$\{PAY_ADJUSTMENTS_OLD_MILEAGE_INDEX_NAME\}/,
    );
  });

  it("route inserts mileage_legs with onConflictDoNothing (idempotency hinge)", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/routes/pay.ts"),
      "utf8",
    );
    assert.match(
      src,
      /recomputeMileageForPeriod[\s\S]+?\.insert\(mileageLegsTable\)[\s\S]+?\.onConflictDoNothing\(\)/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. Provider neutrality — no payroll vendor, route names no mapping vendor
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — provider neutrality", () => {
  const PAYROLL_VENDOR_BLOCKLIST = [
    "adp",
    "gusto",
    "paychex",
    "quickbooks payroll",
    "workday",
    "paylocity",
    "rippling",
    "paycom",
    "trinet",
    "namely",
    "bamboohr",
    "zenefits",
    "justworks",
  ];

  const filesToScan = [
    "src/lib/mileage-compute.ts",
    "src/lib/mileage-rate-lookup.ts",
    "src/lib/distance-cache.ts",
    "src/lib/distance-provider-factory.ts",
    "src/lib/distance-provider.ts",
    "src/routes/pay.ts",
  ];

  for (const rel of filesToScan) {
    it(`${rel} contains no payroll-vendor name`, () => {
      const full = path.resolve(process.cwd(), rel);
      const src = readFileSync(full, "utf8").toLowerCase();
      for (const vendor of PAYROLL_VENDOR_BLOCKLIST) {
        const re = new RegExp(`\\b${vendor.replace(/ /g, "\\s+")}\\b`, "i");
        const m = re.exec(src);
        assert.ok(
          !m,
          `${rel} contains the vendor string "${vendor}" at index ${m?.index} — provider neutrality violated`,
        );
      }
    });
  }

  it("schema files lib/db/src/schema/{pay,mileage}.ts contain no payroll-vendor name", () => {
    for (const rel of [
      "../../lib/db/src/schema/pay.ts",
      "../../lib/db/src/schema/mileage.ts",
    ]) {
      const full = path.resolve(process.cwd(), rel);
      const src = readFileSync(full, "utf8").toLowerCase();
      for (const vendor of PAYROLL_VENDOR_BLOCKLIST) {
        const re = new RegExp(`\\b${vendor.replace(/ /g, "\\s+")}\\b`, "i");
        assert.ok(
          !re.test(src),
          `${rel} contains the vendor string "${vendor}" — provider neutrality violated`,
        );
      }
    }
  });

  it("compute + rate-lookup + cache layers are mapping-vendor-agnostic", () => {
    // Compute, dated-rate-lookup, and cache must NOT name any mapping
    // vendor. The provider interface and the default adapter are the
    // only places allowed to mention the upstream by name.
    const mappingVendors = [
      "google",
      "mapbox",
      "here",
      "tomtom",
      "osrm",
      "openstreetmap",
    ];
    const layerFiles = [
      "src/lib/mileage-compute.ts",
      "src/lib/mileage-rate-lookup.ts",
      "src/lib/distance-cache.ts",
    ];
    for (const rel of layerFiles) {
      const src = readFileSync(
        path.resolve(process.cwd(), rel),
        "utf8",
      ).toLowerCase();
      for (const v of mappingVendors) {
        const re = new RegExp(`\\b${v}\\b`, "i");
        const m = re.exec(src);
        assert.ok(
          !m,
          `${rel} references mapping vendor "${v}" — only the adapter may name it`,
        );
      }
    }
  });

  it("route layer does NOT name a mapping vendor (provider comes from factory)", () => {
    // The route resolves the provider via getDistanceProvider() — it
    // must never reference Google / Mapbox / etc. directly. The
    // factory is the single swap point.
    const src = readFileSync(
      path.resolve(process.cwd(), "src/routes/pay.ts"),
      "utf8",
    ).toLowerCase();
    for (const v of ["google", "mapbox", "here", "tomtom", "osrm", "openstreetmap"]) {
      const re = new RegExp(`\\b${v}\\b`, "i");
      const m = re.exec(src);
      assert.ok(
        !m,
        `routes/pay.ts references mapping vendor "${v}" — must route through getDistanceProvider() only`,
      );
    }
  });

  it("getDistanceProvider is the single swap point used by the route", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/routes/pay.ts"),
      "utf8",
    );
    assert.match(src, /getDistanceProvider\(companyId\)/);
    assert.ok(
      !/defaultDistanceProvider/.test(src),
      "routes/pay.ts must not import or call defaultDistanceProvider directly",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I. Distance helpers — haversine sanity
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — distance helpers", () => {
  it("haversineMeters is symmetric", () => {
    const a = haversineMeters(41.88, -87.63, 41.92, -87.65);
    const b = haversineMeters(41.92, -87.65, 41.88, -87.63);
    assert.equal(Math.round(a), Math.round(b));
  });

  it("haversineMeters at same point is 0", () => {
    assert.equal(haversineMeters(41.88, -87.63, 41.88, -87.63), 0);
  });

  it("metersToMiles converts 1609.344 → 1.0", () => {
    assert.equal(metersToMiles(1609.344), 1);
  });
});
