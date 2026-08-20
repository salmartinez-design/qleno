/**
 * [card-save-truth 2026-08-20] The words the office reads to a customer.
 *
 * Maribel was shown Square's own wording, "Invalid card data.", while Peak
 * Wongcharoen was still on the phone. It does not say whether to re-read the
 * digits, ask for the zip, or ask for a different card, so the call ended with
 * nothing saved and a callback to make.
 *
 * These tests pin the two things that matter about the replacement text:
 *   1. every code we know about says what to DO next, and
 *   2. a code we have never seen still falls through to Square's own detail
 *      instead of a blank string.
 *
 * Run:
 *   npx tsx --test src/tests/square-card-error-copy.test.ts
 *
 * No DB and no network — explainSquareCardError is a pure function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainSquareCardError } from "../lib/square-card-error-copy.js";

// The exact code Square returned on both of Peak Wongcharoen's attempts.
test("INVALID_CARD_DATA no longer echoes Square's dead-end wording", () => {
  const msg = explainSquareCardError("INVALID_CARD_DATA", "Invalid card data.");
  assert.notEqual(msg, "Invalid card data.");
  assert.match(msg, /different card/i);
  assert.match(msg, /zip code/i);
});

test("every known code tells the office what to do next", () => {
  const codes = [
    "INVALID_CARD_DATA", "INVALID_CARD", "INVALID_ACCOUNT",
    "CARD_EXPIRED", "INVALID_EXPIRATION", "INVALID_EXPIRATION_DATE", "INVALID_EXPIRATION_YEAR",
    "VERIFY_CVV_FAILURE", "VERIFY_AVS_FAILURE", "INVALID_POSTAL_CODE",
    "CARD_DECLINED", "CARD_DECLINED_VERIFICATION_REQUIRED", "GENERIC_DECLINE", "INSUFFICIENT_FUNDS",
    "CARD_NOT_SUPPORTED", "CARD_TOKEN_EXPIRED", "CARD_TOKEN_USED",
    "UNAUTHORIZED", "FORBIDDEN",
  ];
  for (const code of codes) {
    const msg = explainSquareCardError(code, "raw square detail");
    assert.notEqual(msg, "raw square detail", `${code} fell through to the raw detail`);
    // An action verb aimed at the person on the call.
    assert.match(msg, /\b(Ask|Check|Read|Close|Tell)\b/, `${code} does not name a next step`);
    assert.ok(msg.length > 20, `${code} message is too thin to read out loud`);
  }
});

test("an unknown code keeps Square's own detail rather than going blank", () => {
  assert.equal(explainSquareCardError("SOME_NEW_CODE_2027", "Something specific."), "Something specific.");
  assert.equal(explainSquareCardError(null, "Something specific."), "Something specific.");
});

test("a very long detail is trimmed so it stays readable", () => {
  const long = "x".repeat(900);
  assert.equal(explainSquareCardError(null, long).length, 300);
});

// No em dashes: this text is read out loud and pasted into customer notes.
test("no em or en dashes in any message", () => {
  const codes = ["INVALID_CARD_DATA", "CARD_EXPIRED", "VERIFY_CVV_FAILURE", "VERIFY_AVS_FAILURE", "CARD_DECLINED", "CARD_NOT_SUPPORTED", "CARD_TOKEN_EXPIRED", "UNAUTHORIZED"];
  for (const code of codes) {
    const msg = explainSquareCardError(code, "d");
    assert.ok(!msg.includes("—") && !msg.includes("–"), `${code} contains a dash character`);
  }
});
