/**
 * Keep a client's UPCOMING job cards on the client's current address.
 *
 * THE BUG THIS CLOSES (Francisco, 8/17 → still open 8/18: "yeap, not fixed
 * yet"):
 *
 *   "The Client Profile shows the corrected address. The Job Card still shows
 *    the incorrect/original address. Client-facing messages continue to use the
 *    incorrect address. The Job Card should stay synchronized with the Client
 *    Profile when the client's address is updated."
 *
 * A job carries its OWN address snapshot (jobs.address_street/city/state/zip)
 * and that snapshot WINS over the client record on every surface that matters —
 * the dispatch tile, the job card, the reminder texts, the confirmation email,
 * the completion PDF. That precedence is deliberate: it is how a one-off
 * service site works.
 *
 * The hole was that correcting the address ON THE CLIENT PROFILE did nothing to
 * those snapshots. Two ways to edit an address existed and only one of them
 * cascaded: PATCH /jobs/:id/address prompts the office and rewrites upcoming
 * jobs, while PUT /clients/:id — the profile drawer, which is where the office
 * actually goes to fix an address — wrote `clients.address` and stopped. So the
 * profile read correct, every card stayed wrong, and the wrong one is what went
 * out in the texts.
 *
 * WHAT THIS REWRITES, AND WHAT IT DELIBERATELY DOES NOT
 *
 * Only jobs whose snapshot is a verbatim MIRROR of the address the client had a
 * moment ago. Those are copies, not decisions — job-coords.ts measured it on
 * production: of the 783 residential jobs carrying a snapshot, 565 are just a
 * duplicate of their own client's address. A mirror has no information in it,
 * so moving it with the client loses nothing.
 *
 * A snapshot that DIFFERS from the old client address is a genuine one-off site
 * (a move-out at another house) and is left exactly alone. The office is told
 * how many of those it kept, and the job card's "Use client's" button is how
 * one gets moved deliberately.
 *
 * Scope is UPCOMING work only — scheduled/in_progress, dated today or later.
 * A finished visit records where the service actually happened; rewriting
 * history to match a later correction would be a lie about the past.
 *
 * Comparison matches PATCH /jobs/:id/address exactly, city and state included.
 * Street+zip alone is the [addr-city-state 2026-08-08] bug (Jess Wilhite,
 * CL-1520): a job differing only in city/state read as "same as the client" and
 * was skipped, so it kept Brownsburg, IN forever.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type ClientAddressParts = {
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

export type ClientAddressCascade = {
  /** Upcoming jobs whose mirrored snapshot was moved onto the new address. */
  jobs_synced: number;
  /** Upcoming jobs left on a genuinely different site, untouched. */
  jobs_kept_own: number;
};

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Did any of the four address components actually change? */
export function addressChanged(before: ClientAddressParts, after: ClientAddressParts): boolean {
  return norm(before.address) !== norm(after.address)
    || norm(before.city) !== norm(after.city)
    || norm(before.state) !== norm(after.state)
    || norm(before.zip) !== norm(after.zip);
}

export async function cascadeClientAddressToUpcomingJobs(opts: {
  companyId: number;
  clientId: number;
  before: ClientAddressParts;
  after: ClientAddressParts;
  /** Fresh geocode of the new address, when the caller has one. */
  coords?: { lat: string; lng: string } | null;
  /** Zone resolved from the new zip. `undefined` = leave zone_id alone. */
  zoneId?: number | null;
}): Promise<ClientAddressCascade> {
  const { companyId, clientId, before, after, coords, zoneId } = opts;

  // No previous address means nothing can be a mirror of it — every snapshot
  // out there was typed independently, so touching any of them would be a
  // guess. (Jobs with NO snapshot need nothing: they already inherit.)
  if (!norm(before.address)) return { jobs_synced: 0, jobs_kept_own: 0 };

  const oldAddr = before.address ?? "";
  const oldCity = before.city ?? "";
  const oldState = before.state ?? "";
  const oldZip = before.zip ?? "";

  // A job "mirrors" the old client address when all four components match,
  // compared case- and whitespace-insensitively.
  const mirrorsOld = sql`
    NULLIF(btrim(j.address_street), '') IS NOT NULL
    AND lower(btrim(coalesce(j.address_street, ''))) = lower(btrim(${oldAddr}))
    AND lower(btrim(coalesce(j.address_city,   ''))) = lower(btrim(${oldCity}))
    AND lower(btrim(coalesce(j.address_state,  ''))) = lower(btrim(${oldState}))
    AND lower(btrim(coalesce(j.address_zip,    ''))) = lower(btrim(${oldZip}))`;

  const upcoming = sql`
    j.company_id = ${companyId}
    AND j.client_id = ${clientId}
    AND j.scheduled_date >= CURRENT_DATE
    AND j.status IN ('scheduled', 'in_progress')`;

  // Count the one-off sites we are about to leave behind, before the rewrite
  // makes them indistinguishable from the jobs we moved.
  const keptRows = (await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM jobs j
     WHERE ${upcoming}
       AND NULLIF(btrim(j.address_street), '') IS NOT NULL
       AND NOT (${mirrorsOld})`) as any).rows;
  const jobs_kept_own = Number(keptRows[0]?.n ?? 0);

  // Re-stamp the geocode alongside the text. jobs.job_lat/job_lng is the
  // snapshot the mileage engine and the job card's Maps link read; leaving it
  // pointing at the old house while the text says the new one is the
  // [mileage-stale-address 2026-08-09] failure in miniature.
  const lat = coords?.lat ?? null;
  const lng = coords?.lng ?? null;

  const updated = (await db.execute(sql`
    UPDATE jobs j SET
      address_street = ${after.address ?? null},
      address_city   = ${after.city ?? null},
      address_state  = ${after.state ?? null},
      address_zip    = ${after.zip ?? null},
      address_lat    = COALESCE(${lat}::numeric, j.address_lat),
      address_lng    = COALESCE(${lng}::numeric, j.address_lng),
      job_lat        = COALESCE(${lat}::numeric, j.job_lat),
      job_lng        = COALESCE(${lng}::numeric, j.job_lng),
      address_verified = CASE WHEN ${lat}::numeric IS NOT NULL THEN true ELSE j.address_verified END,
      zone_id        = ${zoneId === undefined ? sql`j.zone_id` : sql`${zoneId}`}
    WHERE ${upcoming}
      AND ${mirrorsOld}
    RETURNING j.id`) as any).rows;

  return { jobs_synced: updated.length, jobs_kept_own };
}
