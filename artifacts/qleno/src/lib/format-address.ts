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

  const parts: string[] = [];
  if (street_) parts.push(street_);
  if (city_) parts.push(city_);
  // state + zip share a slot joined by a single space; either alone
  // takes the slot.
  const stateZip = [state_, zip_].filter(Boolean).join(" ");
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
