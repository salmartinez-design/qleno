/**
 * Tip allocation tests (lib/tip-split.ts).
 *
 * Defends the locked split decision: a tip is apportioned by each tech's
 * ACTUAL clocked hours (mirrors commission), cents are never lost, and no
 * clean divide silently drops a tech. Edge cases: nobody clocked → even;
 * mixed clocked/unclocked → only the clocked techs share.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTipSplit } from "../lib/tip-split.js";

const sum = (a: { amount: number }[]) => Math.round(a.reduce((s, x) => s + x.amount, 0) * 100) / 100;

describe("computeTipSplit", () => {
  it("splits proportional to clocked hours", () => {
    // 3h vs 1h on a $40 tip → $30 / $10.
    const out = computeTipSplit(40, [
      { user_id: 1, is_primary: true, hours: 3 },
      { user_id: 2, is_primary: false, hours: 1 },
    ]);
    assert.deepEqual(out, [
      { user_id: 1, amount: 30 },
      { user_id: 2, amount: 10 },
    ]);
  });

  it("longer time on site gets the bigger share", () => {
    const out = computeTipSplit(50, [
      { user_id: 1, is_primary: true, hours: 2 },
      { user_id: 2, is_primary: false, hours: 3 },
    ]);
    const a = out.find((x) => x.user_id === 1)!;
    const b = out.find((x) => x.user_id === 2)!;
    assert.ok(b.amount > a.amount);
    assert.equal(sum(out), 50);
  });

  it("a tech who clocked 0 minutes gets $0 when others clocked", () => {
    const out = computeTipSplit(30, [
      { user_id: 1, is_primary: true, hours: 2 },
      { user_id: 2, is_primary: false, hours: 0 },
    ]);
    assert.deepEqual(out, [{ user_id: 1, amount: 30 }]);
  });

  it("nobody clocked → even split across all techs", () => {
    const out = computeTipSplit(30, [
      { user_id: 1, is_primary: true, hours: 0 },
      { user_id: 2, is_primary: false, hours: 0 },
      { user_id: 3, is_primary: false, hours: 0 },
    ]);
    assert.deepEqual(out, [
      { user_id: 1, amount: 10 },
      { user_id: 2, amount: 10 },
      { user_id: 3, amount: 10 },
    ]);
  });

  it("never loses a cent — remainder goes to the longest/primary tech", () => {
    // $10 across 3 equal-hours techs = 333/333/333 = 999, +1 remainder cent.
    const out = computeTipSplit(10, [
      { user_id: 1, is_primary: true, hours: 1 },
      { user_id: 2, is_primary: false, hours: 1 },
      { user_id: 3, is_primary: false, hours: 1 },
    ]);
    assert.equal(sum(out), 10); // no cents lost
    const anchor = out.find((x) => x.user_id === 1)!; // primary on the hours tie
    assert.equal(anchor.amount, 3.34);
  });

  it("remainder anchor is the longest tech, not the primary, when hours differ", () => {
    // $10, hours 1 (primary) vs 2 → 333 / 666 = 999, remainder cent to #2 (longest).
    const out = computeTipSplit(10, [
      { user_id: 1, is_primary: true, hours: 1 },
      { user_id: 2, is_primary: false, hours: 2 },
    ]);
    assert.equal(sum(out), 10);
    assert.equal(out.find((x) => x.user_id === 2)!.amount, 6.67);
  });

  it("single tech takes the whole tip", () => {
    assert.deepEqual(computeTipSplit(25, [{ user_id: 9, is_primary: true, hours: 2.5 }]), [
      { user_id: 9, amount: 25 },
    ]);
  });

  it("zero / negative / empty → no allocation", () => {
    assert.deepEqual(computeTipSplit(0, [{ user_id: 1, is_primary: true, hours: 2 }]), []);
    assert.deepEqual(computeTipSplit(-5, [{ user_id: 1, is_primary: true, hours: 2 }]), []);
    assert.deepEqual(computeTipSplit(20, []), []);
  });
});
