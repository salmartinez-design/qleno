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
    WHEN j.account_property_id IS NOT NULL THEN COALESCE(ap.lat, j.job_lat)
    WHEN j.job_lat IS NOT NULL AND j.address_street IS NOT NULL
         AND lower(btrim(j.address_street))
             IS DISTINCT FROM lower(btrim(split_part(COALESCE(c.address, ''), ',', 1)))
      THEN j.job_lat
    ELSE COALESCE(c.lat, j.job_lat)
  END`;

/** Raw-SQL form. Requires aliases j / c / ap in scope. */
export const JOB_COORD_LNG: SQL = sql`CASE
    WHEN j.account_property_id IS NOT NULL THEN COALESCE(ap.lng, j.job_lng)
    WHEN j.job_lat IS NOT NULL AND j.address_street IS NOT NULL
         AND lower(btrim(j.address_street))
             IS DISTINCT FROM lower(btrim(split_part(COALESCE(c.address, ''), ',', 1)))
      THEN j.job_lng
    ELSE COALESCE(c.lng, j.job_lng)
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
  jobs: { job_lat: unknown; job_lng: unknown; address_street: unknown; account_property_id: unknown },
  clients: { lat: unknown; lng: unknown; address: unknown },
  props: { lat: unknown; lng: unknown },
): { lat: SQL<string | null>; lng: SQL<string | null> } {
  const isGenuineOverride = sql`${jobs.job_lat} IS NOT NULL AND ${jobs.address_street} IS NOT NULL
      AND lower(btrim(${jobs.address_street}))
          IS DISTINCT FROM lower(btrim(split_part(COALESCE(${clients.address}, ''), ',', 1)))`;
  return {
    lat: sql<string | null>`CASE
        WHEN ${jobs.account_property_id} IS NOT NULL THEN COALESCE(${props.lat}, ${jobs.job_lat})
        WHEN ${isGenuineOverride} THEN ${jobs.job_lat}
        ELSE COALESCE(${clients.lat}, ${jobs.job_lat})
      END`,
    lng: sql<string | null>`CASE
        WHEN ${jobs.account_property_id} IS NOT NULL THEN COALESCE(${props.lng}, ${jobs.job_lng})
        WHEN ${isGenuineOverride} THEN ${jobs.job_lng}
        ELSE COALESCE(${clients.lng}, ${jobs.job_lng})
      END`,
  };
}
