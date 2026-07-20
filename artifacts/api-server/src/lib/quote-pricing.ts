import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// [multi-frequency Pass1] Single shared quote-pricing engine + frequency-options
// builder. Mirrors the authenticated /api/pricing/calculate conventions (the
// engine that produces a quote's stored price) so the comparison tiers match
// what the office actually books: scope rate → per-frequency multiplier/
// rate_override → sqft tier hours → minimum bill → per-visit add-ons. Multi-
// tenant (company-scoped); no hardcoding.

export type QuotePricing = {
  base_hours: number;
  addon_hours: number;
  total_hours: number;
  hourly_rate: number;
  base_price: number;   // after minimum bill
  addons_total: number; // per-visit add-on $
  total: number;        // base_price + addons_total
  minimum_applied: boolean;
};

// Build the comparison options for a residential quote from scope + sqft + the
// quote's add-ons. Only frequencies that have a pricing_frequencies row are
// returned (decision a — no duplicate-priced fallback tier), EXCEPT one-time,
// which is always included as the first-visit anchor. first_visit_price = the
// one-time price (decision d).
export async function computeFrequencyOptions(opts: {
  companyId: number; scopeId: number; sqft: number | null; addonIds?: number[];
}): Promise<FrequencyOption[]> {
  const { companyId, scopeId } = opts;
  const configured = new Set(((await db.execute(sql`
    SELECT frequency FROM pricing_frequencies WHERE scope_id = ${scopeId} AND company_id = ${companyId}
  `)).rows as any[]).map((r) => String(r.frequency)));

  const onetime = await computeQuotePricing({ ...opts, frequency: "onetime" });
  if (!onetime) return []; // can't anchor a comparison without a priceable one-time

  const out: FrequencyOption[] = [];
  for (const t of TIERS) {
    const isOnetime = t.frequency === "onetime";
    if (!isOnetime && !configured.has(t.frequency)) continue; // skip unconfigured recurring tiers
    const pricing = isOnetime ? onetime : await computeQuotePricing({ ...opts, frequency: t.frequency });
    if (!pricing) continue;
    out.push({
      frequency: t.frequency, label: t.label, recurring: t.recurring,
      recurring_price: t.recurring ? pricing.total : null,
      first_visit_price: onetime.total,
      hours: pricing.total_hours,
      configured: isOnetime ? true : configured.has(t.frequency),
    });
  }
  return out;
}

// Idempotent columns for the snapshot + the customer's chosen tier (Piece 3).
export async function ensureQuotePricingSetup(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS frequency_options jsonb`);
    await db.execute(sql`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS selected_frequency text`);
    await db.execute(sql`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS selected_frequency_at timestamp`);
  } catch (err) {
    console.error("[quote-pricing] ensure setup error (non-fatal):", err);
  }
}

// Snapshot the comparison onto the quote so prices stay stable after send even
// if scope rates change. Reads the quote's scope_id/sqft/addons. No-op (clears
// to []) when the quote isn't priceable yet (draft without scope/sqft).
export async function snapshotQuoteFrequencyOptions(companyId: number, quoteId: number): Promise<void> {
  try {
    const q = (await db.execute(sql`
      SELECT scope_id, sqft, addons FROM quotes WHERE id = ${quoteId} AND company_id = ${companyId} LIMIT 1
    `)).rows[0] as any;
    if (!q) return;
    let options: FrequencyOption[] = [];
    if (q.scope_id && q.sqft != null) {
      const addonIds = (Array.isArray(q.addons) ? q.addons : [])
        .map((a: any) => parseInt(String(a?.id))).filter((n: number) => !isNaN(n));
      options = await computeFrequencyOptions({ companyId, scopeId: q.scope_id, sqft: Number(q.sqft), addonIds });
    }
    await db.execute(sql`UPDATE quotes SET frequency_options = ${JSON.stringify(options)}::jsonb WHERE id = ${quoteId} AND company_id = ${companyId}`);
  } catch (err) {
    console.error("[quote-pricing] snapshot error (non-fatal):", err);
  }
}
