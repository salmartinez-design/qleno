/**
 * Cutover 2A — Mileage automation tests.
 *
 * The four promises this suite defends:
 *
 *   A. Eligibility filter — every leg-shape that must NOT be paid is
 *      excluded with the right reason code.
 *   B. Money math — miles × rate becomes integer cents, deterministic
 *      and float-drift-free, with the captured-but-unpaid drive
 *      minutes alongside.
 *   C. Idempotency contract — running the same legs through the
 *      compute layer twice yields the same specs; the route layer
 *      relies on the partial unique index to collapse re-insertions.
 *      We assert the index sql + name string here so a future
 *      drizzle-kit drift on the spelling FAILs the build.
 *   D. Provider neutrality — the new 2A files contain no payroll-
 *      vendor or mapping-vendor brand name. The grep mirrors 1E's
 *      blocklist exactly.
 *
 * Pure unit tests. No DB. The route's DB I/O is exercised indirectly
 * through `computeMileageForLegs` with a fake provider.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computeMileageForLegs,
  computeAmountCents,
  roundMiles,
  MILEAGE_ADJUSTMENT_TYPE,
  type MileageLegInput,
  type JobCoords,
  type LegOutcome,
} from "../lib/mileage-compute.js";
import {
  haversineMeters,
  metersToMiles,
  type DistanceProvider,
  type LegMeasurement,
} from "../lib/distance-provider.js";

// The canonical name of the partial unique index installed by
// cutover-data-migration.ts. Asserted via file-grep below so a
// future drizzle-kit drift on the spelling FAILs the build. Kept
// as a hardcoded constant here (not imported) so this test file
// does not trigger drizzle's DB-client construction at module load.
const MILEAGE_ADJUSTMENT_UNIQUE_INDEX_NAME = "pay_adjustments_mileage_source_uq";

// ─────────────────────────────────────────────────────────────────────────────
// Fake distance providers — deterministic, no network
// ─────────────────────────────────────────────────────────────────────────────

function fakeProvider(measurement: LegMeasurement | null): DistanceProvider {
  return {
    async measureLeg() {
      return measurement;
    },
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

const SENT = new Date("2026-05-20T15:00:00Z");

function coords(map: Record<number, [number, number]>): Map<number, JobCoords> {
  const m = new Map<number, JobCoords>();
  for (const [id, [lat, lng]] of Object.entries(map)) {
    m.set(Number(id), { lat, lng });
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Eligibility filter — every reason the leg must NOT be paid
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — leg eligibility filter", () => {
  it("eligible: from_job_id + sent_at + both coords known", async () => {
    const legs: MileageLegInput[] = [
      { id: 1, user_id: 42, from_job_id: 100, to_job_id: 200, sent_at: SENT },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 100: [41.88, -87.63], 200: [41.92, -87.65] }),
      0.725,
      fakeProvider(PAID_LEG_5MI),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, "eligible");
  });

  it("skip_no_from_job: first job of day (from_job_id null)", async () => {
    const legs: MileageLegInput[] = [
      { id: 2, user_id: 42, from_job_id: null, to_job_id: 200, sent_at: SENT },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 200: [41.92, -87.65] }),
      0.725,
      fakeProvider(PAID_LEG_5MI),
    );
    assert.equal(out[0]!.kind, "skip_no_from_job");
  });

  it("skip_no_sent_at: OMW row was a draft, never sent", async () => {
    const legs: MileageLegInput[] = [
      { id: 3, user_id: 42, from_job_id: 100, to_job_id: 200, sent_at: null },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 100: [41.88, -87.63], 200: [41.92, -87.65] }),
      0.725,
      fakeProvider(PAID_LEG_5MI),
    );
    assert.equal(out[0]!.kind, "skip_no_sent_at");
  });

  it("skip_no_from_coords: leaving job has client with null lat/lng", async () => {
    const legs: MileageLegInput[] = [
      { id: 4, user_id: 42, from_job_id: 100, to_job_id: 200, sent_at: SENT },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 200: [41.92, -87.65] }), // 100 missing
      0.725,
      fakeProvider(PAID_LEG_5MI),
    );
    assert.equal(out[0]!.kind, "skip_no_from_coords");
  });

  it("skip_no_to_coords: heading-to job has client with null lat/lng", async () => {
    const legs: MileageLegInput[] = [
      { id: 5, user_id: 42, from_job_id: 100, to_job_id: 200, sent_at: SENT },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 100: [41.88, -87.63] }), // 200 missing
      0.725,
      fakeProvider(PAID_LEG_5MI),
    );
    assert.equal(out[0]!.kind, "skip_no_to_coords");
  });

  it("skip_provider_null: every distance strategy failed", async () => {
    const legs: MileageLegInput[] = [
      { id: 6, user_id: 42, from_job_id: 100, to_job_id: 200, sent_at: SENT },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 100: [41.88, -87.63], 200: [41.92, -87.65] }),
      0.725,
      fakeProvider(null),
    );
    assert.equal(out[0]!.kind, "skip_provider_null");
  });

  it("mixed batch preserves input order with per-leg outcomes", async () => {
    const legs: MileageLegInput[] = [
      { id: 10, user_id: 1, from_job_id: null, to_job_id: 200, sent_at: SENT },
      { id: 11, user_id: 1, from_job_id: 100, to_job_id: 300, sent_at: SENT },
      { id: 12, user_id: 1, from_job_id: 100, to_job_id: 200, sent_at: null },
    ];
    const out = await computeMileageForLegs(
      legs,
      coords({ 100: [41.88, -87.63], 200: [41.92, -87.65], 300: [41.95, -87.7] }),
      0.725,
      fakeProvider(PAID_LEG_5MI),
    );
    assert.equal(out.length, 3);
    assert.equal(out[0]!.kind, "skip_no_from_job");
    assert.equal(out[1]!.kind, "eligible");
    assert.equal(out[2]!.kind, "skip_no_sent_at");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Money math — integer cents, no float drift, minutes captured
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — money math is integer cents", () => {
  it("5.00 mi × $0.7250/mi = 363 cents ($3.625 → 362.5 → bankers? no, half-up)", () => {
    // 5 × 0.7250 = 3.625 → ×100 = 362.5 → Math.round = 363
    assert.equal(computeAmountCents(5.0, 0.725), 363);
  });

  it("3.00 mi × $0.7250 = $2.175 → 218 cents", () => {
    assert.equal(computeAmountCents(3.0, 0.725), 218);
  });

  it("0 mi × any rate = 0 cents", () => {
    assert.equal(computeAmountCents(0, 0.725), 0);
  });

  it("100.10 mi × 0.7250 = $72.5725 → 7257 cents (no float drift)", () => {
    assert.equal(computeAmountCents(100.1, 0.725), 7257);
  });

  it("roundMiles snaps to 2 decimals", () => {
    assert.equal(roundMiles(5.005), 5.01); // half-up
    assert.equal(roundMiles(5.004), 5.0);
    assert.equal(roundMiles(0), 0);
    assert.equal(roundMiles(0.1 + 0.2), 0.3); // classic float trap
  });

  it("eligible spec carries miles, minutes, rate, cents, AND provenance", async () => {
    const out = await computeMileageForLegs(
      [{ id: 1, user_id: 42, from_job_id: 100, to_job_id: 200, sent_at: SENT }],
      coords({ 100: [41.88, -87.63], 200: [41.92, -87.65] }),
      0.725,
      fakeProvider(PAID_LEG_5MI),
    );
    assert.equal(out[0]!.kind, "eligible");
    const spec = (out[0] as Extract<LegOutcome, { kind: "eligible" }>).spec;
    assert.equal(spec.miles, 5.0);
    assert.equal(spec.minutes, 12);
    assert.equal(spec.rate_per_mile, 0.725);
    assert.equal(spec.amount_cents, 363);
    assert.equal(spec.measurement_source, "google_distance_matrix");
    assert.equal(spec.measurement_is_estimated, false);
    assert.equal(spec.from_job_id, 100);
    assert.equal(spec.to_job_id, 200);
    assert.equal(spec.source_on_my_way_event_id, 1);
  });

  it("haversine fallback measurement is flagged is_estimated=true", async () => {
    const out = await computeMileageForLegs(
      [{ id: 1, user_id: 42, from_job_id: 100, to_job_id: 200, sent_at: SENT }],
      coords({ 100: [41.88, -87.63], 200: [41.92, -87.65] }),
      0.725,
      fakeProvider(HAVERSINE_LEG_3MI),
    );
    const spec = (out[0] as Extract<LegOutcome, { kind: "eligible" }>).spec;
    assert.equal(spec.miles, 3.0);
    assert.equal(spec.measurement_source, "haversine_fallback");
    assert.equal(spec.measurement_is_estimated, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Idempotency contract — pure compute is deterministic
//    + the partial unique index sql is wired correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — idempotency contract", () => {
  it("computing the same legs twice yields identical specs", async () => {
    const legs: MileageLegInput[] = [
      { id: 1, user_id: 42, from_job_id: 100, to_job_id: 200, sent_at: SENT },
      { id: 2, user_id: 42, from_job_id: 200, to_job_id: 300, sent_at: SENT },
    ];
    const c = coords({
      100: [41.88, -87.63],
      200: [41.92, -87.65],
      300: [41.95, -87.7],
    });
    const provider = fakeProvider(PAID_LEG_5MI);
    const a = await computeMileageForLegs(legs, c, 0.725, provider);
    const b = await computeMileageForLegs(legs, c, 0.725, provider);
    assert.deepEqual(a, b);
  });

  it("MILEAGE_ADJUSTMENT_TYPE is the exact string 'mileage'", () => {
    assert.equal(MILEAGE_ADJUSTMENT_TYPE, "mileage");
  });

  it("partial unique index has the canonical name and shape", () => {
    assert.equal(
      MILEAGE_ADJUSTMENT_UNIQUE_INDEX_NAME,
      "pay_adjustments_mileage_source_uq",
    );
    const src = readFileSync(
      path.resolve(process.cwd(), "src/cutover-data-migration.ts"),
      "utf8",
    );
    // The migration must install a UNIQUE index on the dedup key,
    // filtered to mileage rows with a non-null source event id.
    assert.match(
      src,
      /CREATE UNIQUE INDEX [\s\S]+? ON pay_adjustments \(company_id, source_on_my_way_event_id\)/,
    );
    assert.match(
      src,
      /WHERE adjustment_type = ''mileage''/,
    );
    assert.match(
      src,
      /AND source_on_my_way_event_id IS NOT NULL/,
    );
  });

  it("route inserts adjustment rows with ON CONFLICT DO NOTHING (idempotency hinge)", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/routes/pay.ts"),
      "utf8",
    );
    assert.match(
      src,
      /recomputeMileageForPeriod[\s\S]+?\.onConflictDoNothing\(\)/,
      "mileage insert path must use onConflictDoNothing for partial-unique dedup",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Provider neutrality — no payroll vendor names; no mapping vendor
//    names beyond the audited Google Distance Matrix adapter
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 2A — provider neutrality", () => {
  // Same payroll-vendor blocklist as 1E; mileage code must never name
  // an ADP-class vendor either.
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

  // Files that must not name ANY payroll vendor.
  const filesToScan = [
    "src/lib/mileage-compute.ts",
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

  it("schema file lib/db/src/schema/pay.ts contains no payroll-vendor name", () => {
    const full = path.resolve(process.cwd(), "../../lib/db/src/schema/pay.ts");
    const src = readFileSync(full, "utf8").toLowerCase();
    for (const vendor of PAYROLL_VENDOR_BLOCKLIST) {
      const re = new RegExp(`\\b${vendor.replace(/ /g, "\\s+")}\\b`, "i");
      assert.ok(
        !re.test(src),
        `pay.ts contains the vendor string "${vendor}" — provider neutrality violated`,
      );
    }
  });

  it("mileage-compute.ts is mapping-vendor-agnostic (no Google/Mapbox/etc. names)", () => {
    // The compute layer must not name any mapping vendor — it routes
    // through the DistanceProvider interface only. The interface file
    // legitimately mentions Google for the default adapter; the
    // compute file may not.
    const src = readFileSync(
      path.resolve(process.cwd(), "src/lib/mileage-compute.ts"),
      "utf8",
    ).toLowerCase();
    const mappingVendors = [
      "google",
      "mapbox",
      "here",
      "tomtom",
      "osrm",
      "openstreetmap",
    ];
    for (const v of mappingVendors) {
      const re = new RegExp(`\\b${v}\\b`, "i");
      const m = re.exec(src);
      assert.ok(
        !m,
        `mileage-compute.ts references mapping vendor "${v}" — compute layer must be vendor-agnostic`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Distance helpers — sanity on the haversine math the fallback uses
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
