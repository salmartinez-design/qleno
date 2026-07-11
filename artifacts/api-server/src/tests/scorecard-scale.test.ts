// [scorecard-scale 2026-07-11] Pure tests for the 0-4 canonicalization used by
// the audit + backfill. No DB. Run:
//   DATABASE_URL=postgres://stub@stub/stub tsx --test src/tests/scorecard-scale.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalRating, isMisScaledScore } from "../lib/scorecard-scale.js";

describe("canonicalRating — resolve any row to the 0-4 rating", () => {
  it("prefers the explicit rating column", () => {
    assert.equal(canonicalRating({ score: 40, rating: 2, weight: 0.4 }), 2);
    assert.equal(canonicalRating({ score: 100, rating: 4, weight: 1 }), 4);
  });

  it("passes through a score already on the 0-4 scale (seed rows)", () => {
    assert.equal(canonicalRating({ score: 4, rating: null, weight: null }), 4);
    assert.equal(canonicalRating({ score: 2, rating: null }), 2);
  });

  it("reverse-maps from weight when rating is missing", () => {
    assert.equal(canonicalRating({ score: 40, rating: null, weight: 0.4 }), 2);
    assert.equal(canonicalRating({ score: 75, rating: null, weight: 0.75 }), 3);
    assert.equal(canonicalRating({ score: 0, rating: null, weight: 0 }), 1);
  });

  it("reverse-maps from a legacy 0-100 score when rating and weight are missing", () => {
    assert.equal(canonicalRating({ score: 100 }), 4);
    assert.equal(canonicalRating({ score: 75 }), 3);
    assert.equal(canonicalRating({ score: 40 }), 2); // "A Few Concerns" — must NOT read as top marks
    assert.equal(canonicalRating({ score: 0 }), 1);
  });

  it("returns null when there is nothing to resolve", () => {
    assert.equal(canonicalRating({ score: null, rating: null, weight: null }), null);
  });
});

describe("isMisScaledScore — flag rows that need backfill", () => {
  it("flags a 0-100 score", () => {
    assert.equal(isMisScaledScore({ score: 40 }), true);
    assert.equal(isMisScaledScore({ score: 100 }), true);
  });

  it("does not flag a correct 0-4 score", () => {
    assert.equal(isMisScaledScore({ score: 4 }), false);
    assert.equal(isMisScaledScore({ score: 2 }), false);
    assert.equal(isMisScaledScore({ score: 0 }), false);
    assert.equal(isMisScaledScore({ score: null }), false);
  });

  it("the reported bug: 'A Few Concerns' stored as 40 is mis-scaled and resolves to rating 2, not a green 4", () => {
    const row = { score: 40, rating: 2, weight: 0.4 };
    assert.equal(isMisScaledScore(row), true);
    assert.equal(canonicalRating(row), 2);
  });
});
