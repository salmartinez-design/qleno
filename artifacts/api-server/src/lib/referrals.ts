import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [referral-program] Give $25 / Get $25. The referrals table predates this
// feature (client-profile manual referrals: referred_name/phone/email, status,
// reward_issued) — production may or may not have it, so both the CREATE and
// every new column are idempotent. New columns wire the customer-facing flow:
// the widget form captures the referrer even when they aren't a client yet
// (referrer_name/email/phone), lead_id links the referred person's Lead
// Pipeline row (which is what lets the report derive booked/completed without
// anyone updating a spreadsheet), and credited_at stamps when the office gave
// the referrer their $25.
export const REFERRAL_PROMO = "$25 off first clean / $25 credit to referrer";

export async function ensureReferralSetup(): Promise<void> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS referrals (
        id                 SERIAL PRIMARY KEY,
        company_id         INTEGER NOT NULL,
        referrer_client_id INTEGER,
        referred_name      TEXT,
        referred_phone     TEXT,
        referred_email     TEXT,
        notes              TEXT,
        source             TEXT,
        status             TEXT NOT NULL DEFAULT 'pending',
        reward_issued      BOOLEAN NOT NULL DEFAULT FALSE,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const newColumns = [
      "referral_type TEXT NOT NULL DEFAULT 'residential'",
      "referrer_name TEXT",
      "referrer_email TEXT",
      "referrer_phone TEXT",
      "lead_id INTEGER",
      "promo TEXT",
      "credited_at TIMESTAMPTZ",
    ];
    for (const col of newColumns) {
      await db.execute(sql.raw(`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS ${col}`));
    }
    await db.execute(sql`CREATE INDEX IF NOT EXISTS referrals_company_created_idx ON referrals (company_id, created_at)`);
    console.log("[referrals] setup ready (table + program columns)");
  } catch (err) {
    console.error("[referrals] setup error (non-fatal):", err);
  }
}
