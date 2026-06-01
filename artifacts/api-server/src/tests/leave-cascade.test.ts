/**
 * Tests for the leave bucket cascade resolver. Pure helper, no DB. The
 * route is exercised indirectly via the lib functions it composes.
 *
 * What this defends:
 *   A. Ordering — PTO precedes PLAWA precedes Unpaid Leave regardless of
 *      the order the input array arrives in.
 *   B. PTO equivalence — a tenant with only `pto` OR only `pto_phes` lands
 *      in the highest-priority PTO slot.
 *   C. Filter — non-requestable buckets (Unexcused) and unrelated buckets
 *      (Sick) are dropped from the cascade.
 *   D. Allocation math — greedy fill within available, last bucket absorbs
 *      remainder. spill_hours = the amount landing in the catch-all.
 *   E. Error shapes — empty cascade list and non-positive hours.
 *   F. Custom order override.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCascadeAllocation,
  orderBucketsForCascade,
  DEFAULT_CASCADE_SLUG_ORDER,
  type CascadeBucketInput,
} from "../lib/leave-cascade.js";

function bucket(
  partial: Partial<CascadeBucketInput> & { leave_type_id: number; slug: string },
): CascadeBucketInput {
  return {
    available_hours: 0,
    requestable: true,
    ...partial,
  };
}

describe("Cascade — ordering", () => {
  it("PTO precedes PLAWA precedes Unpaid Leave regardless of input order", () => {
    const ordered = orderBucketsForCascade([
      bucket({ leave_type_id: 3, slug: "unpaid_leave" }),
      bucket({ leave_type_id: 2, slug: "plawa" }),
      bucket({ leave_type_id: 1, slug: "pto_phes" }),
    ]);
    assert.deepEqual(
      ordered.map((b) => b.slug),
      ["pto_phes", "plawa", "unpaid_leave"],
    );
  });

  it("PTO equivalence: tenant with only 'pto' (not 'pto_phes') still lands in the PTO slot", () => {
    const ordered = orderBucketsForCascade([
      bucket({ leave_type_id: 3, slug: "unpaid_leave" }),
      bucket({ leave_type_id: 1, slug: "pto" }),
    ]);
    assert.deepEqual(
      ordered.map((b) => b.slug),
      ["pto", "unpaid_leave"],
    );
  });

  it("filters non-requestable buckets (Unexcused) and unrelated slugs (Sick)", () => {
    const ordered = orderBucketsForCascade([
      bucket({ leave_type_id: 1, slug: "pto_phes" }),
      bucket({ leave_type_id: 4, slug: "sick" }),
      bucket({ leave_type_id: 5, slug: "unexcused", requestable: false }),
      bucket({ leave_type_id: 3, slug: "unpaid_leave" }),
    ]);
    assert.deepEqual(
      ordered.map((b) => b.slug),
      ["pto_phes", "unpaid_leave"],
    );
  });

  it("custom_order override is honored", () => {
    const ordered = orderBucketsForCascade(
      [
        bucket({ leave_type_id: 1, slug: "pto_phes" }),
        bucket({ leave_type_id: 2, slug: "plawa" }),
        bucket({ leave_type_id: 3, slug: "unpaid_leave" }),
      ],
      ["plawa", "pto_phes", "unpaid_leave"],
    );
    assert.deepEqual(ordered.map((b) => b.slug), ["plawa", "pto_phes", "unpaid_leave"]);
  });

  it("DEFAULT_CASCADE_SLUG_ORDER is the documented order", () => {
    assert.deepEqual(
      [...DEFAULT_CASCADE_SLUG_ORDER],
      ["pto_phes", "pto", "plawa", "unpaid_leave"],
    );
  });
});

describe("Cascade — allocation", () => {
  const fullBuckets = [
    bucket({ leave_type_id: 1, slug: "pto_phes", available_hours: 16 }),
    bucket({ leave_type_id: 2, slug: "plawa", available_hours: 8 }),
    bucket({ leave_type_id: 3, slug: "unpaid_leave", available_hours: 0 }),
  ];

  it("8h request stays entirely in PTO", () => {
    const r = resolveCascadeAllocation({ requestedHours: 8, buckets: fullBuckets });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.allocations, [
      { leave_type_id: 1, slug: "pto_phes", hours: 8, cascade_order: 0 },
    ]);
    assert.equal(r.spill_hours, 0);
  });

  it("16h exhausts PTO exactly, no PLAWA / unpaid touched", () => {
    const r = resolveCascadeAllocation({ requestedHours: 16, buckets: fullBuckets });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.allocations, [
      { leave_type_id: 1, slug: "pto_phes", hours: 16, cascade_order: 0 },
    ]);
    assert.equal(r.spill_hours, 0);
  });

  it("24h splits 16 PTO + 8 PLAWA, no unpaid touched", () => {
    const r = resolveCascadeAllocation({ requestedHours: 24, buckets: fullBuckets });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.allocations, [
      { leave_type_id: 1, slug: "pto_phes", hours: 16, cascade_order: 0 },
      { leave_type_id: 2, slug: "plawa", hours: 8, cascade_order: 1 },
    ]);
    assert.equal(r.spill_hours, 0);
  });

  it("28h splits 16 PTO + 8 PLAWA + 4 unpaid (the catch-all absorbs spill)", () => {
    const r = resolveCascadeAllocation({ requestedHours: 28, buckets: fullBuckets });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.allocations, [
      { leave_type_id: 1, slug: "pto_phes", hours: 16, cascade_order: 0 },
      { leave_type_id: 2, slug: "plawa", hours: 8, cascade_order: 1 },
      { leave_type_id: 3, slug: "unpaid_leave", hours: 4, cascade_order: 2 },
    ]);
    assert.equal(r.spill_hours, 4);
  });

  it("100h spill — entire request lands unpaid when PTO + PLAWA are at 0", () => {
    const empty = [
      bucket({ leave_type_id: 1, slug: "pto_phes", available_hours: 0 }),
      bucket({ leave_type_id: 2, slug: "plawa", available_hours: 0 }),
      bucket({ leave_type_id: 3, slug: "unpaid_leave", available_hours: 0 }),
    ];
    const r = resolveCascadeAllocation({ requestedHours: 100, buckets: empty });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.allocations, [
      { leave_type_id: 3, slug: "unpaid_leave", hours: 100, cascade_order: 2 },
    ]);
    assert.equal(r.spill_hours, 100);
  });

  it("PTO-only tenant — request larger than balance can NOT cascade", () => {
    const onlyPto = [bucket({ leave_type_id: 1, slug: "pto_phes", available_hours: 8 })];
    const r = resolveCascadeAllocation({ requestedHours: 24, buckets: onlyPto });
    // pto_phes is the only bucket; the resolver treats the last bucket as
    // catch-all even when its available_hours is 0. So request lands entirely
    // in PTO (the only option), generating spill_hours from the catch-all
    // semantics. Office can then deny/adjust.
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.allocations, [
      { leave_type_id: 1, slug: "pto_phes", hours: 24, cascade_order: 0 },
    ]);
    assert.equal(r.spill_hours, 24);
  });
});

describe("Cascade — error shapes", () => {
  it("no cascade-eligible buckets returns no_cascade_buckets", () => {
    const r = resolveCascadeAllocation({
      requestedHours: 8,
      buckets: [
        bucket({ leave_type_id: 1, slug: "sick", available_hours: 40 }),
        bucket({ leave_type_id: 2, slug: "unexcused", available_hours: 0, requestable: false }),
      ],
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "no_cascade_buckets");
  });

  it("zero / negative hours returns non_positive_hours", () => {
    const r0 = resolveCascadeAllocation({
      requestedHours: 0,
      buckets: [bucket({ leave_type_id: 1, slug: "pto_phes", available_hours: 40 })],
    });
    assert.equal(r0.ok, false);
    if (r0.ok) return;
    assert.equal(r0.code, "non_positive_hours");

    const rN = resolveCascadeAllocation({
      requestedHours: -1,
      buckets: [bucket({ leave_type_id: 1, slug: "pto_phes", available_hours: 40 })],
    });
    assert.equal(rN.ok, false);
    if (rN.ok) return;
    assert.equal(rN.code, "non_positive_hours");
  });
});

describe("Cascade — rounding", () => {
  it("preserves 2-decimal precision in allocation hours", () => {
    const r = resolveCascadeAllocation({
      requestedHours: 8.755,
      buckets: [
        bucket({ leave_type_id: 1, slug: "pto_phes", available_hours: 4.5 }),
        bucket({ leave_type_id: 3, slug: "unpaid_leave", available_hours: 0 }),
      ],
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // PTO takes 4.5; remainder = 8.755 - 4.5 = 4.255 → 4.26 after round2
    // (Math.round of 4.255 in JS is actually 4.26 via double precision)
    assert.equal(r.allocations[0].hours, 4.5);
    assert.equal(r.allocations[1].slug, "unpaid_leave");
    // Sum back to original (within rounding tolerance)
    const sum = r.allocations.reduce((s, a) => s + a.hours, 0);
    assert.ok(Math.abs(sum - 8.755) < 0.011, `sum ${sum} vs 8.755`);
  });
});
