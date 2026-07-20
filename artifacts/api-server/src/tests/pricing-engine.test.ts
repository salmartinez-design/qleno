/**
 * Unified pricing engine — pure-math unit tests (no DB required).
 *
 * Proves lib/pricing-engine.ts `priceFromData` reproduces the office quote tool
 * and the website for the same inputs, using Phes's real config shape (Deep Clean
 * @ $80 std / $90 same-day; Oven $60 + Fridge $60 flat; Windows 15% of base; the
 * "Oven + Refrigerator Combo" −$20). Headline: Samaah's office same-day quote must
 * equal $638.20 (Pancho's number). Run: node --test (no DATABASE_URL needed).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { priceFromData, type PricingData, type PricingParams } from "../lib/pricing-engine.js";

const OVEN = { id: 8, name: "Oven Cleaning", price_type: "flat", price_value: "60", time_add_minutes: 30 };
const FRIDGE = { id: 10, name: "Refrigerator Cleaning", price_type: "flat", price_value: "60", time_add_minutes: 30 };
const WINDOWS = { id: 20, name: "Windows", price_type: "percentage", price_value: "15", time_add_minutes: 45 };
const COMBO = { id: 1, name: "Oven + Refrigerator Combo", discount_type: "flat_total", discount_value: "20", required_ids: [8, 10] };

function data(rate: string, opts: Partial<PricingData> = {}): PricingData {
  return {
    scope: { hourly_rate: rate, minimum_bill: "0", pricing_method: "sqft", name: "Deep Clean" },
    tiers: [{ id: 1, min_sqft: 0, max_sqft: 100000, hours: "5.2" }], // 1,000 sqft → 5.2 hrs
    freqs: [],
    addons: [OVEN, FRIDGE, WINDOWS],
    bundles: [COMBO],
    discounts: [],
    petRow: null,
    ...opts,
  };
}
const base: PricingParams = { company_id: 1, scope_id: 1, frequency: "onetime", sqft: 1000, addon_ids: [8, 10, 20] };

describe("unified pricing engine", () => {
  it("office same-day quote ($90 override) = $638.20 (Pancho's number)", () => {
    const r = priceFromData(data("80"), { ...base, hourly_rate_override: 90 });
    assert.equal(r.hourly_rate, 90);
    assert.equal(r.base_price, 468);      // 5.2 × 90
    assert.equal(r.bundle_discount, 20);  // oven+fridge combo
    assert.equal(r.final_total, 638.2);   // 468 + 60 + 60 + 70.20 (15% of 468) − 20
  });

  it("website standard quote ($80, no override) is internally consistent", () => {
    const r = priceFromData(data("80"), { ...base });
    assert.equal(r.hourly_rate, 80);
    assert.equal(r.base_price, 416);      // 5.2 × 80
    assert.equal(r.final_total, 578.4);   // 416 + 60 + 60 + 62.40 (15% of 416) − 20
  });

  it("combo toggled OFF (office) drops the −$20", () => {
    const r = priceFromData(data("80"), { ...base, hourly_rate_override: 90, disabled_bundle_ids: [1] });
    assert.equal(r.bundle_discount, 0);
    assert.equal(r.final_total, 658.2);   // 638.20 + 20
  });

  it("manual adjustment (office) adds to the total", () => {
    const r = priceFromData(data("80"), { ...base, hourly_rate_override: 90, manual_adjustment: 25 });
    assert.equal(r.final_total, 663.2);   // 638.20 + 25
  });

  it("recurring frequency multiplier applies (weekly ×0.9)", () => {
    const d = data("80", { freqs: [{ frequency: "weekly", multiplier: "0.9", rate_override: null }] });
    const r = priceFromData(d, { ...base, frequency: "weekly" });
    assert.equal(r.hourly_rate, 72);      // 80 × 0.9
    assert.equal(r.base_price, 374.4);    // 5.2 × 72
  });

  it("frequency rate_override wins over the multiplier", () => {
    const d = data("80", { freqs: [{ frequency: "weekly", multiplier: "0.9", rate_override: "65" }] });
    const r = priceFromData(d, { ...base, frequency: "weekly" });
    assert.equal(r.hourly_rate, 65);
  });

  it("legacy explicit hours (office, no sqft) prices off hours", () => {
    const r = priceFromData(data("80"), { ...base, sqft: null, hours: 4 });
    assert.equal(r.base_hours, 4);
    assert.equal(r.base_price, 320);      // 4 × 80
  });

  it("add-on quantity multiplies the fixed price (office)", () => {
    const r = priceFromData(data("80"), { ...base, addon_quantities: { "8": 2 } });
    // oven ×2 = 120, fridge 60, windows 62.40 = 242.40, − combo 20 = 222.40; + 416 = 638.40
    assert.equal(r.final_total, 638.4);
  });

  it("minimum bill floors a tiny base price", () => {
    const d = data("80", { scope: { hourly_rate: "80", minimum_bill: "500", pricing_method: "sqft", name: "Deep Clean" } });
    const r = priceFromData(d, { company_id: 1, scope_id: 1, frequency: "onetime", sqft: 1000, addon_ids: [] });
    assert.equal(r.minimum_applied, true);
    assert.equal(r.base_price, 500);      // 416 floored to 500
  });
});
