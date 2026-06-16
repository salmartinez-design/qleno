/**
 * [onboarding-password 2026-06-16] Narrow, one-time login bootstrap for a
 * specific stuck new hire during the comms-off cutover.
 *
 * NOT a mass reset. It only touches an explicit allowlist of user ids
 * (default: the one new hire who can't log in, Maryury = 817), and only when:
 *   - COMMS_ENABLED !== 'true' (the window the temp-password email can't send),
 *   - the account is_active, and
 *   - last_login_at IS NULL (never logged in) — so the instant they log in it
 *     stops touching them and can never clobber a real, active password.
 *
 * Override the target set with ONBOARDING_RESET_USER_IDS (comma-separated) and
 * the password with DEFAULT_ONBOARDING_PASSWORD. Remove this step after the
 * cutover once everyone has logged in.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

export async function bootstrapOnboardingPasswords(): Promise<number> {
  if (process.env.COMMS_ENABLED === "true") return 0;
  const ids = (process.env.ONBOARDING_RESET_USER_IDS || "817")
    .split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n));
  if (ids.length === 0) return 0;
  const pw = process.env.DEFAULT_ONBOARDING_PASSWORD || "chicago23";
  const hash = await bcrypt.hash(pw, 10);
  const csv = ids.join(",");
  const r = await db.execute(sql`
    UPDATE users
       SET password_hash = ${hash}
     WHERE id = ANY(ARRAY[${sql.raw(csv)}]::int[])
       AND is_active = true
       AND last_login_at IS NULL
  `);
  return (r as any).rowCount ?? 0;
}
