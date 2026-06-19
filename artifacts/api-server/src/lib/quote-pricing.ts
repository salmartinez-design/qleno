import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { frequencyLabel } from "./frequency-labels.js";

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

const r2 = (n: number) => Math.round(n * 100) / 100;

function calcAddonAmount(addon: any, base_price: number, sqft: number | null): number {
  const pv = parseFloat(String(addon.price_value ?? addon.price ?? 0));
  switch (addon.price_type) {
    case "flat": return pv;
    case "percentage":
    case "percent": return (pv / 100) * base_price;
    case "sqft_pct": return sqft ? (pv / 100) * sqft : 0;
    case "time_only": return 0;
    case "manual_adj": return pv;
    default:
      if (addon.percent_of_base != null) return (parseFloat(String(addon.percent_of_base)) / 100) * base_price;
      return pv;
  }
}

// Compute price + hours for ONE (scope, sqft, frequency, add-ons). Returns null
// when it genuinely can't price (no scope, or sqft-based scope with no sqft and
// no tier). Add-ons are per-visit.
export async function computeQuotePricing(opts: {
  companyId: number; scopeId: number; sqft: number | null; frequency: string; addonIds?: number[];
}): Promise<QuotePricing | null> {
  const { companyId, scopeId, sqft, frequency, addonIds } = opts;
  const scopeRow = (await db.execute(sql`
    SELECT pricing_method, hourly_rate, minimum_bill FROM pricing_scopes
    WHERE id = ${scopeId} AND company_id = ${companyId} LIMIT 1
  `)).rows[0] as any;
  if (!scopeRow) return null;
  const method = scopeRow.pricing_method || "sqft";

  // Per-frequency rate: rate_override wins, else scope rate × multiplier.
  const freqRow = (await db.execute(sql`
    SELECT multiplier, rate_override FROM pricing_frequencies
    WHERE scope_id = ${scopeId} AND company_id = ${companyId} AND frequency = ${frequency} LIMIT 1
  `)).rows[0] as any;
  const scopeRate = parseFloat(String((scopeRow as any).hourly_rate));
  let hourly_rate: number;
  if (freqRow?.rate_override != null && freqRow.rate_override !== "") {
    hourly_rate = parseFloat(String(freqRow.rate_override));
  } else {
    const mult = freqRow ? parseFloat(String(freqRow.multiplier)) : 1.0;
    hourly_rate = scopeRate * mult;
  }

  // Base hours: sqft → tier lookup; otherwise can't price here.
  let base_hours: number;
  if (method === "sqft") {
    if (sqft == null) return null;
    const tiers = (await db.execute(sql`
      SELECT min_sqft, max_sqft, hours FROM pricing_tiers
      WHERE scope_id = ${scopeId} AND company_id = ${companyId}
    `)).rows as any[];
    if (!tiers.length) return null;
    const sorted = [...tiers].sort((a, b) => a.min_sqft - b.min_sqft);
    const tier = sorted.find(t => sqft >= t.min_sqft && sqft <= t.max_sqft)
      ?? (sqft < Number(sorted[0].min_sqft) ? sorted[0] : sorted[sorted.length - 1]);
    base_hours = parseFloat(String(tier.hours));
  } else {
    return null; // hourly/simplified scopes aren't part of the residential comparison
  }

  let base_price = base_hours * hourly_rate;
  const minimum_bill = parseFloat(String((scopeRow as any).minimum_bill || 0));
  let minimum_applied = false;
  if (minimum_bill > 0 && base_price < minimum_bill) { base_price = minimum_bill; minimum_applied = true; }

  // Per-visit add-ons (price + time).
  let addons_total = 0;
  let addon_minutes = 0;
  const ids = (addonIds ?? []).map((x) => parseInt(String(x))).filter((n) => !isNaN(n));
  if (ids.length) {
    const addons = (await db.execute(sql`
      SELECT * FROM pricing_addons WHERE company_id = ${companyId}
        AND id = ANY(ARRAY[${sql.raw(ids.join(","))}]::int[]) AND is_active = true
    `)).rows as any[];
    for (const a of addons) {
      addon_minutes += parseInt(String(a.time_add_minutes ?? 0)) || 0;
      if (a.price_type === "time_only") continue;
      addons_total += calcAddonAmount(a, base_price, sqft);
    }
  }
  const addon_hours = r2(addon_minutes / 60);
  return {
    base_hours, addon_hours, total_hours: r2(base_hours + addon_hours),
    hourly_rate: r2(hourly_rate), base_price: r2(base_price),
    addons_total: r2(addons_total), total: r2(base_price + addons_total),
    minimum_applied,
  };
}

// The customer-facing tiers, in display order. Labels via the canonical map
// (lib/frequency-labels) so they match the quote builder + booking widget.
const TIERS: Array<{ frequency: string; label: string; recurring: boolean }> = [
  { frequency: "onetime",  label: frequencyLabel("onetime"),  recurring: false },
  { frequency: "weekly",   label: frequencyLabel("weekly"),   recurring: true },
  { frequency: "biweekly", label: frequencyLabel("biweekly"), recurring: true },
  { frequency: "monthly",  label: frequencyLabel("monthly"),  recurring: true },
];

export type FrequencyOption = {
  frequency: string; label: string; recurring: boolean;
  recurring_price: number | null; // per-visit recurring price (null for one-time)
  first_visit_price: number;      // = the one-time price (decision d)
  hours: number;
  configured: boolean;            // a pricing_frequencies row exists for this tier
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
