/**
 * [mileage-service-area 2026-08-15] Is this coordinate anywhere the tenant
 * actually works?
 *
 * THE GAP THIS CLOSES. Two guards already stand between a bad geocode and a
 * paycheck, and both of them look at the *pair*, not the *point*:
 *
 *   - MAX_PLAUSIBLE_LEG_MILES rejects a leg whose measured distance is absurd.
 *   - PAY_ESTIMATED_MEASUREMENTS refuses to price a straight-line fallback.
 *
 * Together they catch the Melbourne case (job 8784: one endpoint on the wrong
 * continent, 9,668 miles, $7,009.71). They do not catch its quieter siblings:
 *
 *   - BOTH endpoints wrong, in the same wrong place. Two geocodes that both
 *     landed in the same distant metro measure a few honest-looking miles
 *     apart, on a real road, with a real road route. Every existing guard
 *     passes them, and the number that reaches payroll is fiction.
 *   - ONE endpoint wrong but not wrong enough. A geocode that lands 50 miles
 *     off is under the 60-mile ceiling and has a perfectly real road route.
 *     It reads as a long drive rather than as broken data, and it pays.
 *
 * The distinguishing fact in both is a property of a single coordinate: it is
 * nowhere near where this tenant works. So this is the guard that looks at one
 * point at a time.
 *
 * WHY THE AREA IS DERIVED, NOT CONFIGURED. A hardcoded Chicagoland box would be
 * wrong the day a second tenant lands, and a settings field nobody fills in is
 * a guard that silently does nothing. So the area is measured from the tenant's
 * own geocoded clients: the center is the MEDIAN latitude and longitude of
 * those points, and anything past SERVICE_AREA_RADIUS_MILES from it is out.
 *
 * The median is the load-bearing choice. A mean would be dragged by exactly the
 * outliers this exists to catch — one Melbourne client pulls a Chicago mean
 * hundreds of miles into the Pacific and quietly widens the area around the bad
 * data. A median does not move at all until half the sample is wrong.
 *
 * HOW IT FAILS: open, never closed. Below SERVICE_AREA_MIN_SAMPLE geocoded
 * clients there is no honest center to compute, so `loadServiceArea` returns
 * null and callers treat every point as acceptable. A new or barely-geocoded
 * tenant gets today's behaviour, not a payroll run where every drive is
 * rejected by a center derived from four addresses. The guard's job is to catch
 * data that is obviously wrong, and "obviously" requires a real baseline.
 *
 * WHY THE RADIUS IS GENEROUS. 100 miles is far wider than any real Phes drive
 * (the longest genuine leg on the books is 35.26 miles) and wider than the
 * 60-mile leg ceiling. That is deliberate — the two guards are not redundant
 * and should not be tuned toward each other. The ceiling is the tight check on
 * a pair; this is the coarse check on a point, and it only needs to be tight
 * enough to catch a geocode that landed in the wrong region entirely. Setting
 * it near the ceiling would start rejecting real outlying work, and a guard
 * that clips real drives out of someone's pay is worse than the one it
 * replaced: the office reads the mileage total off the payroll summary and
 * types it into the outside payroll system by hand, so a wrongly-rejected leg
 * is a silent underpayment, the same failure this whole effort is closing.
 *
 * A rejected point is never guessed at and never priced. It produces no leg, so
 * /payroll/summary reports the drive as unmeasured and the office sees the hole.
 */

import { sql, type SQL } from "drizzle-orm";

/** Miles from the derived center past which a coordinate is not believable. */
export const SERVICE_AREA_RADIUS_MILES = 100;

/**
 * Minimum geocoded clients before a center is trustworthy. Under this the
 * guard disables itself rather than police pay with a center it guessed.
 */
export const SERVICE_AREA_MIN_SAMPLE = 20;

export type ServiceArea = {
  /** Median latitude of the tenant's geocoded clients. */
  lat: number;
  /** Median longitude of the tenant's geocoded clients. */
  lng: number;
  /** Points farther than this from (lat, lng) are rejected. */
  radius_miles: number;
  /** How many geocoded clients the center was derived from. */
  sample_size: number;
};

const EARTH_RADIUS_MILES = 3958.7613;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in miles. Only ever used as a coarse "is this point
 *  in the right region" test — never as a payable distance. */
export function haversineMiles(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Derive the service area from a tenant's geocoded points.
 *
 * Pure, so the rule is testable without a database. Returns null when the
 * sample is too small to establish a center — callers must read null as
 * "no opinion", not as "reject everything".
 */
export function deriveServiceArea(
  points: ReadonlyArray<{ lat: number; lng: number }>,
  minSample: number = SERVICE_AREA_MIN_SAMPLE,
  radiusMiles: number = SERVICE_AREA_RADIUS_MILES,
): ServiceArea | null {
  const lats: number[] = [];
  const lngs: number[] = [];
  for (const p of points) {
    // A 0/0 pair is the classic failed-geocode sentinel, not a real address in
    // the Gulf of Guinea. Excluding it keeps a batch of failures from dragging
    // the median toward the equator.
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (p.lat === 0 && p.lng === 0) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) continue;
    lats.push(p.lat);
    lngs.push(p.lng);
  }
  if (lats.length < minSample) return null;
  return {
    lat: median(lats),
    lng: median(lngs),
    radius_miles: radiusMiles,
    sample_size: lats.length,
  };
}

/**
 * The same derivation, expressed as one query, so a route can resolve a
 * tenant's center without pulling every client coordinate into memory.
 *
 * Kept beside `deriveServiceArea` on purpose: the two must agree, and the
 * filters are duplicated between them precisely so a change to one is obvious
 * next to the other. `percentile_cont` is Postgres's median, and the same
 * 0/0-and-out-of-range exclusions apply for the same reason.
 *
 * The sample is clients only. It is the tenant's largest set of real geocoded
 * addresses by a wide margin, it is unambiguously company-scoped, and mixing in
 * a second, much smaller table would let a handful of bad property geocodes
 * carry more weight in the median than they deserve.
 */
export function serviceAreaCenterSql(companyId: number): SQL {
  return sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c.lat::float8) AS lat,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY c.lng::float8) AS lng,
           COUNT(*)::int AS n
      FROM clients c
     WHERE c.company_id = ${companyId}
       AND c.lat IS NOT NULL AND c.lng IS NOT NULL
       AND NOT (c.lat::float8 = 0 AND c.lng::float8 = 0)
       AND abs(c.lat::float8) <= 90
       AND abs(c.lng::float8) <= 180
  `;
}

/**
 * Resolve a tenant's area. Every caller — the mileage writers and the payroll
 * summary — goes through this, so "outside the service area" means one thing
 * across the whole system rather than one thing per surface.
 *
 * The executor is passed in rather than importing a db handle, which keeps this
 * module free of a database dependency and testable as pure logic.
 *
 * Deliberately NOT cached: a geocode fix should take effect on the next
 * recompute, not after a restart. It is one aggregate query.
 *
 * On any failure it returns null, which every caller reads as "no opinion" and
 * so behaves exactly as it did before this guard existed. A check against bad
 * data must never itself become a reason nobody gets paid.
 */
export async function loadServiceArea(
  exec: (query: SQL) => Promise<{ rows: unknown[] }>,
  companyId: number,
): Promise<ServiceArea | null> {
  try {
    const res = await exec(serviceAreaCenterSql(companyId));
    return serviceAreaFromRow(res.rows[0] as any);
  } catch {
    return null;
  }
}

/** Read one `serviceAreaCenterSql` row into a ServiceArea, applying the
 *  minimum-sample rule. Returns null (= no opinion) when the tenant has too
 *  few geocoded clients to establish a center. */
export function serviceAreaFromRow(
  row: { lat: unknown; lng: unknown; n: unknown } | undefined,
  minSample: number = SERVICE_AREA_MIN_SAMPLE,
  radiusMiles: number = SERVICE_AREA_RADIUS_MILES,
): ServiceArea | null {
  if (!row) return null;
  // `Number(null)` is 0, not NaN — so a NULL median would sail through a bare
  // isFinite check and install a center at 0/0, the Gulf of Guinea. That is the
  // same sentinel `deriveServiceArea` throws away, and installing it as the
  // CENTER would be worse than having no area at all: every real address would
  // then sit thousands of miles outside it and every drive would be rejected.
  if (row.lat == null || row.lng == null) return null;
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  const n = Number(row.n);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (!Number.isFinite(n) || n < minSample) return null;
  return { lat, lng, radius_miles: radiusMiles, sample_size: n };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Is this coordinate believable for this tenant?
 *
 * A null area means the tenant has no established center, and the answer is
 * yes — see the fail-open note at the top of this file.
 */
export function isWithinServiceArea(
  lat: number | null | undefined,
  lng: number | null | undefined,
  area: ServiceArea | null,
): boolean {
  if (area == null) return true;
  if (lat == null || lng == null) return true; // absent coords are a different
                                               // failure, already reported as
                                               // skip_no_*_coords.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return haversineMiles(area.lat, area.lng, lat, lng) <= area.radius_miles;
}
