// [auto-promos 2026-06-21] Unit tests for the pure promo logic — math + the
// non-stacking selection rule. Runs without a live DB (stub DATABASE_URL lets
// the @workspace/db Pool import without connecting, since the pure functions
// never issue a query).
//
//   pnpm --filter @workspace/api-server run test:promos
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  promoAmount,
  selectAutoPromo,
  promoCode,
  defaultPromoLabel,
  SECOND_RECURRING,
  DEEP_CLEAN,
  type ActivePromo,
} from "../lib/auto-promos-core.js";

const deep: ActivePromo = { kind: DEEP_CLEAN, pct: 15, label: "Deep Clean Promo (15% off)" };
const recur: ActivePromo = { kind: SECOND_RECURRING, pct: 15, label: "Second Visit Promo (15% off)" };

describe("promoAmount", () => {
  it("computes 15% of a base, rounded to cents", () => {
    assert.equal(promoAmount(15, 200), 30);
    assert.equal(promoAmount(15, 199.99), 30); // 29.9985 → 30.00
    assert.equal(promoAmount(15, 56.67), 8.5); // 8.5005 → 8.50
  });
  it("clamps junk / non-positive inputs to 0", () => {
    assert.equal(promoAmount(0, 200), 0);
    assert.equal(promoAmount(15, 0), 0);
    assert.equal(promoAmount(-15, 200), 0);
    assert.equal(promoAmount(15, -5), 0);
    assert.equal(promoAmount(NaN, 200), 0);
  });
});

describe("selectAutoPromo (non-stacking rule)", () => {
  it("applies the deep-clean promo to a deep clean", () => {
    const p = selectAutoPromo({ serviceType: "deep_clean", isSecondRecurringVisit: false, active: [deep, recur] });
    assert.equal(p?.kind, DEEP_CLEAN);
  });
  it("applies the 2nd-recurring promo to the 2nd visit", () => {
    const p = selectAutoPromo({ serviceType: "recurring", isSecondRecurringVisit: true, active: [deep, recur] });
    assert.equal(p?.kind, SECOND_RECURRING);
  });
  it("does NOT stack — a 2nd-visit deep clean gets ONE promo (highest pct), not two", () => {
    const bigDeep: ActivePromo = { kind: DEEP_CLEAN, pct: 20, label: "x" };
    const p = selectAutoPromo({ serviceType: "deep_clean", isSecondRecurringVisit: true, active: [bigDeep, recur] });
    assert.equal(p?.kind, DEEP_CLEAN); // 20% beats 15%
    assert.equal(p?.pct, 20);
  });
  it("returns null when nothing applies", () => {
    assert.equal(selectAutoPromo({ serviceType: "standard_clean", isSecondRecurringVisit: false, active: [deep, recur] }), null);
    assert.equal(selectAutoPromo({ serviceType: "deep_clean", isSecondRecurringVisit: false, active: [] }), null);
  });
  it("ignores zero/negative-percent promos", () => {
    const dead: ActivePromo = { kind: DEEP_CLEAN, pct: 0, label: "x" };
    assert.equal(selectAutoPromo({ serviceType: "deep_clean", isSecondRecurringVisit: false, active: [dead] }), null);
  });
});

describe("codes + labels", () => {
  it("stamps a stable, idempotent code per kind", () => {
    assert.equal(promoCode(DEEP_CLEAN), "AUTO_DEEP_CLEAN");
    assert.equal(promoCode(SECOND_RECURRING), "AUTO_SECOND_RECURRING");
  });
  it("produces readable invoice labels", () => {
    assert.equal(defaultPromoLabel(DEEP_CLEAN, 15), "Deep Clean Promo (15% off)");
    assert.equal(defaultPromoLabel(SECOND_RECURRING, 15), "Second Visit Promo (15% off)");
  });
});
