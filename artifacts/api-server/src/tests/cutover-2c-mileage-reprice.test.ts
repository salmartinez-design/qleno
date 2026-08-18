/**
 * Cutover 2C — mileage rate editor + re-pricing tests.
 *
 * Pure unit tests over planReprice, plus source-level assertions on the
 * route for the things that only exist as SQL.
 *
 * What this suite defends:
 *
 *   A. Dated rates win by date — a leg is re-priced at the rate in force
 *      on ITS day, not at the newest rate.
 *   B. Money math matches the compute engine — planReprice and the
 *      original compute path agree to the cent.
 *   C. Split legs are skipped, never guessed at — an even split spreads
 *      leftover pennies across the whole group, so a single leg cannot
 *      be re-priced alone.
 *   D. A date with no rate in force is skipped, not zeroed.
 *   E. Nothing already at the right number is rewritten.
 *   F. Route contract — only status='computed' legs are ever UPDATEd,
 *      the rate row and the leg updates share one transaction, and
 *      there is no PATCH (rates are append-only).
 *   G. Tenant scoping + role gating on every handler.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { planReprice, type RepriceLegInput } from "../lib/mileage-reprice.js";
import { computeAmountCents } from "../lib/mileage-compute.js";
import type { MileageRateRowInput } from "../lib/mileage-rate-lookup.js";

/** The real 2026 IRS history: opened at 72.5c, revised to 76c on July 1. */
const IRS_2026: MileageRateRowInput[] = [
  { rate: "0.7250", effective_date: "2026-01-01", end_date: null },
  { rate: "0.7600", effective_date: "2026-07-01", end_date: null },
];

const leg = (o: Partial<RepriceLegInput> & { id: number; leg_date: string }): RepriceLegInput => ({
  miles: "10.0",
  rate_per_mile: "0.7250",
  amount: "7.25",
  split_group_size: null,
  ...o,
});

describe("A. dated rates apply by the leg's own date", () => {
  it("re-prices a July leg to 0.76 and leaves a June leg on 0.725", () => {
    const plan = planReprice(
      [leg({ id: 1, leg_date: "2026-06-15" }), leg({ id: 2, leg_date: "2026-07-15" })],
      IRS_2026,
    );
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0]!.leg_id, 2);
    assert.equal(plan.changes[0]!.new_rate, 0.76);
    assert.equal(plan.skipped.already_correct, 1);
  });

  it("treats the effective date itself as in force (July 1, not July 2)", () => {
    const plan = planReprice([leg({ id: 1, leg_date: "2026-07-01" })], IRS_2026);
    assert.equal(plan.changes[0]!.new_rate, 0.76);
  });
});

describe("B. money matches the compute engine", () => {
  it("agrees with computeAmountCents to the cent", () => {
    const miles = 12.7;
    const plan = planReprice(
      [leg({ id: 1, leg_date: "2026-07-15", miles: String(miles) })],
      IRS_2026,
    );
    assert.equal(plan.changes[0]!.new_amount, computeAmountCents(miles, 0.76) / 100);
  });

  it("totals the delta across many legs without cent drift", () => {
    const legs = Array.from({ length: 100 }, (_, i) =>
      leg({ id: i + 1, leg_date: "2026-07-10", miles: "3.33", amount: "2.41" }),
    );
    const plan = planReprice(legs, IRS_2026);
    // 3.33mi * 0.76 = 2.5308 -> $2.53. Old stored 2.41. Delta 0.12 x 100.
    assert.equal(plan.changes.length, 100);
    assert.equal(plan.totals.new_amount, 253);
    assert.equal(plan.totals.old_amount, 241);
    assert.equal(plan.totals.delta, 12);
  });
});

describe("C. split legs are skipped, not guessed at", () => {
  it("never re-prices a leg that belongs to a carpool group", () => {
    const plan = planReprice(
      [leg({ id: 1, leg_date: "2026-07-15", split_group_size: 2 }), leg({ id: 2, leg_date: "2026-07-15" })],
      IRS_2026,
    );
    assert.equal(plan.skipped.split, 1);
    assert.deepEqual(plan.changes.map((c) => c.leg_id), [2]);
    // The skipped leg contributes nothing to the totals either.
    assert.equal(plan.totals.miles, 10);
  });
});

describe("D. a date with no rate in force is left alone", () => {
  it("skips rather than zeroing when the history starts later", () => {
    const plan = planReprice([leg({ id: 1, leg_date: "2025-12-31" })], IRS_2026);
    assert.equal(plan.skipped.no_rate, 1);
    assert.equal(plan.changes.length, 0);
    assert.equal(plan.totals.delta, 0);
  });

  it("honors end_date — a closed rate does not reach past its end", () => {
    const closed: MileageRateRowInput[] = [
      { rate: "0.7250", effective_date: "2026-01-01", end_date: "2026-06-30" },
    ];
    assert.equal(planReprice([leg({ id: 1, leg_date: "2026-07-15" })], closed).skipped.no_rate, 1);
    assert.equal(planReprice([leg({ id: 1, leg_date: "2026-06-15" })], closed).skipped.already_correct, 1);
  });
});

describe("E. nothing already correct is rewritten", () => {
  it("reports already_correct instead of a no-op change", () => {
    const plan = planReprice(
      [leg({ id: 1, leg_date: "2026-07-15", rate_per_mile: "0.7600", amount: "7.60" })],
      IRS_2026,
    );
    assert.equal(plan.changes.length, 0);
    assert.equal(plan.skipped.already_correct, 1);
  });

  it("still corrects an amount that disagrees with its own stored rate", () => {
    const plan = planReprice(
      [leg({ id: 1, leg_date: "2026-07-15", rate_per_mile: "0.7600", amount: "0.00" })],
      IRS_2026,
    );
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0]!.new_amount, 7.6);
  });
});

const ROUTE = readFileSync(
  path.join(import.meta.dirname, "../routes/mileage-rates.ts"),
  "utf8",
);

describe("F. route contract", () => {
  it("only ever UPDATEs legs still at status='computed'", () => {
    const updates = ROUTE.match(/UPDATE mileage_legs[\s\S]*?WHERE[^`]*/g) ?? [];
    assert.ok(updates.length > 0, "expected at least one mileage_legs UPDATE");
    for (const u of updates) {
      assert.match(u, /status = 'computed'/, "leg UPDATE must be bounded to computed legs");
      assert.match(u, /company_id = \$\{companyId\}/, "leg UPDATE must be company-scoped");
    }
  });

  it("writes the rate row and the leg updates in one transaction", () => {
    assert.match(ROUTE, /db\.transaction\(async \(tx\) => \{/);
    const tx = ROUTE.slice(ROUTE.indexOf("db.transaction"));
    assert.match(tx.slice(0, tx.indexOf("});")), /INSERT INTO mileage_rates[\s\S]*UPDATE mileage_legs/);
  });

  it("has no PATCH — rates are append-only", () => {
    assert.ok(!/router\.patch|router\.put/.test(ROUTE), "rates must not be editable in place");
  });

  it("refuses to delete a rate once anything is paid on or after it", () => {
    assert.match(ROUTE, /status IN \('reviewed', 'applied'\)/);
  });

  it("supports a dry run that writes nothing", () => {
    const dry = ROUTE.slice(ROUTE.indexOf("if (dry_run === true)"));
    const body = dry.slice(0, dry.indexOf("db.transaction"));
    assert.ok(!/INSERT|UPDATE|DELETE/.test(body), "dry run must not write");
  });
});

describe("G. scoping and roles", () => {
  it("scopes every query by company_id", () => {
    for (const stmt of ROUTE.match(/FROM (mileage_rates|mileage_legs)[\s\S]*?`/g) ?? []) {
      assert.match(stmt, /company_id = \$\{companyId\}/);
    }
  });

  it("gates reads to office leadership and writes to the owner", () => {
    assert.match(ROUTE, /router\.get\("\/", requireAuth, requireRole\("owner", "admin", "super_admin"\)/);
    assert.match(ROUTE, /router\.post\("\/", requireAuth, requireRole\("owner", "super_admin"\)/);
    assert.match(ROUTE, /router\.delete\("\/:id", requireAuth, requireRole\("owner", "super_admin"\)/);
  });
});
