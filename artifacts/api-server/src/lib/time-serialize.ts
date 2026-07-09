/**
 * [timestamp-serialize 2026-07-08] Single source of truth for handing a
 * zone-less DB timestamp to the frontend.
 *
 * Many audit/log tables store `timestamp` WITHOUT a timezone (UTC wall-clock).
 * The pg driver returns those as a bare string ("2026-07-07 12:08:34", no `Z`),
 * and the browser's `new Date(str)` parses a bare string as LOCAL time — so on a
 * Central client every such timestamp shifts +5/+6h (Sal: "cancelled at 6:10 PM
 * shows as 12:10 AM"). Re-stamp it as explicit UTC before it crosses the API so
 * the client parses it correctly, then renders it in the tenant's zone.
 *
 * This replaces three hand-rolled copies (routes/clients.ts, routes/accounts.ts,
 * routes/leave.ts). Any endpoint that returns a zone-less audit/log timestamp
 * MUST pass it through utcIso() — that's how the "wrong hour" class of bug stays
 * fixed instead of recurring one screen at a time.
 *
 * Idempotent: a value that already carries a zone (`...Z` or `+/-HH:MM`) or a
 * real Date is normalized straight through, so double-wrapping is harmless.
 */
export function utcIso(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return /Z$|[+-]\d{2}:?\d{2}$/.test(s)
    ? new Date(s).toISOString()
    : new Date(s.replace(" ", "T") + "Z").toISOString();
}
