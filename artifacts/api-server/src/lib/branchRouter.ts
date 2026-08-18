import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

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
export async function resolveBranchByZip(zip: string): Promise<string> {
  const clean = (zip ?? "").toString().trim().replace(/\D/g, "").slice(0, 5);
  if (clean.length !== 5) return "oak_lawn";
  try {
    const rows = await db.execute(sql`
      SELECT location FROM service_zones
      WHERE is_active = true AND zip_codes @> ARRAY[${clean}]::text[]
      LIMIT 1
    `);
    const loc = ((rows as any).rows ?? rows)[0]?.location;
    if (loc === "schaumburg" || loc === "oak_lawn") return loc;
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
