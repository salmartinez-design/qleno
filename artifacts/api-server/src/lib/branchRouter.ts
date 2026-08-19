import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { geocodeAddress } from "./geocode.js";
import { haversineMeters } from "./distance.js";

export interface BranchConfig {
  branch: string;
  officeEmail: string;
  fromName: string;
  clientPhone: string;
  clientPhoneFormatted: string;
  twilioFrom: string;
}

const SCHAUMBURG_ZIPS = new Set([
  // Schaumburg / Palatine / Arlington Heights
  "60159","60168","60169","60173","60193","60194","60195","60196",
  "60004","60005","60006","60008","60038","60055","60056","60067",
  "60074","60078","60094","60095",
  // Elk Grove / Des Plaines / Buffalo Grove
  "60009","60017","60019","60089","60090","60007",
  // Barrington / Streamwood / Elgin
  "60010","60011","60107","60120","60172","60179","60192","60201",
]);

export function getBranchByZip(zip: string): BranchConfig {
  const isSchaumburg = SCHAUMBURG_ZIPS.has(zip?.toString().trim());
  if (isSchaumburg) {
    return {
      branch: "schaumburg",
      officeEmail: "schaumburg@phes.io",
      fromName: "Phes",
      clientPhone: "847-538-3729",
      clientPhoneFormatted: "(847) 538-3729",
      twilioFrom: "+16308844318",
    };
  }
  return {
    branch: "oak_lawn",
    officeEmail: "info@phes.io",
    fromName: "Phes",
    clientPhone: "773-706-6000",
    clientPhoneFormatted: "(773) 706-6000",
    twilioFrom: "+17737869902",
  };
}

/**
 * Resolve a branch identifier ("schaumburg" / "oak_lawn") to the canonical
 * tenant id. Used by the inbound booking router to decide which tenant a
 * new customer/job should be created under.
 *
 * Restored after the Model A push briefly removed it — the partnership
 * split between Sal (Phes Oak Lawn) and Sal+Ivan (PHES Schaumburg) means
 * these are SEPARATE businesses, not branches of one company. ZIP-driven
 * tenant routing is the load-bearing piece that makes the inbound flow
 * land work in the right entity's books.
 */
export async function getCompanyIdByBranch(branch: string): Promise<number | null> {
  try {
    let rows: any;
    if (branch === "schaumburg") {
      rows = await db.execute(sql`SELECT id FROM companies WHERE name ILIKE '%schaumburg%' LIMIT 1`);
    } else {
      rows = await db.execute(sql`SELECT id FROM companies WHERE name ILIKE '%oak lawn%' OR name ILIKE '%phes%' ORDER BY id ASC LIMIT 1`);
    }
    const result = (rows as any).rows ?? rows;
    return result[0]?.id ?? null;
  } catch (err) {
    console.error("[branchRouter] getCompanyIdByBranch error:", err);
    return null;
  }
}

/**
 * [square-per-branch 2026-08-18] Resolve which BRANCH a zip belongs to, DB-first.
 *
 * There are two zip lists in this system and they can drift: the hardcoded
 * SCHAUMBURG_ZIPS above (which drives comms) and `service_zones.zip_codes` +
 * `.location` (which the booking widget already shows the customer). Sal edits
 * the zones, not this file, so the DB wins and the hardcoded set is only the
 * fallback for a zip no zone covers.
 *
 * Returns the branch name only — mapping it to a tenant is getCompanyIdByBranch.
 */
// ── Nearest-home-base tie-break ────────────────────────────────────────────
//
// [zip-overlap 2026-08-18] A zip can legitimately end up in BOTH branches' zone
// lists — the two service areas are drawn by hand and they will drift as zips
// are added. When that happens the zone table alone cannot say who owns the
// booking, and the previous `LIMIT 1` answered with whatever row Postgres
// happened to return first: the same zip could route to a different branch on
// two consecutive bookings.
//
// Sal's rule is logistical, so the tie-break is too: a contested zip goes to the
// branch whose home base is physically closest. Straight-line distance is the
// right measure here — it is stable, needs no driving-route call on the booking
// path, and the two bases are ~30 miles apart, so a road-vs-crow difference
// cannot flip the answer.
//
// The base addresses are READ FROM `companies`, never hardcoded, so correcting a
// branch's address in settings re-aims the routing with it.
const baseCoordCache = new Map<string, { lat: number; lng: number } | null>();
const zipCoordCache = new Map<string, { lat: number; lng: number } | null>();

async function coordsFor(key: string, address: string, cache: Map<string, { lat: number; lng: number } | null>) {
  if (cache.has(key)) return cache.get(key)!;
  let coords: { lat: number; lng: number } | null = null;
  try {
    coords = await geocodeAddress(address);
  } catch (err) {
    console.error(`[branchRouter] geocode failed for ${address}:`, err);
  }
  cache.set(key, coords);
  return coords;
}

async function nearestBranchByHomeBase(zip: string, branches: string[]): Promise<string | null> {
  const zipCoords = await coordsFor(zip, `${zip}, IL, USA`, zipCoordCache);
  if (!zipCoords) return null;

  let best: { branch: string; meters: number } | null = null;
  for (const branch of branches) {
    const companyId = await getCompanyIdByBranch(branch);
    if (companyId == null) continue;
    const rows = await db.execute(sql`
      SELECT address, city, state, zip FROM companies WHERE id = ${companyId} LIMIT 1
    `);
    const row = ((rows as any).rows ?? rows)[0];
    const full = [row?.address, row?.city, row?.state, row?.zip].filter(Boolean).join(", ");
    if (!full) continue;
    const baseCoords = await coordsFor(`company:${companyId}`, full, baseCoordCache);
    if (!baseCoords) continue;
    const meters = haversineMeters(zipCoords.lat, zipCoords.lng, baseCoords.lat, baseCoords.lng);
    if (!best || meters < best.meters) best = { branch, meters };
  }
  return best?.branch ?? null;
}

export async function resolveBranchByZip(zip: string): Promise<string> {
  const clean = (zip ?? "").toString().trim().replace(/\D/g, "").slice(0, 5);
  if (clean.length !== 5) return "oak_lawn";
  try {
    // Every matching location, not the first one — a contested zip has to be
    // SEEN as contested before it can be resolved on purpose.
    const rows = await db.execute(sql`
      SELECT DISTINCT location FROM service_zones
      WHERE is_active = true
        AND zip_codes @> ARRAY[${clean}]::text[]
        AND location IN ('oak_lawn', 'schaumburg')
    `);
    const locs = (((rows as any).rows ?? rows) as Array<{ location: string }>)
      .map(r => r.location)
      .filter(l => l === "oak_lawn" || l === "schaumburg");

    if (locs.length === 1) return locs[0];
    if (locs.length > 1) {
      const nearest = await nearestBranchByHomeBase(clean, locs);
      if (nearest) {
        console.warn(
          `[branchRouter] zip ${clean} is claimed by ${locs.join(" + ")} — ` +
          `routed to '${nearest}' (closest home base).`,
        );
        return nearest;
      }
      // Geocoding is the only thing that can fail here, and a booking must never
      // hang on it. Sorting makes the fallback deterministic rather than
      // whatever the query happened to return first.
      const stable = [...locs].sort()[0];
      console.warn(
        `[branchRouter] zip ${clean} is claimed by ${locs.join(" + ")} but the ` +
        `home-base distances could not be resolved — routed to '${stable}'.`,
      );
      return stable;
    }
  } catch (err) {
    console.error("[branchRouter] resolveBranchByZip lookup failed:", err);
  }
  return getBranchByZip(clean).branch;
}

/**
 * Resolve the TENANT a booking for this zip belongs to.
 *
 * Oak Lawn and Schaumburg are separate businesses, so a Schaumburg zip must
 * create its customer and job under the Schaumburg company — and, because
 * Square credentials hang off the company, capture the card on the Schaumburg
 * merchant.
 *
 * `fallbackCompanyId` is the company the booking widget was loaded under. It is
 * used when the branch has no tenant yet (the Schaumburg company row not created
 * so far), which keeps bookings working exactly as they do today instead of
 * failing. That fallback is logged, because silently booking Schaumburg work
 * into Oak Lawn's books is the thing this function exists to stop.
 */
export async function resolveBookingTenant(
  zip: string,
  fallbackCompanyId: number,
): Promise<{ branch: string; companyId: number; usedFallback: boolean; reason?: string }> {
  const branch = await resolveBranchByZip(zip);
  const companyId = await getCompanyIdByBranch(branch);
  if (companyId == null) {
    return fallback(branch, fallbackCompanyId, zip, "no company matches this branch");
  }
  if (companyId === fallbackCompanyId) {
    return { branch, companyId, usedFallback: false };
  }

  // ── The readiness gate ───────────────────────────────────────────────────
  //
  // A tenant ROW existing is not the same as a tenant being able to take a
  // booking. Phes Schaumburg (company 4) has existed for months with zero jobs,
  // zero clients and no pricing — its work still lives in MaidCentral. Routing a
  // booking into it because the row exists would produce a job with no price and
  // a card saved on a merchant that tenant cannot charge.
  //
  // Worse, routing must be ALL-OR-NOTHING. The card is tokenized against the
  // merchant chosen at /book/setup and then saved by /book/confirm; if those two
  // resolve to different companies, the save is attempted with the wrong
  // merchant's access token and every booking in that branch fails. So both
  // endpoints call this same function, and it only hands over the branch tenant
  // once that tenant can actually complete the whole flow:
  //
  //   1. square_account_key set — the explicit "this branch has its own
  //      merchant" switch. Without it the tenant would resolve to the DEFAULT
  //      credentials, i.e. the other branch's Square account, which is the exact
  //      outcome this whole change exists to prevent.
  //   2. at least one active pricing scope — otherwise there is nothing to price
  //      the booking against.
  //
  // Until both are true the booking stays on the widget's company and behaves
  // exactly as it does today. Flipping them on is what turns this live.
  try {
    const rows = await db.execute(sql`
      SELECT
        NULLIF(TRIM(COALESCE(c.square_account_key, '')), '') AS account_key,
        (SELECT COUNT(*) FROM pricing_scopes ps
          WHERE ps.company_id = c.id AND COALESCE(ps.is_active, true) = true) AS scope_count
      FROM companies c WHERE c.id = ${companyId} LIMIT 1
    `);
    const row = ((rows as any).rows ?? rows)[0];
    if (!row?.account_key) {
      return fallback(branch, fallbackCompanyId, zip, `company ${companyId} has no square_account_key`);
    }
    if (Number(row.scope_count ?? 0) === 0) {
      return fallback(branch, fallbackCompanyId, zip, `company ${companyId} has no active pricing scopes`);
    }
  } catch (err) {
    console.error("[branchRouter] readiness check failed:", err);
    return fallback(branch, fallbackCompanyId, zip, "readiness check errored");
  }

  return { branch, companyId, usedFallback: false };
}

function fallback(branch: string, fallbackCompanyId: number, zip: string, reason: string) {
  console.warn(
    `[branchRouter] zip ${zip} routes to branch '${branch}' but ${reason} — ` +
    `booking stays on company ${fallbackCompanyId}.`,
  );
  return { branch, companyId: fallbackCompanyId, usedFallback: true, reason };
}
