/**
 * Leave bucket cascade — PTO → PLAWA → Unpaid Leave fall-through.
 *
 * The 3A single-bucket flow refused requests whose hours exceeded one
 * bucket's available balance. In reality employees often need 24h off
 * and have 16h PTO + 8h PLAWA — they shouldn't have to know which
 * buckets to draw from or submit three separate requests. The cascade
 * does that allocation server-side.
 *
 * This module is the PURE allocator. It takes ordered buckets with
 * available balances, a total request, and returns the per-bucket
 * allocation. Tests drive it without touching the DB. The route
 * (routes/leave.ts) calls this to decide what rows to insert.
 *
 * The cascade order is the Phes convention:
 *   1. PTO          (paid, flat_grant — the most valuable bucket)
 *   2. PLAWA        (paid, accrue_per_hours — Illinois state-mandated)
 *   3. Unpaid Leave (the catch-all that absorbs whatever's left over)
 *
 * Slugs (matched case-insensitively): pto*, plawa, unpaid_leave.
 * Tenants that lack one or more of these buckets just skip that step
 * (PTO → Unpaid if no PLAWA, etc). Tenants that lack ALL three get a
 * descriptive error rather than a silent allocation failure.
 */

/** The minimum bucket shape the allocator needs. */
export interface CascadeBucketInput {
  leave_type_id: number;
  slug: string;
  available_hours: number;
  /** Cascade only allocates to requestable buckets. Office-recorded
   *  buckets (Unexcused) are filtered out before they reach here. */
  requestable: boolean;
}

export interface CascadeAllocation {
  leave_type_id: number;
  slug: string;
  hours: number;
  /** 0-based index into the cascade order, NOT a bucket position. */
  cascade_order: number;
}

export interface CascadeResolveResult {
  ok: true;
  allocations: CascadeAllocation[];
  /** Hours that landed in the final (catch-all) bucket. Surfaced for
   *  UI/preview so the employee can see "12h will be unpaid" up-front. */
  spill_hours: number;
}
export interface CascadeResolveError {
  ok: false;
  code: "no_cascade_buckets" | "non_positive_hours" | "ordering_required";
  message: string;
}

/** Cascade priority — first slug in this list wins, last is catch-all. */
export const DEFAULT_CASCADE_SLUG_ORDER: readonly string[] = [
  "pto_phes",  // Phes seeded PTO
  "pto",       // Default-tenant PTO
  "plawa",     // Illinois PLAWA
  "unpaid_leave",
] as const;

/**
 * Order the buckets according to DEFAULT_CASCADE_SLUG_ORDER (or a
 * caller-supplied override). Buckets matching no slug are dropped from
 * the cascade (they belong to other features like Sick or Unexcused).
 *
 * Slug match is case-insensitive and treats `pto_phes` and `pto` as
 * equivalent for tenants that have one but not the other.
 */
export function orderBucketsForCascade(
  buckets: ReadonlyArray<CascadeBucketInput>,
  customOrder?: readonly string[],
): CascadeBucketInput[] {
  const order = customOrder ?? DEFAULT_CASCADE_SLUG_ORDER;
  const positionOf = (slug: string): number => {
    const s = slug.toLowerCase();
    // PTO equivalence: a tenant with only 'pto' OR only 'pto_phes' should
    // hit the highest-priority PTO slot regardless of which form the
    // cascade order lists first.
    for (let i = 0; i < order.length; i++) {
      const target = order[i].toLowerCase();
      if (s === target) return i;
      if ((target === "pto" || target === "pto_phes") && (s === "pto" || s === "pto_phes")) {
        return i;
      }
    }
    return -1;
  };
  return buckets
    .filter((b) => b.requestable && positionOf(b.slug) >= 0)
    .sort((a, b) => positionOf(a.slug) - positionOf(b.slug));
}

/**
 * Allocate `requestedHours` across cascade buckets greedily, in order.
 * The LAST bucket in the ordered list absorbs the remainder even if
 * its available_hours is 0 — that's the "catch-all" semantics. By
 * convention the last bucket is Unpaid Leave, which has no real
 * balance to enforce.
 *
 * Returns one allocation per bucket that actually receives hours
 * (skips zero-hour rows so the row count matches what's useful).
 */
export function resolveCascadeAllocation(input: {
  requestedHours: number;
  buckets: ReadonlyArray<CascadeBucketInput>;
  customOrder?: readonly string[];
}): CascadeResolveResult | CascadeResolveError {
  if (input.requestedHours <= 0) {
    return {
      ok: false,
      code: "non_positive_hours",
      message: "Hours requested must be positive.",
    };
  }
  const ordered = orderBucketsForCascade(input.buckets, input.customOrder);
  if (ordered.length === 0) {
    return {
      ok: false,
      code: "no_cascade_buckets",
      message:
        "No cascade-eligible buckets available. Tenant needs at least one of PTO / PLAWA / Unpaid Leave.",
    };
  }

  const allocations: CascadeAllocation[] = [];
  let remaining = input.requestedHours;
  for (let i = 0; i < ordered.length; i++) {
    const bucket = ordered[i];
    const isCatchAll = i === ordered.length - 1;
    const take = isCatchAll
      ? remaining
      : Math.min(remaining, Math.max(0, bucket.available_hours));
    if (take > 0) {
      allocations.push({
        leave_type_id: bucket.leave_type_id,
        slug: bucket.slug,
        // Round to 2 decimals to match the leave_requests.hours precision.
        hours: Math.round(take * 100) / 100,
        cascade_order: i,
      });
      remaining = Math.round((remaining - take) * 100) / 100;
    }
    if (remaining <= 0) break;
  }

  const spillRow = allocations[allocations.length - 1];
  const lastIsCatchAll =
    allocations.length > 0 &&
    ordered.findIndex((b) => b.leave_type_id === spillRow.leave_type_id) ===
      ordered.length - 1;
  const spill_hours = lastIsCatchAll ? spillRow.hours : 0;

  return { ok: true, allocations, spill_hours };
}
