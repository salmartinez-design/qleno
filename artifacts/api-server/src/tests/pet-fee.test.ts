/**
 * Pet Fee unit tests — pure math for the optional pets surcharge.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:petfee
 *   (or: npx tsx --test src/tests/pet-fee.test.ts)
 *
 * No DB required — computePetFee is a pure function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePetFee, petFeeConfigFromRow } from "../lib/pet-fee.ts";

test("disabled config → no fee, even with pets", () => {
  assert.equal(computePetFee({ enabled: false, type: "flat", amount: 25 }, 2, 608), 0);
});

test("enabled but zero pets → no fee", () => {
  assert.equal(computePetFee({ enabled: true, type: "flat", amount: 25 }, 0, 608), 0);
});

test("flat fee → adds the flat amount once when pets > 0", () => {
  assert.equal(computePetFee({ enabled: true, type: "flat", amount: 25 }, 1, 608), 25);
  assert.equal(computePetFee({ enabled: true, type: "flat", amount: 25 }, 3, 608), 25); // flat, not per-pet
});

test("percent fee → percentage of base price, rounded to cents", () => {
  assert.equal(computePetFee({ enabled: true, type: "percent", amount: 10 }, 1, 608), 60.8);
  assert.equal(computePetFee({ enabled: true, type: "percent", amount: 7.5 }, 2, 693), 51.98); // 51.975 → 51.98
});

test("zero / negative amount → no fee", () => {
  assert.equal(computePetFee({ enabled: true, type: "flat", amount: 0 }, 2, 608), 0);
  assert.equal(computePetFee({ enabled: true, type: "percent", amount: -5 }, 2, 608), 0);
});

test("null config → no fee", () => {
  assert.equal(computePetFee(null, 2, 608), 0);
});

test("petFeeConfigFromRow → defaults to disabled/flat/0", () => {
  assert.deepEqual(petFeeConfigFromRow({}), { enabled: false, type: "flat", amount: 0 });
  assert.deepEqual(
    petFeeConfigFromRow({ pet_fee_enabled: true, pet_fee_type: "percent", pet_fee_amount: "12.5" }),
    { enabled: true, type: "percent", amount: 12.5 },
  );
  // guards a bad type string
  assert.equal(petFeeConfigFromRow({ pet_fee_type: "garbage" }).type, "flat");
});
