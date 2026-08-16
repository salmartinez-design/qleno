/**
 * Payroll metric invariants.
 *
 * These screens didn't drift because anyone did bad arithmetic. They drifted
 * because NOTHING FAILED when two surfaces disagreed. Revenue meant
 * `billed_amount ?? base_fee` in one file and `base_fee` in another for weeks;
 * the Labor % numerator was `grand_total` while the card printed beside it was
 * `commission`; mileage meant "earned" in one column and "applied" in the sum
 * next to it. Every one of those shipped green.
 *
 * So the guard can't be "be careful" — it has to be a test that goes red. This
 * pins the properties that made those bugs possible:
 *
 *   A. totalPay is the ONLY collapse of PayComponents, and pending mileage is
 *      structurally outside it.
 *   B. Revenue components stay algebraically consistent.
 *   C. A ratio always reports the numerator and denominator it used.
 *   D. The /payroll/detail contract: totalPay(pay_components) === grand_total.
 *   E. The disclosure thresholds actually fire on the real Phes shapes that
 *      prompted this work.
 *
 * Pure functions only — no DB, no network, so it can gate every PR.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  round2, totalPay, addPay, sumPay, splitAdditionalPay, makeRevenue, addRevenue,
  laborRatio, unattributedPct, isUnattributedMaterial, hasMeaningfulPriorYear,
  hourlyRate, MILEAGE_PAY_TYPES, TIME_OFF_PAY_TYPES,
  MATERIAL_UNATTRIBUTED_PCT, EMPTY_PAY, EMPTY_REVENUE,
  type PayComponents,
} from "@workspace/payroll-metrics";

// ── A. Pay components ────────────────────────────────────────────────────────

test("totalPay sums exactly the three paid components", () => {
  const p: PayComponents = { commission: 750.67, additional: 6.60, mileage_applied: 12.00, mileage_pending: 0 };
  assert.equal(totalPay(p), 769.27);
});

test("pending mileage is NEVER inside a total", () => {
  // Vanessa Hernandez, Jul 19-25 2026: $750.67 commission + $6.60 event pay,
  // with $16.91 of mileage across three legs ALL still PENDING review. Total
  // pay was $757.27 — the pending mileage correctly stayed out. "No money until
  // reviewed" is load-bearing (CLAUDE.md); this asserts it structurally rather
  // than trusting each caller to remember.
  const vanessa: PayComponents = {
    commission: 750.67, additional: 6.60, mileage_applied: 0, mileage_pending: 16.91,
  };
  assert.equal(totalPay(vanessa), 757.27);

  // Raising pending must not move the total by a cent.
  const morePending = { ...vanessa, mileage_pending: 999.99 };
  assert.equal(totalPay(morePending), totalPay(vanessa));
});

test("applied mileage IS inside the total (it is money that moved)", () => {
  const applied: PayComponents = { commission: 100, additional: 0, mileage_applied: 16.91, mileage_pending: 0 };
  assert.equal(totalPay(applied), 116.91);
});

test("addPay/sumPay are associative over the components and preserve the total", () => {
  const a: PayComponents = { commission: 61.43, additional: 0, mileage_applied: 4.28, mileage_pending: 1.11 };
  const b: PayComponents = { commission: 140.80, additional: 6.60, mileage_applied: 0, mileage_pending: 7.29 };
  const c: PayComponents = { commission: 68.25, additional: 12.34, mileage_applied: 5.34, mileage_pending: 0 };

  assert.deepEqual(addPay(addPay(a, b), c), addPay(a, addPay(b, c)));
  assert.equal(sumPay([a, b, c]).commission, round2(61.43 + 140.80 + 68.25));
  // The summed total equals the sum of the totals — no rounding drift across a
  // 10-person team.
  assert.equal(totalPay(sumPay([a, b, c])), round2(totalPay(a) + totalPay(b) + totalPay(c)));
  assert.equal(totalPay(EMPTY_PAY), 0);
});

test("splitAdditionalPay separates reimbursement from pay", () => {
  // Mileage is a reimbursement, not wages (29 CFR 778.217) — it must never be
  // counted as a tip/bonus.
  const split = splitAdditionalPay({
    Bonus: 160, tips: 40, event_pay: 6.60, mileage_reimbursement: 16.91, mileage: 4.09,
  });
  assert.equal(split.additional, 206.60);
  assert.equal(split.mileage, 21.00);
  for (const key of MILEAGE_PAY_TYPES) {
    assert.equal(splitAdditionalPay({ [key]: 10 }).additional, 0, `${key} must not count as pay`);
  }
  assert.deepEqual(splitAdditionalPay(null), { additional: 0, mileage: 0 });
});

// ── B. Revenue components ────────────────────────────────────────────────────

test("makeRevenue keeps billed = attributed + unattributed", () => {
  const r = makeRevenue(21587.89, 15000);
  assert.equal(r.unattributed, 6587.89);
  assert.equal(round2(r.attributed + r.unattributed), r.billed);
});

test("revenue addition preserves the identity across weeks", () => {
  const total = [makeRevenue(15038, 15038), makeRevenue(34000, 4000), makeRevenue(0, 0)]
    .reduce(addRevenue, EMPTY_REVENUE);
  assert.equal(total.billed, 49038);
  assert.equal(round2(total.attributed + total.unattributed), total.billed);
});

// ── C. Ratios carry their own inputs ─────────────────────────────────────────

test("laborRatio reports the numerator and denominator it used", () => {
  const pay: PayComponents = { commission: 5825.98, additional: 369.72, mileage_applied: 0, mileage_pending: 145.28 };
  const rev = makeRevenue(21587.89, 21587.89);
  const r = laborRatio(pay, rev, "billed");

  assert.equal(r.numerator, 6195.70);
  assert.equal(r.denominator, 21587.89);
  assert.equal(r.basis, "billed");
  // The exact reconciliation Sal couldn't do on screen: 28.7% is total pay over
  // billed, NOT the $5,825.98 commission card sitting beside it (27.0%).
  assert.equal(r.pct, 28.7);
  assert.notEqual(r.pct, Math.round((pay.commission / rev.billed) * 1000) / 10);
});

test("the two bases differ by exactly the unattributed share", () => {
  // A 26-week window where a third of revenue came from imported, tech-less
  // jobs. Billed basis flatters labor; attributed basis is the honest read.
  const pay: PayComponents = { commission: 110997, additional: 0, mileage_applied: 0, mileage_pending: 0 };
  const rev = makeRevenue(414570, 276380);

  assert.equal(laborRatio(pay, rev, "billed").pct, 26.8);   // what the chart showed
  assert.equal(laborRatio(pay, rev, "attributed").pct, 40.2); // what was actually true
  assert.equal(laborRatio(pay, rev).basis, "attributed", "attributed must be the default basis");
});

test("a zero denominator yields null, never 0%", () => {
  // 0% labor cost is a claim; "no data" is the truth. They must not look alike.
  const r = laborRatio({ commission: 500, additional: 0, mileage_applied: 0, mileage_pending: 0 }, EMPTY_REVENUE);
  assert.equal(r.pct, null);
  assert.equal(unattributedPct(EMPTY_REVENUE), 0);
});

// ── D. The /payroll/detail contract ──────────────────────────────────────────

test("totalPay(pay_components) reproduces grand_total", () => {
  // grand_total on /payroll/detail is commission + every additional_pay type,
  // with applied mileage already folded in as an adjustment type. If these ever
  // diverge, the strip and the per-employee panel disagree about someone's pay.
  const commission = 750.67;
  const addlByType = { event_pay: 6.60, mileage_reimbursement: 12.00 };
  const grandTotal = round2(commission + Object.values(addlByType).reduce((s, v) => s + v, 0));

  const split = splitAdditionalPay(addlByType);
  const components: PayComponents = {
    commission: round2(commission),
    additional: split.additional,
    mileage_applied: split.mileage,
    mileage_pending: round2(Math.max(0, 16.91 - split.mileage)),
  };

  assert.equal(totalPay(components), grandTotal);
  assert.equal(components.mileage_pending, 4.91);
});

// ── E. Disclosure thresholds ─────────────────────────────────────────────────

test("unattributed revenue is disclosed once it is material", () => {
  const clean = makeRevenue(1000, 990);            // 1%
  const distorted = makeRevenue(414570, 276380);   // ~33%
  assert.equal(isUnattributedMaterial(clean), false);
  assert.equal(isUnattributedMaterial(distorted), true);
  assert.equal(unattributedPct(distorted), 33.3);

  // Exactly at the threshold discloses — the boundary is inclusive.
  const atThreshold = makeRevenue(100, 100 - MATERIAL_UNATTRIBUTED_PCT);
  assert.equal(isUnattributedMaterial(atThreshold), true);
});

test("the YoY overlay ignores stray backdated rows", () => {
  // The exact shape that lit up the old `some(prior > 0)` test: 26 weeks of
  // this year, two stray weeks of "last year" worth $220. That drew a full
  // dashed baseline pinned at ~$0 and read as 68x growth.
  const strays = Array.from({ length: 26 }, (_, i) => ({ prior_revenue: i < 2 ? 220 : 0 }));
  assert.equal(hasMeaningfulPriorYear(strays), false);

  // A genuine prior year does light it up.
  const realHistory = Array.from({ length: 26 }, () => ({ prior_revenue: 14000 }));
  assert.equal(hasMeaningfulPriorYear(realHistory), true);

  // Exactly half coverage is enough; just under is not.
  assert.equal(hasMeaningfulPriorYear(Array.from({ length: 26 }, (_, i) => ({ prior_revenue: i < 13 ? 100 : 0 }))), true);
  assert.equal(hasMeaningfulPriorYear(Array.from({ length: 26 }, (_, i) => ({ prior_revenue: i < 12 ? 100 : 0 }))), false);
  assert.equal(hasMeaningfulPriorYear([]), false);
});

// ── F. What someone is making per hour ───────────────────────────────────────

test("$/hr excludes mileage reimbursement and time-off pay", () => {
  // A week with holiday pay and approved mileage in it. Gross ÷ hours — what
  // the Summary tab used to print — reads $37.50/hr on 20 clocked hours. Only
  // $560 of that $750 was earned by working, so the honest rate is $28.00.
  const r = hourlyRate({
    commission: 500,
    additionalByType: { tips: 60, holiday_pay: 150, mileage_reimbursement: 40 },
    hoursWorked: 20,
  });
  assert.equal(r.numerator, 560);
  assert.equal(r.rate, 28);
  assert.equal(r.basis, "earned");

  // The naive figure this replaced, kept explicit so the gap can't be called a
  // rounding difference later.
  const gross = 500 + 60 + 150 + 40;
  assert.equal(round2(gross / 20), 37.5);
});

test("the commission basis is commission alone", () => {
  const r = hourlyRate({
    commission: 500,
    additionalByType: { tips: 60, holiday_pay: 150 },
    hoursWorked: 20,
    basis: "commission",
  });
  assert.equal(r.numerator, 500);
  assert.equal(r.rate, 25);
});

test("no clocked hours reports null, never $0.00/hr", () => {
  // A holiday-only week: real money, no hours. $0.00/hr would read as "she
  // earned nothing an hour"; the truth is that there is no rate to state.
  const r = hourlyRate({ commission: 0, additionalByType: { holiday_pay: 150 }, hoursWorked: 0 });
  assert.equal(r.rate, null);
  assert.equal(r.hours, 0);
});

test("pay from unclocked jobs is reported, not silently absorbed", () => {
  // Three jobs, one never clocked. Its $200 lands in the numerator with no
  // hours under it, so the printed rate is high by construction. The office
  // needs to see that it is looking at a missing clock-in, not a fast tech.
  const r = hourlyRate({ commission: 600, hoursWorked: 12, unclockedPay: 200 });
  assert.equal(r.rate, 50);
  assert.ok(r.unclocked_pay > 0, "unclocked pay must survive to the UI");
  assert.equal(r.unclocked_pay, 200);

  // With every job clocked, nothing to flag.
  assert.equal(hourlyRate({ commission: 600, hoursWorked: 12 }).unclocked_pay, 0);
});

test("a rate always carries the numerator and hours it used", () => {
  // Same property C asserts for labor ratios: a bare "$28.00/hr" is not
  // checkable, and unreconcilable numbers are what caused this work.
  const r = hourlyRate({ commission: 480.55, additionalByType: { tips: 25 }, hoursWorked: 18.25 });
  assert.equal(r.numerator, 505.55);
  assert.equal(r.hours, 18.25);
  assert.equal(r.rate, round2(505.55 / 18.25));
});

test("time-off and mileage type lists do not overlap", () => {
  // Both lists filter the same map. An overlap would mean a type's exclusion
  // depended on which list was consulted first.
  for (const t of TIME_OFF_PAY_TYPES) assert.ok(!MILEAGE_PAY_TYPES.includes(t), `${t} in both lists`);
});
