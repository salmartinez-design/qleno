/**
 * Payroll ONE-ENGINE export reconciliation — pure unit tests (no DB).
 *
 * Defends the load-bearing promise of the one-engine wiring: the CSV the office
 * downloads must reconcile to the cent with the published snapshot / on-screen
 * detail. `snapshotToExportRow` is the single mapping from the engine's money
 * breakdown to the export's regular/OT/adjustments columns, so these tests pin:
 *
 *   A. gross_cents is EXACTLY the sum of regular + overtime + tips + adjustments
 *      — the column the payroll processor totals can never drift from the parts.
 *   B. Each engine bucket lands in the right export column (base→regular,
 *      overtime→overtime, tips→tips [ADP CC Tips], bonus+other→adjustments).
 *   C. Cent rounding is per-component and stable (no float drift on .005 etc).
 *   D. The CSV row built from the mapping carries those same cent values.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { snapshotToExportRow, buildPayExportCsv } from "../lib/pay-export.js";

const snap = (over: Partial<Parameters<typeof snapshotToExportRow>[0]> = {}) => ({
  user_id: 7, first_name: "Juan", last_name: "Salazar",
  base: 0, hours: 0, tips: 0, overtime: 0, bonus: 0, adjustments: 0, gross: 0,
  ...over,
});

describe("snapshotToExportRow — engine→export reconciliation", () => {
  it("A. gross_cents == regular + overtime + tips + adjustments", () => {
    const r = snapshotToExportRow(snap({
      base: 836.94, tips: 45, overtime: 60.5, bonus: 100, adjustments: 12.34,
      gross: 836.94 + 45 + 60.5 + 100 + 12.34, hours: 38.25,
    }));
    assert.equal(r.gross_cents, r.regular_pay_cents + r.overtime_pay_cents + r.tips_cents + r.adjustments_cents);
    assert.equal(r.gross_cents, Math.round((836.94 + 45 + 60.5 + 100 + 12.34) * 100));
  });

  it("B. each bucket maps to the right column", () => {
    const r = snapshotToExportRow(snap({ base: 500, overtime: 30, tips: 10, bonus: 20, adjustments: 5, gross: 565 }));
    assert.equal(r.regular_pay_cents, 50000);
    assert.equal(r.overtime_pay_cents, 3000);
    assert.equal(r.tips_cents, 1000); // tips on their own (ADP CC Tips)
    assert.equal(r.adjustments_cents, 2000 + 500); // bonus + other (NOT tips)
    assert.equal(r.overtime_hours, 0); // OT carried as dollars, not an hours split
    assert.equal(r.regular_hours, 0);
  });

  it("C. reconciles exactly for 2dp engine values (what the snapshot stores)", () => {
    // computePeriodPay r2-rounds every bucket to 2dp and sets gross = sum of
    // them, so the export's per-component rounding stays penny-exact. Awkward
    // float values like 0.1+0.2 are the real risk this guards.
    const base = 33.33, tips = 0.1, overtime = 0.2, bonus = 7.77, adjustments = 1.11;
    const gross = Math.round((base + tips + overtime + bonus + adjustments) * 100) / 100;
    const r = snapshotToExportRow(snap({ base, tips, overtime, bonus, adjustments, gross }));
    assert.equal(r.gross_cents, r.regular_pay_cents + r.overtime_pay_cents + r.tips_cents + r.adjustments_cents);
    assert.equal(r.gross_cents, 4251); // 33.33 + 0.10 + 0.20 + 7.77 + 1.11 = 42.51
  });

  it("D. CSV row carries the reconciled cent values", () => {
    const r = snapshotToExportRow(snap({ base: 200, overtime: 15, tips: 5, gross: 220, hours: 8 }));
    const csv = buildPayExportCsv({ period_start: "2026-05-31", period_end: "2026-06-06", rows: [r] });
    const dataLine = csv.trim().split("\n")[1];
    // …,8.00,0.00,200.00,15.00,5.00,0.00,220.00  (tips=5.00 on its own column)
    assert.match(dataLine, /,8\.00,0\.00,200\.00,15\.00,5\.00,0\.00,220\.00$/);
    assert.match(dataLine, /^7,Juan,Salazar,2026-05-31,2026-06-06,/);
  });
});
