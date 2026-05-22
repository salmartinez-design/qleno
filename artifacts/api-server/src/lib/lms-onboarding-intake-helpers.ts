/**
 * Pure helpers for the onboarding-intake routes.
 *
 * Extracted so they can be unit-tested without spinning up Postgres.
 * The routes (`routes/lms-onboarding-intake.ts`) import these and
 * apply them to incoming request bodies and outgoing CSV rows.
 */

/**
 * Trim a value and return null when empty / non-string. Used to
 * normalise optional text fields — the route writes null to the DB
 * rather than empty strings so downstream consumers (CSV export,
 * frontend display) can distinguish "unanswered" from "answered
 * blank".
 */
export function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/**
 * Coerce to boolean with an explicit fallback. Defends against the
 * frontend sending undefined / string / number where a boolean is
 * expected, which would otherwise become `true` under naive truthy
 * coercion.
 */
export function boolOr(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  return fallback;
}

/**
 * Accept a `YYYY-MM-DD` string and return it, or null otherwise.
 * Defends against accidental `Date.toString()` submissions which
 * would otherwise be inserted as gibberish into a DATE column. Also
 * returns null for empty strings so the frontend can send "" to
 * mean "clear".
 */
export function dateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

/**
 * The three required emergency-contact fields. If all three are
 * populated, the intake counts as "submitted" and `submitted_at` is
 * stamped on the row. Mirrored from
 * `@workspace/db/schema/lms-onboarding-intake.ts` to keep this lib
 * decoupled from drizzle / the DB schema package.
 */
export const INTAKE_REQUIRED_FIELDS = [
  "emergency_contact_name",
  "emergency_contact_relationship",
  "emergency_contact_phone",
] as const;

export type IntakeRequiredField = (typeof INTAKE_REQUIRED_FIELDS)[number];

/**
 * Returns true iff every required field is a non-empty string after
 * trimming. Drives the `submitted_at` stamp in POST /save.
 */
export function isIntakeSubmittable(
  row: Partial<Record<IntakeRequiredField, string | null>>,
): boolean {
  return INTAKE_REQUIRED_FIELDS.every((f) => {
    const v = row[f];
    return typeof v === "string" && v.trim().length > 0;
  });
}

/**
 * CSV-escape a single cell. Returns "" for null / undefined, wraps
 * in double quotes when the cell contains a comma, double-quote, or
 * newline, and escapes embedded double-quotes by doubling them
 * (RFC 4180).
 */
export function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validators for the vehicle-and-address PR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * US ZIP code: 5 digits or 5+4 with hyphen. Returns the normalized
 * value or null. Accepts surrounding whitespace.
 */
export function zipOrNull(v: unknown): string | null {
  const s = trimOrNull(v);
  if (s == null) return null;
  return /^\d{5}(-\d{4})?$/.test(s) ? s : null;
}

/**
 * Two-letter US state abbreviation (uppercased). Returns null for
 * anything that isn't one of the 50 states, DC, or a US territory
 * code commonly used on driver's licenses.
 */
const US_STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV",
  "NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN",
  "TX","UT","VT","VA","WA","WV","WI","WY","DC","PR","GU","VI","AS","MP",
]);

export function stateOrNull(v: unknown): string | null {
  const s = trimOrNull(v);
  if (s == null) return null;
  const upper = s.toUpperCase();
  return US_STATE_CODES.has(upper) ? upper : null;
}

/**
 * Vehicle year: integer between 1980 and (current year + 2). Returns
 * null when the input is not a finite integer in range.
 */
export function vehicleYearOrNull(
  v: unknown,
  nowYear: number = new Date().getFullYear(),
): number | null {
  let n: number | null = null;
  if (typeof v === "number" && Number.isInteger(v)) n = v;
  else if (typeof v === "string" && /^\d{4}$/.test(v.trim())) {
    n = Number.parseInt(v.trim(), 10);
  }
  if (n == null) return null;
  if (n < 1980 || n > nowYear + 2) return null;
  return n;
}

/**
 * License plate: alphanumeric, 2 to 8 characters after trimming +
 * stripping interior whitespace and hyphens (real plates often
 * include them). Returns the normalized (uppercased, stripped) plate
 * or null.
 */
export function licensePlateOrNull(v: unknown): string | null {
  const s = trimOrNull(v);
  if (s == null) return null;
  const stripped = s.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(stripped) ? stripped : null;
}

/**
 * Alphanumeric identifier 5 to 30 chars after trimming. Used for
 * both insurance policy numbers and driver's license numbers. Accepts
 * embedded hyphens and spaces (common on policies); strips them when
 * validating but preserves them in the returned string.
 */
export function alphanumIdOrNull(v: unknown): string | null {
  const s = trimOrNull(v);
  if (s == null) return null;
  const stripped = s.replace(/[\s-]/g, "");
  return /^[A-Za-z0-9]{5,30}$/.test(stripped) ? s : null;
}

/**
 * Future-date YYYY-MM-DD check. Returns the date string when it
 * parses to a valid future date, otherwise null. Used for insurance
 * + driver's license expiration validation.
 */
export function futureDateOrNull(
  v: unknown,
  now: Date = new Date(),
): string | null {
  const s = dateOrNull(v);
  if (s == null) return null;
  // Parse as UTC noon to avoid timezone-edge-of-day flakiness when
  // comparing against `now`.
  const parsed = new Date(`${s}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getTime() > now.getTime() ? s : null;
}
