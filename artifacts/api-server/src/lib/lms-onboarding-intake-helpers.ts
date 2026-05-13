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
