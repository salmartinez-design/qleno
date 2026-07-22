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
