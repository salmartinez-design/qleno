/**
 * Cutover 1C — ETA computation for one-tap on-my-way.
 *
 * Two strategies in priority order:
 *   1. Google Distance Matrix API (when GOOGLE_MAPS_API_KEY is set).
 *      Real driving time including traffic conditions.
 *   2. Haversine fallback at 25 mph average — only used when the
 *      Distance Matrix call fails or the key is missing. Better than
 *      forcing the tech to type their own guess.
 *
 * The function never throws — a failed API call falls through to the
 * haversine fallback and logs a warning. The on-my-way send must not
 * be blocked by an ETA lookup; the worst case is a slightly off
 * estimate, and the spec rule is "don't make the tech type."
 */

const EARTH_RADIUS_MILES = 3958.8;
const FALLBACK_AVG_MPH = 25;

export async function estimateEtaMinutes(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): Promise<number> {
  const fromMatrix = await tryDistanceMatrix(fromLat, fromLng, toLat, toLng);
  if (fromMatrix != null) return fromMatrix;
  return haversineEtaMinutes(fromLat, fromLng, toLat, toLng);
}

async function tryDistanceMatrix(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): Promise<number | null> {
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
      console.warn("[eta] Distance Matrix HTTP error", res.status);
      return null;
    }
    const data = (await res.json()) as any;
    const elem = data?.rows?.[0]?.elements?.[0];
    if (!elem || elem.status !== "OK") {
      console.warn("[eta] Distance Matrix non-OK status:", elem?.status);
      return null;
    }
    const dur =
      elem.duration_in_traffic?.value ?? elem.duration?.value ?? null;
    if (typeof dur !== "number") return null;
    return Math.max(1, Math.round(dur / 60));
  } catch (err) {
    console.warn("[eta] Distance Matrix error:", err);
    return null;
  }
}

function haversineEtaMinutes(
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
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const miles = EARTH_RADIUS_MILES * c;
  const minutes = (miles / FALLBACK_AVG_MPH) * 60;
  return Math.max(1, Math.round(minutes));
}
