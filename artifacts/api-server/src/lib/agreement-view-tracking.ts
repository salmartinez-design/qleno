// [agreement-multi-view 2026-07-22] Columns behind repeat-view tracking on
// e-signable agreements.
//
// form_submissions.viewed_at already existed but was written once (first open
// only), so "they've opened it four times and still haven't signed" was
// invisible to the office. These two columns carry the rest:
//
//   last_viewed_at — most recent open
//   view_count     — total opens
//
// Every open is also appended to agreement_events, which is what the
// Certificate of Completion prints, so the legal record shows each view with
// its timestamp, IP and user agent (DocuSign parity).
//
// Idempotent — safe on every cold start.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [agreement-late-fee 2026-07-22] Free-text late-payment terms used by the
// {{late_fee}} merge variable. Contract wording only — nothing is charged
// automatically off this value.
export async function ensureLateFeeTermsColumn(): Promise<void> {
  await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS late_fee_terms text`);
}

// [agreement-clauses 2026-07-22] Tunable numbers behind the service-agreement
// merge variables (termination/rate notice, damage reporting window and cap,
// non-solicit period and placement fee). Defaults are Sal's approved values.
// Contract WORDING only — nothing here is enforced or billed by Qleno.
export async function ensureAgreementClauseColumns(): Promise<void> {
  await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS agr_termination_notice_days integer NOT NULL DEFAULT 30`);
  await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS agr_rate_notice_days integer NOT NULL DEFAULT 30`);
  await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS agr_damage_report_days integer NOT NULL DEFAULT 5`);
  await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS agr_damage_cap numeric(12,2) NOT NULL DEFAULT 500.00`);
  await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS agr_nonsolicit_months integer NOT NULL DEFAULT 12`);
  await db.execute(sql`ALTER TABLE companies ADD COLUMN IF NOT EXISTS agr_nonsolicit_fee numeric(12,2) NOT NULL DEFAULT 2500.00`);
}

export async function ensureAgreementViewColumns(): Promise<void> {
  await db.execute(sql`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS last_viewed_at timestamp`);
  await db.execute(sql`ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0`);
  // Backfill: an agreement that was already opened under the old single-event
  // logic has viewed_at set but a zero count. Seed those to 1 so the number
  // never contradicts the timestamp sitting next to it.
  await db.execute(sql`
    UPDATE form_submissions
       SET view_count = 1, last_viewed_at = COALESCE(last_viewed_at, viewed_at)
     WHERE viewed_at IS NOT NULL AND COALESCE(view_count, 0) = 0`);
}
