/**
 * Payment-source derivation unit tests (DB-free) — the rule that drives both the
 * charge router and the clients.payment_source backfill.
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx --test src/tests/invoicing-payment-source.test.ts
 *
 * Rule (Sal, 2026-06-16): Stripe payment method on file → 'stripe', else
 * 'square' (the recurring base). An explicit office-set check/ach on the invoice
 * is preserved; null/unknown stamps fall back to the derive rule.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePaymentSource, resolveInvoicePaymentSource } from "../lib/payment-source.js";

describe("derivePaymentSource", () => {
  it("returns stripe when a Stripe payment method is on file", () => {
    assert.equal(derivePaymentSource({ stripe_payment_method_id: "pm_123" }), "stripe");
  });
  it("returns square when no Stripe payment method (null)", () => {
    assert.equal(derivePaymentSource({ stripe_payment_method_id: null }), "square");
  });
  it("returns square when the field is absent", () => {
    assert.equal(derivePaymentSource({}), "square");
  });
  it("treats empty string as no card → square", () => {
    assert.equal(derivePaymentSource({ stripe_payment_method_id: "" }), "square");
  });
});

describe("resolveInvoicePaymentSource", () => {
  it("honors an explicit stamped stripe", () => {
    assert.equal(resolveInvoicePaymentSource("stripe", { stripe_payment_method_id: null }), "stripe");
  });
  it("honors an explicit stamped square even with a Stripe PM (no re-routing of issued invoices)", () => {
    assert.equal(resolveInvoicePaymentSource("square", { stripe_payment_method_id: "pm_x" }), "square");
  });
  it("honors office-set check", () => {
    assert.equal(resolveInvoicePaymentSource("check", { stripe_payment_method_id: "pm_x" }), "check");
  });
  it("honors office-set ach", () => {
    assert.equal(resolveInvoicePaymentSource("ach", {}), "ach");
  });
  it("falls back to derive when the stamp is null", () => {
    assert.equal(resolveInvoicePaymentSource(null, { stripe_payment_method_id: "pm_x" }), "stripe");
    assert.equal(resolveInvoicePaymentSource(null, { stripe_payment_method_id: null }), "square");
  });
  it("falls back to derive when the stamp is an unknown value", () => {
    assert.equal(resolveInvoicePaymentSource("garbage", { stripe_payment_method_id: null }), "square");
  });
  it("is case-insensitive on the stamp", () => {
    assert.equal(resolveInvoicePaymentSource("STRIPE", { stripe_payment_method_id: null }), "stripe");
  });
});
