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
 * Default temp password for the LMS Add Employee flow.
 *
 * Onboarding-readiness sprint 2026-05-15: Sal explicitly asked for
 * literal `chicago23` (lowercase) on the new-hire path for the two
 * techs starting 2026-05-15. Outbound notifications are globally
 * paused; credentials are hand-delivered. Sal will rotate every new
 * account immediately post-go-live.
 *
 * Note: the prior implementation generated a per-call `Phes+6char`
 * value via a no-confusing-chars alphabet. That helper is retained
 * below for any future surface that wants the random fallback (and
 * for the bulk-reset dialog, which keeps its own copy).
 */
export const LMS_DEFAULT_TEMP_PASSWORD = "chicago23";

export function generateLmsTempPassword(): string {
  return LMS_DEFAULT_TEMP_PASSWORD;
}

/**
 * Random-suffix helper kept for callers that don't want the literal.
 * Currently unused on the Add Employee path (see Sal's pre-onboarding
 * directive above). Alphabet excludes `0/1/I/l/O/o` to reduce
 * dictation errors when the office team reads the password.
 */
export function generateRandomLmsTempPassword(): string {
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
