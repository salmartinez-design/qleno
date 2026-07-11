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

describe("occurrence weighting (PLAWA-covered = 0, unexcused = 1, NCNS = 2)", () => {
  it("a plain unexcused absence counts 1", () => {
    assert.equal(countUnexcusedOccurrences([{ type: "absent", protected: false }]), 1);
  });

  it("a PLAWA-covered (protected) absence counts 0 — no retaliation", () => {
    assert.equal(countUnexcusedOccurrences([{ type: "absent", protected: true }]), 0);
  });

  it("a No-Call/No-Show counts 2", () => {
    assert.equal(countUnexcusedOccurrences([{ type: "ncns", protected: false }]), NCNS_OCCURRENCE_WEIGHT);
  });

  it("an NCNS counts 2 even if flagged protected — a procedural violation is balance-independent", () => {
    assert.equal(countUnexcusedOccurrences([{ type: "ncns", protected: true }]), 2);
  });

  it("tardy rows are not part of the unexcused counter", () => {
    assert.equal(countUnexcusedOccurrences([{ type: "tardy", protected: false }]), 0);
  });

  it("mixes correctly: 2 unexcused + 1 protected + 1 NCNS = 4", () => {
    const count = countUnexcusedOccurrences([
      { type: "absent", protected: false },
      { type: "absent", protected: false },
      { type: "absent", protected: true }, // PLAWA-covered → 0
      { type: "ncns", protected: false }, // +2
    ]);
    assert.equal(count, 4);
  });

  it("one NCNS lands at the 2nd strike (Final) under the 1/2/3 ladder; two NCNS reach the 3rd (Termination)", () => {
    // The ladder itself is data (1/2/3); here we prove the occurrence MATH that
    // feeds it: 1 NCNS = 2 occ (→ step 2), 2 NCNS = 4 occ (≥ step 3).
    assert.equal(countUnexcusedOccurrences([{ type: "ncns", protected: false }]), 2);
    assert.equal(
      countUnexcusedOccurrences([
        { type: "ncns", protected: false },
        { type: "ncns", protected: false },
      ]),
      4,
    );
  });
});
