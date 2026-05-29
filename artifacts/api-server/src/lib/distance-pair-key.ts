/**
 * Cutover 2A (corrective) — pure pair-key shape for the distance
 * cache. Kept in its own module (no DB import) so unit tests can
 * import it without triggering drizzle's connection construction at
 * module load.
 *
 * Coords are rounded to 7 decimal places before keying to match the
 * `numeric(10,7)` precision of the DB column — coords arrived at by
 * arithmetic could otherwise miss a cache row the DB considers
 * identical.
 */

export const COORD_DECIMALS = 7;

export function roundCoord(n: number): number {
  const f = 10 ** COORD_DECIMALS;
  return Math.round(n * f) / f;
}

export function keyForPair(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): string {
  return [
    roundCoord(fromLat).toFixed(COORD_DECIMALS),
    roundCoord(fromLng).toFixed(COORD_DECIMALS),
    roundCoord(toLat).toFixed(COORD_DECIMALS),
    roundCoord(toLng).toFixed(COORD_DECIMALS),
  ].join("|");
}
