/**
 * Cutover 1C — Distance utilities for clock geofence math.
 *
 * Haversine over the WGS-84 mean earth radius. Used by the clock-in /
 * clock-out routes to compute distance_from_site_meters and to decide
 * within_geofence. Tenant geofence threshold lives on
 * companies.geofence_clockin_radius_ft (default 500ft; spec called for
 * 600ft / ~183m — Sal can flip the tenant value if he wants the wider
 * radius). The conversion ft→m is documented in
 * companyGeofenceMeters() below so the route uses the same constant.
 */

const EARTH_RADIUS_METERS = 6_371_000;
const METERS_PER_FOOT = 0.3048;

/**
 * Great-circle distance between two lat/lng points in meters.
 * Both points are degrees; conversion happens inside.
 */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Convert the tenant's geofence_clockin_radius_ft setting to meters.
 * Centralized so route code never inlines the ft→m conversion.
 */
export function feetToMeters(feet: number): number {
  return feet * METERS_PER_FOOT;
}

/**
 * The companies row carries the radius in feet (legacy field). Wrap
 * the lookup so the route reads a meter value directly. NULL/zero
 * fallback is the spec default (~183m / 600ft) — never block a clock
 * event on a missing tenant setting.
 */
export function companyGeofenceMeters(
  radiusFt: number | null | undefined,
): number {
  const ft = radiusFt && radiusFt > 0 ? radiusFt : 600;
  return feetToMeters(ft);
}
