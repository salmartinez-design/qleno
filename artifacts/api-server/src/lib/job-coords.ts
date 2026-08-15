// [mileage-stale-address 2026-08-09] Which point on the map is this job at?
//
// THE BUG THIS CLOSES (Maribel, payroll review): "in some cases, mostly
// commercial, it's taking the wrong address to calculate the distance. For
// Cucci it's taking the one in Chicago Ridge, so the rest are showing as if
// they are clocking in and out at a different place." And: "same thing
// happened with Carol — since we updated that address it's using the old one."
//
// Both are the same defect. `jobs.job_lat` / `jobs.job_lng` is a geocode
// SNAPSHOT stamped when the job is created. Nothing re-stamps it. The moment
// the office corrects a client's or a property's address, every already-created
// job for that place keeps pointing at the OLD spot on the map — and the
// mileage query preferred that frozen snapshot over the live address:
//
//     COALESCE(j.job_lat, c.lat, ap.lat)   <-- snapshot wins. Wrong.
//
// Measured on production 2026-08-09: 392 jobs carried a geocode that disagreed
// with the current address on their client/property, 218 of them still in the
// future. Carol Butler: 77 jobs, 8.9 miles off. KMA properties: up to 11.4
// miles off. Every drive leg touching one of those jobs was measured from the
// wrong end, so reimbursed mileage was wrong in both directions.
//
// THE RULE NOW — the live address wins, and the snapshot is the fallback:
//
//   1. Job pinned to an account_property  -> that property's CURRENT coords.
//      A property job IS that property; there is no such thing as a per-job
//      address override on one. This is what fixes Cucci / KMA, and it means a
//      future property address correction flows through on its own.
//
//   2. Client job carrying a genuine one-off address -> the job's own snapshot.
//      "Genuine" means its street text actually differs from the client's
//      current street (a move-out at a different house, say). Necessary because
//      address_street is NOT a reliable override flag by itself: of the 783
//      residential jobs that have one, 565 are just a verbatim copy of the
//      client's own address. Treating those copies as overrides is what would
//      have kept Carol pinned to Oak Park.
//
//   3. Otherwise -> the client's CURRENT coords. This is Carol's case.
//
//   4. Nothing else available -> the snapshot, rather than no coords at all.
//
//   5. [mileage-address-geocode 2026-08-15] Still nothing -> `jobs.address_lat/
//      address_lng`. THE BUG THIS CLOSES (Maribel, payroll review, Vanessa
//      Aranda's week of Aug 3): a drive that simply never appeared. Job 20225
//      (Ribstein, 5487 S Cornell) HAD a correct geocode all along — it just
//      lived in address_lat/address_lng, which this resolver did not read, and
//      its client had never been geocoded. So the resolver returned NULL, the
//      engine logged `no_from_coords`, and the 9.46-mile leg was dropped in
//      silence. She was paid $7.60 for a week that measured $14.46, and the
//      only reason anyone found out is that Maribel added the miles by hand.
//      Every other surface already coalesced this column — dispatch.ts:191 and
//      timeclock.ts:1765 both do — so mileage was the lone holdout. 7 jobs
//      resolve only through this branch today.
//
// PAIRING INVARIANT: lat and lng must come from the SAME source, or the leg is
// measured between two different places. The branches used to be `COALESCE(a,
// b)` per axis, which silently allowed lat from one source and lng from
// another whenever a row had a half-filled pair. Each branch now tests BOTH
// axes before it claims the row, so a half-pair falls through to the next
// source instead of producing a hybrid point. A job that reaches the end with
// nothing resolves to NULL and is reported as unmeasured — never guessed.
//
// KNOWN GAP, deliberately left: if someone edits the address on a job that is a
// genuine one-off (branch 2), that job's snapshot still goes stale, because
// nothing re-geocodes it. Branch 2 is rare (218 jobs) and the failure is the
// pre-existing behaviour, not a regression. The real repair is re-geocoding on
// address edit; that is a separate change.
//
// STREET COMPARISON is normalized only by case + trim, so "10418 S Keating"
// vs "10418 South Keating" reads as a difference and falls to branch 2. That
// direction is deliberate: it degrades to today's behaviour (use the snapshot)
// instead of silently relocating a job.
//
// USAGE: the caller must alias the tables exactly `j` (jobs), `c` (clients,
// LEFT JOIN), `ap` (account_properties, LEFT JOIN). Drizzle callers pass the
// table objects instead; see jobCoordLatDrizzle / jobCoordLngDrizzle.

import { sql, type SQL } from "drizzle-orm";

/** Raw-SQL form. Requires aliases j / c / ap in scope. */
export const JOB_COORD_LAT: SQL = sql`CASE
    WHEN j.account_property_id IS NOT NULL THEN
      CASE WHEN ap.lat IS NOT NULL AND ap.lng IS NOT NULL THEN ap.lat
           WHEN j.job_lat IS NOT NULL AND j.job_lng IS NOT NULL THEN j.job_lat
           ELSE j.address_lat END
    WHEN j.job_lat IS NOT NULL AND j.job_lng IS NOT NULL AND j.address_street IS NOT NULL
         AND lower(btrim(j.address_street))
             IS DISTINCT FROM lower(btrim(split_part(COALESCE(c.address, ''), ',', 1)))
      THEN j.job_lat
    WHEN c.lat IS NOT NULL AND c.lng IS NOT NULL THEN c.lat
    WHEN j.job_lat IS NOT NULL AND j.job_lng IS NOT NULL THEN j.job_lat
    ELSE j.address_lat
  END`;

/** Raw-SQL form. Requires aliases j / c / ap in scope. */
export const JOB_COORD_LNG: SQL = sql`CASE
    WHEN j.account_property_id IS NOT NULL THEN
      CASE WHEN ap.lat IS NOT NULL AND ap.lng IS NOT NULL THEN ap.lng
           WHEN j.job_lat IS NOT NULL AND j.job_lng IS NOT NULL THEN j.job_lng
           ELSE j.address_lng END
    WHEN j.job_lat IS NOT NULL AND j.job_lng IS NOT NULL AND j.address_street IS NOT NULL
         AND lower(btrim(j.address_street))
             IS DISTINCT FROM lower(btrim(split_part(COALESCE(c.address, ''), ',', 1)))
      THEN j.job_lng
    WHEN c.lat IS NOT NULL AND c.lng IS NOT NULL THEN c.lng
    WHEN j.job_lat IS NOT NULL AND j.job_lng IS NOT NULL THEN j.job_lng
    ELSE j.address_lng
  END`;

/**
 * Drizzle-builder form of the same rule, for `.select()` callers that pass
 * table objects rather than raw aliases. Kept beside the raw version on
 * purpose — if the rule changes, both must change together, and having them
 * adjacent is what makes that obvious.
 *
 * The lat/lng branch conditions are intentionally identical to each other; a
 * job must resolve BOTH coordinates from the same source or the leg is measured
 * between two different places.
 */
export function jobCoordDrizzle(
  jobs: {
    job_lat: unknown; job_lng: unknown; address_street: unknown;
    account_property_id: unknown; address_lat: unknown; address_lng: unknown;
  },
  clients: { lat: unknown; lng: unknown; address: unknown },
  props: { lat: unknown; lng: unknown },
): { lat: SQL<string | null>; lng: SQL<string | null> } {
  const isGenuineOverride = sql`${jobs.job_lat} IS NOT NULL AND ${jobs.job_lng} IS NOT NULL
      AND ${jobs.address_street} IS NOT NULL
      AND lower(btrim(${jobs.address_street}))
          IS DISTINCT FROM lower(btrim(split_part(COALESCE(${clients.address}, ''), ',', 1)))`;
  const hasProp = sql`${props.lat} IS NOT NULL AND ${props.lng} IS NOT NULL`;
  const hasJob = sql`${jobs.job_lat} IS NOT NULL AND ${jobs.job_lng} IS NOT NULL`;
  const hasClient = sql`${clients.lat} IS NOT NULL AND ${clients.lng} IS NOT NULL`;
  return {
    lat: sql<string | null>`CASE
        WHEN ${jobs.account_property_id} IS NOT NULL THEN
          CASE WHEN ${hasProp} THEN ${props.lat}
               WHEN ${hasJob} THEN ${jobs.job_lat}
               ELSE ${jobs.address_lat} END
        WHEN ${isGenuineOverride} THEN ${jobs.job_lat}
        WHEN ${hasClient} THEN ${clients.lat}
        WHEN ${hasJob} THEN ${jobs.job_lat}
        ELSE ${jobs.address_lat}
      END`,
    lng: sql<string | null>`CASE
        WHEN ${jobs.account_property_id} IS NOT NULL THEN
          CASE WHEN ${hasProp} THEN ${props.lng}
               WHEN ${hasJob} THEN ${jobs.job_lng}
               ELSE ${jobs.address_lng} END
        WHEN ${isGenuineOverride} THEN ${jobs.job_lng}
        WHEN ${hasClient} THEN ${clients.lng}
        WHEN ${hasJob} THEN ${jobs.job_lng}
        ELSE ${jobs.address_lng}
      END`,
  };
}
