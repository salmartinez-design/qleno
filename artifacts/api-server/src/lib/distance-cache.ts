/**
 * Cutover 2A (corrective) — Address-pair distance cache.
 *
 * Wraps any DistanceProvider. On measureLeg(), checks the per-tenant
 * `distance_cache` first; if the (from_lat, from_lng, to_lat, to_lng)
 * pair is present, returns the cached measurement directly. Otherwise
 * delegates to the inner provider and writes the result back.
 *
 * Provenance is preserved across cache hits: the cache row carries
 * the original `source` and `is_estimated` flag, so a forensic
 * "where did this measurement come from?" query still resolves to the
 * real upstream (google_distance_matrix / haversine_fallback /
 * manual_override), not to a generic "cache" sentinel. The cache is
 * an optimization, not an audit-trail rewrite.
 *
 * Force-refresh: clearCachedLeg(companyId, coords) drops the row so
 * the next call re-fetches. Use when an address moves and the
 * coordinates change underneath the same job.
 *
 * Coordinate precision: the DB column is numeric(10,7) (matches
 * clients.lat/lng), so the unique index is exact on the persisted
 * shape. We round inputs to 7 decimal places before hitting the cache
 * to keep float coords (e.g. arithmetic-derived test inputs) from
 * missing a cache row that the DB would otherwise consider identical.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { distanceCacheTable } from "@workspace/db/schema";
import type { DistanceProvider, LegMeasurement } from "./distance-provider.js";
import { COORD_DECIMALS, roundCoord, keyForPair } from "./distance-pair-key.js";

export { keyForPair } from "./distance-pair-key.js";

/** Wrap `inner` in a per-tenant cache scoped to `companyId`. */
export function withDistanceCache(
  inner: DistanceProvider,
  companyId: number,
): DistanceProvider {
  return {
    async measureLeg(fromLat, fromLng, toLat, toLng) {
      const fLat = roundCoord(fromLat);
      const fLng = roundCoord(fromLng);
      const tLat = roundCoord(toLat);
      const tLng = roundCoord(toLng);
      const hit = await db
        .select({
          meters: distanceCacheTable.meters,
          minutes: distanceCacheTable.minutes,
          source: distanceCacheTable.source,
          is_estimated: distanceCacheTable.is_estimated,
        })
        .from(distanceCacheTable)
        .where(
          and(
            eq(distanceCacheTable.company_id, companyId),
            eq(distanceCacheTable.from_lat, fLat.toFixed(COORD_DECIMALS)),
            eq(distanceCacheTable.from_lng, fLng.toFixed(COORD_DECIMALS)),
            eq(distanceCacheTable.to_lat, tLat.toFixed(COORD_DECIMALS)),
            eq(distanceCacheTable.to_lng, tLng.toFixed(COORD_DECIMALS)),
          ),
        )
        .limit(1);
      if (hit[0]) {
        const row = hit[0];
        return {
          meters: Number(row.meters),
          minutes: row.minutes,
          source: row.source as LegMeasurement["source"],
          is_estimated: row.is_estimated,
        };
      }
      const measurement = await inner.measureLeg(fromLat, fromLng, toLat, toLng);
      if (measurement == null) return null;
      await db
        .insert(distanceCacheTable)
        .values({
          company_id: companyId,
          from_lat: fLat.toFixed(COORD_DECIMALS),
          from_lng: fLng.toFixed(COORD_DECIMALS),
          to_lat: tLat.toFixed(COORD_DECIMALS),
          to_lng: tLng.toFixed(COORD_DECIMALS),
          meters: measurement.meters.toFixed(2),
          minutes: measurement.minutes,
          source: measurement.source,
          is_estimated: measurement.is_estimated,
        })
        .onConflictDoNothing();
      return measurement;
    },
  };
}

/** Drop a single cached pair so the next call re-fetches. Use when
 *  the underlying address has moved and the coords changed. */
export async function clearCachedLeg(
  companyId: number,
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): Promise<void> {
  await db
    .delete(distanceCacheTable)
    .where(
      and(
        eq(distanceCacheTable.company_id, companyId),
        eq(
          distanceCacheTable.from_lat,
          roundCoord(fromLat).toFixed(COORD_DECIMALS),
        ),
        eq(
          distanceCacheTable.from_lng,
          roundCoord(fromLng).toFixed(COORD_DECIMALS),
        ),
        eq(distanceCacheTable.to_lat, roundCoord(toLat).toFixed(COORD_DECIMALS)),
        eq(distanceCacheTable.to_lng, roundCoord(toLng).toFixed(COORD_DECIMALS)),
      ),
    );
}

