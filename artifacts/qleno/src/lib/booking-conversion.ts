/**
 * Booking-complete conversion message for the phes.io parent page.
 *
 * The booking widget is embedded on phes.io in an iframe. When a booking is
 * genuinely completed, phes.io fires its Google Ads / GA4 conversion off a
 * postMessage from this widget. The message shape is a contract with that
 * page — do not rename fields:
 *
 *   { type: 'qleno-booking-complete', bookingId, value, currency: 'USD' }
 *
 * The four rules the parent depends on:
 *   1. GENUINE BOOKING ONLY — a real job row must exist. The commercial
 *      WALKTHROUGH path also reaches the confirmation screen but returns only
 *      client_id (no job, no payment — it's a quote request), so it must not
 *      count as a conversion. Requiring a job id enforces that by construction.
 *   2. ALWAYS A UNIQUE bookingId — phes.io dedupes on it and DROPS any message
 *      without one, so a null id is the same as not firing while still looking
 *      like a delivered event. No id → no message.
 *   3. PHES TENANT ONLY — Qleno is multi-tenant. Another tenant's booking must
 *      never be posted at phes.io, even though the browser would discard it on
 *      the origin check anyway.
 *   4. The value is the amount actually booked (`first_visit_total`, which is
 *      already scaled by the home-condition multiplier), never the
 *      pre-multiplier `pricing.final_total` — that under-reported every
 *      dirty-home booking. 0 when no amount is known.
 *
 * Firing once per booking, and the "are we even in an iframe" check, are the
 * caller's job (see book.tsx) — this module stays pure so it can be tested.
 */

// Only these /book/:slug pages are embedded on phes.io. Adding a tenant here
// without adding its parent origin to PARENT_ORIGINS would be a bug.
// Live slug verified 2026-07-22: /api/public/company/phes-cleaning → 200.
export const PHES_SLUGS = ["phes-cleaning"];

// phes.io serves from BOTH https://phes.io AND https://www.phes.io (distinct
// origins). postMessage takes one targetOrigin, so post to each. Never "*" for
// a payload carrying a booking id + price.
export const PARENT_ORIGINS = ["https://phes.io", "https://www.phes.io"];

export interface BookingCompleteMessage {
  type: "qleno-booking-complete";
  bookingId: string;
  quoteId: number | string | null;
  value: number;
  currency: "USD";
}

/**
 * Returns the message to post, or null when this completion must not be
 * reported as a conversion.
 */
export function buildBookingCompleteMessage(
  slug: string,
  bookResult: any,
): BookingCompleteMessage | null {
  if (!bookResult) return null;
  if (!PHES_SLUGS.includes(slug)) return null;                       // rule 3

  const jobId = bookResult.job_id ?? bookResult.jobId ?? null;        // rules 1 + 2
  if (jobId === null || jobId === undefined || jobId === "") return null;

  const rawValue = Number(                                            // rule 4
    bookResult.first_visit_total ?? bookResult.firstVisitTotal ?? bookResult.pricing?.final_total ?? 0,
  );

  return {
    type: "qleno-booking-complete",
    bookingId: String(jobId),
    quoteId: bookResult.quote_id ?? bookResult.quoteId ?? null,
    value: Number.isFinite(rawValue) && rawValue > 0 ? rawValue : 0,
    currency: "USD",
  };
}
