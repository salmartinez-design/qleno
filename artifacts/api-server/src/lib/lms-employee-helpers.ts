/**
 * Pure helpers for the LMS Add/Edit Employee endpoints
 * (sprint 2026-05-15). Kept here (rather than inline in
 * routes/users.ts) so the validation rules are unit-testable
 * without booting the express app or hitting the database.
 *
 * Tenant isolation is enforced at the SQL layer in the routes
 * themselves (every INSERT / UPDATE / SELECT carries
 * `eq(usersTable.company_id, req.auth.companyId)`). These helpers
 * cover the input-validation half of that contract.
 */

/**
 * Generate a per-call temp password matching the Phes+6char
 * pattern used by the existing bulk-reset dialog. The alphabet
 * intentionally excludes characters that look alike at small
 * font sizes (`I`, `O`, `l`, `o`, `0`, `1`) to reduce dictation
 * errors when the office team reads the password to a new hire
 * over the phone.
 */
export function generateLmsTempPassword(): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return `Phes${suffix}`;
}

export function isValidEmail(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (s.length < 3 || s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function isValidIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Whitelists used by the routes. Kept here as exported sets so a
 * unit test can guard against an accidental "office" appearing in
 * the add-allowed set (which would let an office user be created
 * without an explicit owner action somewhere else in the system).
 */
export const LMS_ADD_ALLOWED_ROLES: ReadonlySet<string> = new Set([
  "technician",
  "team_lead",
  "admin",
]);

export const LMS_EDIT_ALLOWED_ROLES: ReadonlySet<string> = new Set([
  "technician",
  "team_lead",
  "admin",
  "office",
]);
