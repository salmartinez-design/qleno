/**
 * [AI.7.6] Canonical address formatter — single source of truth for
 * how an address renders across Qleno. The format is
 *   "<street>, <city>, <state> <zip>"
 * with comma+space separators between street/city/state-zip and a
 * single space between state and zip. State should be the 2-letter
 * postal code (server-side data normalization).
 *
 * Sal's rule: "If address is shown, zip MUST be shown."
 * → Any surface that renders an address MUST route through this
 *   helper. Do NOT inline `${address}, ${city}` concatenations
 *   anywhere — they always end up dropping zip.
 *
 * Behavior on missing pieces:
 *   - All-null/empty → returns "" (caller decides whether to render
 *     a placeholder; never renders a partial address that hides the
 *     missing-data signal)
 *   - Missing only zip → "<street>, <city>, <state>" (state without
 *     zip is unusual; included so we render *something* but the
 *     missing zip is operationally a data error elsewhere)
 *   - Missing only state → "<street>, <city> <zip>" (city + zip is
 *     enough to disambiguate)
 *   - Missing city + state → "<street> <zip>"
 *   - Missing street → render whatever we have, joined the same way.
 *
 * The output never has trailing/leading whitespace or stray commas.
 */
export function formatAddress(
  street?: string | null,
  city?: string | null,
  state?: string | null,
  zip?: string | null,
): string {
  const s = (v: unknown) => (v == null ? "" : String(v).trim());
  const street_ = s(street);
  const city_ = s(city);
  const state_ = s(state);
  const zip_ = s(zip);

  // [dup-components 2026-08-18] `clients.address` does not always hold a bare
  // street. Plenty of rows hold a fully formatted address — Cynthiia Lopezz
  // (CL-1533) is stored as "17878 Argos Court, Tinley Park, IL 60477" with the
  // city and state columns empty — because the booking widget, imports and the
  // office quote form have all written the whole line into that one field over
  // the years.
  //
  // Appending city/state/zip to a street that already contains them is how job
  // 15243 shipped to production reading
  //   "2333 North Janssen Avenue, Chicago, IL 60614, IL 60614".
  //
  // So a component is skipped when the text so far already contains it. This
  // never suppresses real information: it only declines to say the same thing
  // twice. `appendZipIfMissing` below has always worked this way; the rule
  // simply belongs here too.
  // Whole-word match, NOT substring. "IL" appears inside "Willowcreek" and
  // "Clarendon Hills"; a plain includes() would decide the state was already
  // present and drop it from every address in Clarendon Hills.
  const already = (haystack: string, needle: string) => {
    if (!haystack || !needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
  };

  const parts: string[] = [];
  if (street_) parts.push(street_);
  if (city_ && !already(street_, city_)) parts.push(city_);

  // state + zip share a slot joined by a single space; either alone
  // takes the slot. Each is dropped independently when the line already
  // carries it, so a street ending "…, IL 60614" plus state "IL" and zip
  // "60614" adds nothing rather than doubling both.
  const soFar = parts.join(", ");
  const stateZip = [
    state_ && !already(soFar, state_) ? state_ : "",
    zip_ && !already(soFar, zip_) ? zip_ : "",
  ].filter(Boolean).join(" ");
  if (stateZip) parts.push(stateZip);
  return parts.join(", ");
}

/**
 * Convenience for the common pattern where the caller has a single
 * `address` string (already formatted with city) and a separate `zip`
 * — used by surfaces that received the legacy "<street>, <city>"
 * concat from the server. Renders "<address> <zip>" only if zip is
 * non-empty AND not already present in the address string.
 *
 * Prefer `formatAddress()` whenever the four fields are available
 * separately. This helper exists only as a temporary bridge for
 * surfaces still consuming the combined string.
 */
export function appendZipIfMissing(addressLine: string | null | undefined, zip?: string | null): string {
  const a = (addressLine ?? "").trim();
  const z = (zip ?? "").trim();
  if (!a) return z;
  if (!z) return a;
  if (a.includes(z)) return a;
  return `${a} ${z}`;
}

/**
 * Google Maps turn-by-turn NAVIGATION url for an address. Uses the directions
 * endpoint (`dir/?api=1&destination=…`) so tapping it launches the Google Maps
 * app in navigation mode on mobile (and maps.google.com on desktop) — not just
 * a dropped pin. Single source of truth so "tap the address to navigate"
 * behaves identically on the dispatch panel and the tech My Day / My Jobs views.
 * Returns null for an empty address so callers can skip the link.
 */
export function mapsDirectionsUrl(address: string | null | undefined): string | null {
  const a = (address ?? "").trim();
  if (!a) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(a)}`;
}
