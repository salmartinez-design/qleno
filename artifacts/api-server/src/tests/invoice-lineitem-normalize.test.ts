/**
 * Unit tests for normalizeInvoiceLineItems — the fix for the invoice "View"
 * crash. The edit-save path persisted qty/unit_price as STRINGS, and the View
 * render called .toFixed() on them → TypeError → ErrorBoundary. The normalizer
 * guarantees numeric line_items on write.
 *
 * Run: tsx --test src/tests/invoice-lineitem-normalize.test.ts   (no DB needed)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeInvoiceLineItems } from "../lib/normalize-line-items.js";

describe("normalizeInvoiceLineItems", () => {
  it("coerces string qty/unit_price/total to numbers (the crash repro)", () => {
    const out = normalizeInvoiceLineItems([
      { description: "Deep Clean", quantity: "1", unit_price: "270", total: "270" },
    ])!;
    const li = out[0];
    assert.equal(typeof li.quantity, "number");
    assert.equal(typeof li.unit_price, "number");
    assert.equal(typeof li.total, "number");
    assert.equal(li.unit_price, 270);
    // The exact thing that threw before: .toFixed on the value must now work.
    assert.equal(Number(li.unit_price).toFixed(2), "270.00");
  });

  it("accepts the legacy `rate` alias for unit_price", () => {
    const out = normalizeInvoiceLineItems([{ description: "x", quantity: 2, rate: "55.5", total: 111 }])!;
    assert.equal(out[0].unit_price, 55.5);
  });

  it("defaults missing/garbage numerics to 0, never NaN", () => {
    const out = normalizeInvoiceLineItems([{ description: "y" }, { quantity: "abc", total: null }])!;
    assert.equal(out[0].quantity, 0);
    assert.equal(out[0].unit_price, 0);
    assert.equal(out[1].quantity, 0);
    assert.equal(out[1].total, 0);
    assert.ok(!Number.isNaN(out[1].total));
  });

  it("preserves real numbers and negative discount lines", () => {
    const out = normalizeInvoiceLineItems([{ description: "Discount", quantity: 1, unit_price: -25, total: -25 }])!;
    assert.equal(out[0].total, -25);
  });

  it("returns undefined for non-array input (so PUT leaves stored lines untouched)", () => {
    assert.equal(normalizeInvoiceLineItems(undefined), undefined);
    assert.equal(normalizeInvoiceLineItems(null), undefined);
    assert.equal(normalizeInvoiceLineItems("nope" as unknown), undefined);
  });
});
