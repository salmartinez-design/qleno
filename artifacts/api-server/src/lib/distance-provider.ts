/**
 * Cutover 2A — Provider-neutral driving-distance interface.
 *
 * The mileage automation reads + writes through this interface, NOT
 * directly against Google. Today the only adapter is the existing
 * Google Distance Matrix path (lib/eta.ts is the legacy single-purpose
 * wrapper; this file is the multi-purpose successor). A tenant
 * wanting Mapbox / OSRM / HERE / TomTom swaps the adapter via env
 * (or, later, a per-company setting) and no mileage-routes code
 * changes.
 *
 * Returns BOTH driving meters and driving minutes in one call. The
 * Phes handbook pays mileage on distance ($0.725/mi between client
 * locations within the same shift); duration is captured for office
 * visibility and to leave the door open for a future "pay drive time"
 * policy without a schema migration.
 *
 * Haversine fallback at 25 mph stays available so a missing API key
 * or a transient API failure does not block mileage calculation —
 * miles get computed against the great-circle distance. The fallback
 * is conservative (great-circle < driving) so techs are not
 * overpaid in the rare case the API is down; the row gets a flag
 * the office can review.
 */

export type LegMeasurement = {
  /** Driving meters between origin and destination. */
  meters: number;
  /** Driving minutes (in traffic when available). */
  minutes: number;
  /** Provider identifier so the row can be audited. */
  source:
    | "google_distance_matrix"
    | "haversine_fallback"
    | "manual_override";
  /** True when the measurement came from a real driving-route API,
   *  false when it's a great-circle estimate. The mileage routes
   *  use this to decide whether to flag the row for office review. */
  is_estimated: boolean;
};

export interface DistanceProvider {
  /** Pure async function. Never throws. Returns null only when EVERY
   *  available strategy failed; callers must handle null as "no
   *  measurement available — skip or flag." */
  measureLeg(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
  ): Promise<LegMeasurement | null>;
}

const EARTH_RADIUS_METERS = 6_371_000;
const METERS_PER_MILE = 1609.344;
const FALLBACK_AVG_MPH = 25;

/**
 * The current default provider. Google Distance Matrix with haversine
 * fallback. Used by the mileage routes; tests can swap in a fake.
 */
export const defaultDistanceProvider: DistanceProvider = {
  async measureLeg(fromLat, fromLng, toLat, toLng) {
    const matrix = await tryDistanceMatrix(fromLat, fromLng, toLat, toLng);
    if (matrix != null) return matrix;
    // Fallback: great-circle distance + 25 mph estimate. Conservative
    // by design (great-circle < driving distance).
    const meters = haversineMeters(fromLat, fromLng, toLat, toLng);
    const minutes = Math.max(
      1,
      Math.round((meters / METERS_PER_MILE / FALLBACK_AVG_MPH) * 60),
    );
    return {
      meters: Math.round(meters),
      minutes,
      source: "haversine_fallback",
      is_estimated: true,
    };
  },
};

async function tryDistanceMatrix(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): Promise<LegMeasurement | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  try {
    const origins = `${fromLat},${fromLng}`;
    const destinations = `${toLat},${toLng}`;
    const url =
      `https://maps.googleapis.com/maps/api/distancematrix/json` +
      `?origins=${encodeURIComponent(origins)}` +
      `&destinations=${encodeURIComponent(destinations)}` +
      `&mode=driving` +
      `&departure_time=now` +
      `&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("[distance] Distance Matrix HTTP error", res.status);
      return null;
    }
    const data = (await res.json()) as any;
    const elem = data?.rows?.[0]?.elements?.[0];
    if (!elem || elem.status !== "OK") {
      console.warn("[distance] Distance Matrix non-OK status:", elem?.status);
      return null;
    }
    const meters =
      typeof elem.distance?.value === "number" ? elem.distance.value : null;
    const seconds =
      elem.duration_in_traffic?.value ?? elem.duration?.value ?? null;
    if (meters == null || typeof seconds !== "number") return null;
    return {
      meters,
      minutes: Math.max(1, Math.round(seconds / 60)),
      source: "google_distance_matrix",
      is_estimated: false,
    };
  } catch (err) {
    console.warn("[distance] Distance Matrix error:", err);
    return null;
  }
}

/** Great-circle distance between two lat/lng points in meters.
 *  Exported so tests can use the same constant the provider does. */
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

export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE;
}

export const METERS_PER_MILE_CONST = METERS_PER_MILE;
