/**
 * [onboarding-password 2026-06-16] Narrow, one-time login bootstrap for a
 * specific stuck new hire during the comms-off cutover.
 *
 * NOT a mass reset. It only touches an explicit allowlist of EMAILS and/or
 * user ids (default: the one new hire who can't log in, Maryury =
 * marjuryj@gmail.com / id 817), and only when:
 *   - COMMS_ENABLED !== 'true' (the window the temp-password email can't send),
 *   - the account is_active, and
 *   - last_login_at IS NULL (never logged in) — so the instant they log in it
 *     stops touching them and can never clobber a real, active password.
 *
 * Why email-anchored: login looks the user up by `email` (lowercasing the
 * INPUT but comparing against the stored value as-is). A hand-entered/imported
 * account whose stored email has stray casing or whitespace can never be found,
 * so no password works. We therefore (a) match on the normalized email — the
 * identifier the person actually types, so it's certain — and (b) normalize the
 * stored email in the same UPDATE so the login lookup can find them. Matching
 * on email also removes any dependency on a guessed user id.
 *
 * Override the target set with ONBOARDING_RESET_EMAILS / ONBOARDING_RESET_USER_IDS
 * (comma-separated) and the password with DEFAULT_ONBOARDING_PASSWORD. Remove
 * this step after the cutover once everyone has logged in.
 */
import { db } from "@workspace/db";
import { sql, SQL } from "drizzle-orm";
import bcrypt from "bcryptjs";

export async function bootstrapOnboardingPasswords(): Promise<number> {
  if (process.env.COMMS_ENABLED === "true") return 0;

  const ids = (process.env.ONBOARDING_RESET_USER_IDS || "817")
    .split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n));
  const emails = (process.env.ONBOARDING_RESET_EMAILS || "marjuryj@gmail.com")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

  if (ids.length === 0 && emails.length === 0) return 0;

  const pw = process.env.DEFAULT_ONBOARDING_PASSWORD || "chicago23";
  const hash = await bcrypt.hash(pw, 10);

  // Match predicate: id in the integer allowlist OR normalized stored email in
  // the email allowlist. Emails are bound as individual parameters (the proven
  // safe drizzle pattern — array binding via ANY(${jsArray}) silently fails in
  // raw db.execute); ids go through the integer-validated CSV + sql.raw pattern.
  const conditions: SQL[] = [];
  if (ids.length) {
    conditions.push(sql`id = ANY(ARRAY[${sql.raw(ids.join(","))}]::int[])`);
  }
  if (emails.length) {
    conditions.push(sql`lower(btrim(email)) IN (${sql.join(emails.map(e => sql`${e}`), sql`, `)})`);
  }
  const match = sql.join(conditions, sql` OR `);

  const r = await db.execute(sql`
    UPDATE users
       SET password_hash = ${hash},
           email = lower(btrim(email))
     WHERE (${match})
       AND is_active = true
       AND last_login_at IS NULL
  `);
  return (r as any).rowCount ?? 0;
}
