// [PLAWA compliance 2026-07-11] Pure tests for the two attendance-compliance
// rules — no DB. Run:
//   DATABASE_URL=postgres://stub@stub/stub tsx --test src/tests/plawa-attendance.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPlawaMinimumIncrement,
  countUnexcusedOccurrences,
  MIN_PLAWA_INCREMENT_HOURS,
  NCNS_OCCURRENCE_WEIGHT,
} from "../lib/attendance-compliance.js";

describe("PLAWA 2-hour minimum increment", () => {
  it("floors a sub-2h PLAWA deduction up to 2h", () => {
    assert.equal(applyPlawaMinimumIncrement("plawa", 1), 2);
    assert.equal(applyPlawaMinimumIncrement("plawa", 0.5), MIN_PLAWA_INCREMENT_HOURS);
  });

  it("leaves a PLAWA deduction of 2h or more untouched", () => {
    assert.equal(applyPlawaMinimumIncrement("plawa", 2), 2);
    assert.equal(applyPlawaMinimumIncrement("plawa", 3.5), 3.5);
  });

  it("only floors PLAWA — PTO and other buckets pass through", () => {
    assert.equal(applyPlawaMinimumIncrement("pto_phes", 1), 1);
    assert.equal(applyPlawaMinimumIncrement("unpaid_leave", 0.5), 0.5);
  });

  it("drops the floor to the shift length when the scheduled shift is under 2h", () => {
    // 1h call-off on a 1.5h shift → can't require more than the shift.
    assert.equal(applyPlawaMinimumIncrement("plawa", 1, 1.5), 1.5);
  });

  it("still floors to 2h when the shift is 2h or longer", () => {
    assert.equal(applyPlawaMinimumIncrement("plawa", 1, 3), 2);
    assert.equal(applyPlawaMinimumIncrement("plawa", 1, 2), 2);
  });

  it("returns non-positive requests unchanged (nothing to floor)", () => {
    assert.equal(applyPlawaMinimumIncrement("plawa", 0), 0);
  });
});

describe("occurrence weighting (PLAWA-covered = 0, unexcused = 1, NCNS = 1)", () => {
  it("a plain unexcused absence counts 1", () => {
    assert.equal(countUnexcusedOccurrences([{ type: "absent", protected: false }]), 1);
  });

  it("a PLAWA-covered (protected) absence counts 0 — no retaliation", () => {
    assert.equal(countUnexcusedOccurrences([{ type: "absent", protected: true }]), 0);
  });

  it("a No-Call/No-Show counts 1 — same as a plain unexcused absence", () => {
    assert.equal(countUnexcusedOccurrences([{ type: "ncns", protected: false }]), NCNS_OCCURRENCE_WEIGHT);
  });

  it("an NCNS counts 1 even if flagged protected — a procedural violation is balance-independent", () => {
    // [ncns-weight 2026-08-21] The weight dropped 2 -> 1; the
    // balance-independence did not change.
    assert.equal(countUnexcusedOccurrences([{ type: "ncns", protected: true }]), 1);
  });

  it("tardy rows are not part of the unexcused counter", () => {
    assert.equal(countUnexcusedOccurrences([{ type: "tardy", protected: false }]), 0);
  });

  it("mixes correctly: 2 unexcused + 1 protected + 1 NCNS = 3", () => {
    const count = countUnexcusedOccurrences([
      { type: "absent", protected: false },
      { type: "absent", protected: false },
      { type: "absent", protected: true }, // PLAWA-covered → 0
      { type: "ncns", protected: false }, // +1
    ]);
    assert.equal(count, 3);
  });

  it("each NCNS advances the ladder exactly one rung, like any unexcused day", () => {
    // The ladder itself is tenant data (companies 1 and 4 are currently
    // 3=written, 4=final, 5=termination); here we prove only the occurrence
    // MATH that feeds it. [ncns-weight 2026-08-21] 1 NCNS = 1 occ, not 2, so
    // it takes three no-shows to reach a written warning — and a true
    // no-call/no-show remains the office's call to fire, not Qleno's.
    assert.equal(countUnexcusedOccurrences([{ type: "ncns", protected: false }]), 1);
    assert.equal(
      countUnexcusedOccurrences([
        { type: "ncns", protected: false },
        { type: "ncns", protected: false },
      ]),
      2,
    );
  });
});
