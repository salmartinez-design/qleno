// ── Unified pricing engine ───────────────────────────────────────────────────
// SINGLE source of truth for quote/booking pricing. Before this, the same math
// lived in THREE places — the website (`runCalculate` in routes/public.ts), the
// office quote tool (inline in routes/pricing.ts `/calculate`), and a dead copy
// (`computeQuotePricing` in lib/quote-pricing.ts). Hand-kept copies drift, which
// is what produced the office-vs-website quote variances.
//
// Design (approved 2026-07-20, "Option A"): the WEBSITE calculator is the source
// of truth and its output must NOT change. `priceFromData` reproduces that logic
// exactly when called with the website's params, and adds OFFICE-ONLY optional
// levers (rate override, explicit hours, add-on quantities, manual adjustment,
// disabled bundles) that the website NEVER passes — so the website stays byte-for-
// byte identical, while the office shares the same core math + keeps its buttons.
//
// The public/website caller MUST NOT forward any office-only lever from the
// browser (a customer could otherwise tamper with their own price). The website
// wrapper hardcodes the safe subset.
//
// Structure: `priceFromData` is PURE (all math, no IO) so it is unit-testable
// without a DB (see tests/pricing-engine.test.ts). `computePricing` fetches the
// rows and delegates to it.
import { db } from "@workspace/db";
import {
  pricingScopesTable,
  pricingTiersTable,
  pricingFrequenciesTable,
  pricingDiscountsTable,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { computePetFee, petFeeConfigFromRow } from "./pet-fee";

// Single canonical add-on unit price. Mirrors the website's original inline
// switch exactly (the "correct" one) — flat / percentage(of base) / sqft_pct /
// manual_adj, with the legacy percent_of_base fallback. Negative percentages are
// honored via the sign of price_value (used for discount-style add-ons).
export function calcAddonAmount(addon: any, base_price: number, sqft: number | null): number {
  const pv = parseFloat(String(addon.price_value ?? addon.price ?? 0));
  switch (addon.price_type) {
    case "flat":
      return pv;
    case "percentage":
    case "percent":
      return (Math.abs(pv) / 100) * base_price * (pv < 0 ? -1 : 1);
    case "sqft_pct":
      return sqft ? (pv / 100) * sqft : 0;
    case "manual_adj":
      return pv;
    case "time_only":
      return 0;
    default:
      if (addon.percent_of_base != null) return (parseFloat(String(addon.percent_of_base)) / 100) * base_price;
      if (addon.price != null) return parseFloat(String(addon.price));
      return 0;
  }
}

export interface PricingParams {
  company_id: number;
  scope_id: number;
  frequency?: string | null;
  sqft?: number | null;
  addon_ids?: number[];
  discount_code?: string;
  // Website-only: charge a pet fee when the home has pets + tenant enabled it.
  pets?: number;
  // Website flag: when true, discounts marked is_online=false are ignored.
  public_only?: boolean;
  // ── OFFICE-ONLY LEVERS (website must never pass these) ──────────────────────
  hours?: number | null;                       // explicit hours (legacy no-sqft / hourly scopes)
  hourly_rate_override?: number | null;        // per-client / same-day rate
  addon_quantities?: Record<string, number>;   // office can order qty > 1
  manual_adjustment?: number;                  // free-form +/- amount
  disabled_bundle_ids?: number[];              // combos toggled OFF on the quote
}

// Rows the pure calculator needs. Shapes match what the DB queries return.
export interface PricingData {
  scope: { hourly_rate: any; minimum_bill: any; pricing_method?: string | null; name?: string | null };
  tiers: Array<{ id: number; min_sqft: number; max_sqft: number; hours: any }>;
  freqs: Array<{ frequency: string; multiplier: any; rate_override: any }>;
  addons: Array<any>;   // selected + active addon rows
  bundles: Array<{ id: any; name: any; discount_type: any; discount_value: any; required_ids: any[] }>; // active bundles
  discounts: Array<{ code: string; is_active: boolean; discount_type: string; discount_value: any; scope_ids?: any; is_online?: boolean }>;
  petRow?: any | null;  // offer_settings row (for pet fee), or null
}

// PURE — all math, no IO. Unit-testable without a DB.
export function priceFromData(data: PricingData, params: PricingParams) {
  const {
    scope_id, sqft, frequency, discount_code, public_only,
    hours, hourly_rate_override, addon_quantities, manual_adjustment, disabled_bundle_ids,
  } = params;
  const { scope, tiers, freqs, addons, bundles, discounts, petRow } = data;
  const method = scope.pricing_method || "sqft";

  // ── Base hours ─────────────────────────────────────────────────────────────
  // Website path: method='sqft', no `hours` → sqft tier lookup (unchanged).
  // Office paths: explicit `hours` (legacy no-sqft) or a non-sqft scope method.
  let base_hours: number;
  let tier_id: number | null = null;
  let used_sqft: number | null = null;
  const hoursProvided = hours != null && hours !== ("" as any) && Number(hours) > 0;
  if (method === "sqft" && !hoursProvided) {
    if (sqft == null) throw Object.assign(new Error("sqft is required for sqft-based scopes"), { statusCode: 400 });
    const sortedTiers = [...tiers].sort((a, b) => a.min_sqft - b.min_sqft);
    const tier =
      sortedTiers.find(t => sqft >= t.min_sqft && sqft <= t.max_sqft) ??
      (sqft < Number(sortedTiers[0]?.min_sqft) ? sortedTiers[0] : sortedTiers[sortedTiers.length - 1]);
    if (!tier) throw Object.assign(new Error("No tier found for the given sqft"), { statusCode: 422 });
    base_hours = parseFloat(String(tier.hours));
    tier_id = tier.id;
    used_sqft = sqft;
  } else {
    if (!hoursProvided) throw Object.assign(new Error("hours is required for hourly/no-sqft scopes"), { statusCode: 400 });
    base_hours = parseFloat(String(hours));
    used_sqft = sqft ?? null;
  }

  // ── Hourly rate (website logic; office override enters via scope_hourly) ─────
  const freqFactor = freqs.find(f => f.frequency === frequency);
  const overrideNum = hourly_rate_override != null && (hourly_rate_override as any) !== ""
    ? parseFloat(String(hourly_rate_override)) : NaN;
  const scope_hourly = (!isNaN(overrideNum) && overrideNum > 0) ? overrideNum : parseFloat(String(scope.hourly_rate));
  const isOneTime = ["onetime", "one_time", "on_demand"].includes((frequency || "").toLowerCase());
  let hourly_rate: number;
  if (isOneTime) {
    hourly_rate = scope_hourly;
  } else if (freqFactor?.rate_override != null && (freqFactor.rate_override as any) !== "") {
    hourly_rate = parseFloat(String(freqFactor.rate_override));
  } else {
    const mult = freqFactor ? parseFloat(String(freqFactor.multiplier)) : 1.0;
    hourly_rate = scope_hourly * mult;
  }

  let base_price = base_hours * hourly_rate;
  const minimum_bill = parseFloat(String(scope.minimum_bill));
  let minimum_applied = false;
  if (minimum_bill > 0 && base_price < minimum_bill) {
    base_price = minimum_bill;
    minimum_applied = true;
  }

  // ── Add-ons (fixed prices / %-of-base / sqft%); time adds hours, not $×rate ──
  let addons_total = 0;
  let addon_minutes = 0;
  const addon_breakdown: Array<{ id: number; name: string; amount: number; price_type: string }> = [];
  for (const addon of addons) {
    const qty = (addon_quantities && addon_quantities[String(addon.id)])
      ? Math.max(1, parseInt(String(addon_quantities[String(addon.id)]))) : 1;
    addon_minutes += (parseInt(String(addon.time_add_minutes ?? 0)) || 0) * qty;
    if (addon.price_type === "time_only") continue;
    const amount = calcAddonAmount(addon, base_price, used_sqft) * qty;
    addons_total += amount;
    addon_breakdown.push({ id: addon.id, name: addon.name, amount: Math.round(amount * 100) / 100, price_type: addon.price_type });
  }
  const addon_hours = Math.round((addon_minutes / 60) * 100) / 100;
  const total_hours = Math.round((base_hours + addon_hours) * 100) / 100;

  // ── Bundle / combo discounts — most-specific, non-overlapping set ────────────
  let bundle_discount = 0;
  const bundle_breakdown: Array<{ id: number; name: string; discount: number; applied: boolean }> = [];
  const disabledBundleSet = new Set(
    (Array.isArray(disabled_bundle_ids) ? disabled_bundle_ids : [])
      .map((x: any) => parseInt(String(x))).filter((n: number) => !isNaN(n)),
  );
  const selectedIds = addons.map((a: any) => parseInt(String(a.id))).filter((n: number) => !isNaN(n));
  if (selectedIds.length > 0) {
    const candidates = bundles.map((bundle: any) => {
      const required: number[] = [...new Set((bundle.required_ids ?? []).map((x: any) => parseInt(String(x))).filter((n: number) => !isNaN(n)))] as number[];
      const matched = required.filter(rid => selectedIds.includes(rid));
      if (required.length === 0 || matched.length !== required.length) return null;
      const dv = parseFloat(String(bundle.discount_value));
      let disc = 0;
      if (bundle.discount_type === "flat_per_item") disc = dv * matched.length;
      else if (bundle.discount_type === "flat" || bundle.discount_type === "flat_total") disc = dv;
      else if (bundle.discount_type === "percentage") disc = (dv / 100) * base_price;
      return { id: Number(bundle.id), name: String(bundle.name), required, disc };
    }).filter(Boolean) as Array<{ id: number; name: string; required: number[]; disc: number }>;
    candidates.sort((a, b) => (b.required.length - a.required.length) || (b.disc - a.disc));
    const consumedAddons = new Set<number>();
    for (const c of candidates) {
      if (c.required.some(rid => consumedAddons.has(rid))) continue; // overlaps a higher-priority bundle
      c.required.forEach(rid => consumedAddons.add(rid));
      const applied = !disabledBundleSet.has(c.id);
      if (applied) bundle_discount += c.disc;
      bundle_breakdown.push({ id: c.id, name: c.name, discount: Math.round(c.disc * 100) / 100, applied });
    }
  }
  addons_total -= bundle_discount;

  // ── Manual adjustment (OFFICE-only free-form +/- amount) ─────────────────────
  if (manual_adjustment && Number(manual_adjustment) !== 0) {
    const adjAmt = parseFloat(String(manual_adjustment));
    if (!isNaN(adjAmt) && adjAmt !== 0) {
      addons_total += adjAmt;
      addon_breakdown.push({ id: -1, name: "Manual Adjustment", amount: Math.round(adjAmt * 100) / 100, price_type: "manual_adj" });
    }
  }

  // ── Pet fee (WEBSITE-only; ships DISABLED per tenant). Fail-safe. ────────────
  let pet_fee = 0;
  let pet_fee_type: string | null = null;
  if (params.pets && params.pets > 0 && petRow) {
    try {
      const cfg = petFeeConfigFromRow(petRow);
      pet_fee = computePetFee(cfg, params.pets, base_price);
      if (pet_fee > 0) pet_fee_type = cfg.type;
    } catch {
      pet_fee = 0;
    }
  }

  let subtotal = base_price + addons_total + pet_fee;
  let discount_amount = 0;
  let final_total = subtotal;
  let discount_valid = false;

  if (discount_code) {
    const match = discounts.find(d => {
      if (d.code.toUpperCase() !== discount_code.toUpperCase() || !d.is_active) return false;
      if (public_only && (d as any).is_online === false) return false;
      let scopes: number[] = [];
      try { scopes = JSON.parse((d as any).scope_ids || "[]"); } catch { /* noop */ }
      return scopes.length === 0 || scopes.includes(scope_id);
    });
    if (match) {
      discount_valid = true;
      if (match.discount_type === "flat") discount_amount = parseFloat(String(match.discount_value));
      else discount_amount = (parseFloat(String(match.discount_value)) / 100) * subtotal;
      final_total = Math.max(0, subtotal - discount_amount);
    }
  }

  return {
    scope_id,
    scope_name: scope.name,
    pricing_method: method,
    sqft: used_sqft,
    hours: base_hours,
    frequency: frequency ?? null,
    tier_id,
    base_hours,
    addon_hours,
    total_hours,
    hourly_rate: Math.round(hourly_rate * 100) / 100,
    base_price: Math.round(base_price * 100) / 100,
    minimum_applied,
    minimum_bill: Math.round(minimum_bill * 100) / 100,
    addons_total: Math.round(addons_total * 100) / 100,
    addon_breakdown,
    bundle_discount: Math.round(bundle_discount * 100) / 100,
    bundle_breakdown,
    pet_fee: Math.round(pet_fee * 100) / 100,
    pet_fee_type,
    subtotal: Math.round(subtotal * 100) / 100,
    discount_amount: Math.round(discount_amount * 100) / 100,
    discount_valid: discount_code ? discount_valid : undefined,
    final_total: Math.round(final_total * 100) / 100,
  };
}

// Fetches the rows and delegates to the pure calculator.
export async function computePricing(params: PricingParams) {
  const { scope_id, addon_ids, discount_code, company_id, pets } = params;

  const [scope] = await db
    .select()
    .from(pricingScopesTable)
    .where(and(eq(pricingScopesTable.id, scope_id), eq(pricingScopesTable.company_id, company_id)));
  if (!scope) throw Object.assign(new Error("Scope not found"), { statusCode: 404 });

  const tiers = await db
    .select()
    .from(pricingTiersTable)
    .where(and(eq(pricingTiersTable.scope_id, scope_id), eq(pricingTiersTable.company_id, company_id)));

  const freqs = await db
    .select()
    .from(pricingFrequenciesTable)
    .where(and(eq(pricingFrequenciesTable.scope_id, scope_id), eq(pricingFrequenciesTable.company_id, company_id)));

  const validIds = Array.isArray(addon_ids)
    ? addon_ids.map((id: any) => parseInt(String(id))).filter((n: number) => !isNaN(n)) : [];
  let addons: any[] = [];
  let bundles: any[] = [];
  if (validIds.length > 0) {
    const addonResult = await db.execute(sql`
      SELECT * FROM pricing_addons
       WHERE company_id = ${company_id}
         AND id = ANY(ARRAY[${sql.raw(validIds.join(","))}]::int[])
         AND is_active = true
    `);
    addons = (addonResult as any).rows ?? [];
    const bundleResult = await db.execute(sql`
      SELECT ab.id, ab.name, ab.discount_type, ab.discount_value,
             array_agg(abi.addon_id) as required_ids
        FROM addon_bundles ab
        JOIN addon_bundle_items abi ON abi.bundle_id = ab.id
       WHERE ab.company_id = ${company_id} AND ab.active = true
       GROUP BY ab.id, ab.name, ab.discount_type, ab.discount_value
    `);
    bundles = (bundleResult as any).rows ?? [];
  }

  let discounts: any[] = [];
  if (discount_code) {
    discounts = await db.select().from(pricingDiscountsTable).where(eq(pricingDiscountsTable.company_id, company_id));
  }

  let petRow: any = null;
  if (pets && pets > 0) {
    try {
      const osRes = await db.execute(sql`
        SELECT pet_fee_enabled, pet_fee_type, pet_fee_amount
          FROM offer_settings WHERE company_id = ${company_id} LIMIT 1
      `);
      petRow = (osRes as any).rows?.[0] ?? {};
    } catch {
      petRow = null;
    }
  }

  return priceFromData({ scope, tiers, freqs, addons, bundles, discounts, petRow }, params);
}
