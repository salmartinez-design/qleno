/**
 * [company-timezone 2026-08-15] The tenant's time zone, for the browser.
 *
 * Maribel: "dates should follow the company's local time, not just Chicago."
 * `America/Chicago` was a literal in eighteen places across the app — every
 * `toLocaleString({ timeZone: "America/Chicago" })`, every "today" helper. For
 * Phes (Illinois) that was right by accident; for any tenant Qleno sells to
 * outside Central it silently mislabels timestamps and, worse, rolls "today"
 * over at the wrong hour.
 *
 * This is a module-level value rather than a hook because almost every call
 * site is a plain formatter defined outside a component — `fmtWhen`, `t12`,
 * `todayStr` — with nowhere to consume React context. `useTenantBrand()` already
 * fetches `/api/companies/me` once at app boot for the brand color; it now hands
 * the tenant's `timezone` here on the same resolve.
 *
 * The default is Central, so every render before that fetch resolves — and any
 * tenant whose row has no zone — behaves exactly as it did before. Nothing can
 * regress; the worst case is the old behavior.
 */
export const DEFAULT_TZ = "America/Chicago";

let current = DEFAULT_TZ;

/** True when `tz` is an IANA zone this browser's Intl actually knows. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Set the active zone. Ignores anything Intl won't accept — a bad value in the
 * DB should fall back to Central, not throw inside a render and blank the page.
 */
export function setCompanyTimeZone(tz: unknown): void {
  current = isValidTimeZone(tz) ? tz : DEFAULT_TZ;
}

/** The tenant's zone. Safe to call before the company fetch resolves. */
export function companyTz(): string {
  return current;
}

/**
 * Today's calendar date in the tenant's zone, as `YYYY-MM-DD`.
 *
 * `new Date().toISOString().slice(0,10)` is the wrong tool here: it yields the
 * UTC date, which flips at 7 PM Central — a board opened in the evening would
 * quietly start showing tomorrow.
 */
export function todayInCompanyTz(at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return at.toLocaleDateString("en-CA", { timeZone: current });
}
