// [quote-discount-double-apply 2026-08-20] Francisco: "When a quote includes a
// discount, Qleno appears to take the already-discounted total from the quote
// and use it as the new base rate, then applies the discount again to that
// amount."
//
// He was right, and it was the office's hand-typed +/- rows, not the coupon
// codes. Converting a quote prices the job from the frequency snapshot when
// there is one, and from quotes.total_price when there is not. total_price is
// the POST-everything number the customer was quoted. The coded discount was
// already added back before that number became the job's base rate. The typed
// rows never were, so from 2026-08-14 (when those rows started carrying onto
// the job as their own line) a snapshot-less quote took the discounted total AS
// the base rate and then took the discount off a second time.
//
// Quote 632: $240 of service, the office takes $30 off, the customer is quoted
// $210. The job booked at a $210 base rate with a -$30 line, and billed $180.
//
// These two live here, apart from the route, for two reasons. There must be ONE
// definition of which typed rows belong to the booked scope, used both to back
// them out of total_price and to write them onto the job, because if those two
// ever disagree the money is wrong again. And keeping them free of any database
// import means the arithmetic can be tested on its own.

export type QuoteAdjustment = { signed: number; reason: string };

/**
 * The typed rows that belong to the scope the customer actually booked.
 * A row with no scope on it belongs to whatever was booked.
 */
export function quoteAdjustmentsForScope(
  rawAdjustments: unknown,
  bookedScopeId: number | null | undefined,
): QuoteAdjustment[] {
  const adjs = Array.isArray(rawAdjustments) ? rawAdjustments : [];
  const scopeId = bookedScopeId != null ? Number(bookedScopeId) : null;
  const out: QuoteAdjustment[] = [];
  for (const a of adjs as any[]) {
    if (scopeId != null && a?.scope_id != null && Number(a.scope_id) !== scopeId) continue;
    const amt = Number(a?.amount) || 0;
    if (!(amt > 0)) continue;
    out.push({
      signed: a?.type === "subtract" ? -amt : amt,
      reason: String(a?.reason ?? "").trim(),
    });
  }
  return out;
}

/**
 * What those rows did to the customer's price, negative when the office gave
 * money back. Subtracting this from total_price recovers the price of the
 * service before the office touched it, which is what the job's base rate holds.
 */
export function netQuoteManualAdjustment(
  rawAdjustments: unknown,
  bookedScopeId: number | null | undefined,
): number {
  const net = quoteAdjustmentsForScope(rawAdjustments, bookedScopeId).reduce((sum, a) => sum + a.signed, 0);
  return Math.round(net * 100) / 100;
}
