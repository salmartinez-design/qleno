/**
 * @workspace/training — answer-key
 *
 * Server-authoritative answer key. The Express API uses this for scoring
 * quiz submissions; it never trusts the value the client claims is correct.
 *
 * This file is INTENTIONALLY a duplicate of the answer key in
 * @workspace/lms-curriculum. The redundancy exists so that:
 *
 *   1. A bug or compromise in the curriculum bundle (which ships to the
 *      client) cannot silently shift the server's pass/fail boundary.
 *   2. A drift-sync test (in api-server) compares this file to the
 *      curriculum bank on every CI run; if they disagree, the test fails
 *      and the build does not ship.
 *
 * RULE: any change to a question's correctIndex MUST update both this file
 * and @workspace/lms-curriculum's ANSWER_KEY in the same commit. The
 * drift-sync test will block the merge otherwise.
 */

/**
 * Question id → 0-based correct option index.
 *
 * Sorted by module for readability. The drift test does not depend on the
 * order of keys — it compares the maps as sets of (key, value) pairs.
 */
export const SERVER_ANSWER_KEY: Readonly<Record<string, number>> = Object.freeze({
  // welcome
  "q-scope-oven": 1,

  // attendance
  "q-running-late": 2,
  "q-sick-tomorrow": 2,
  "q-pto-request": 1,
  "q-unexcused-fourth": 2,

  // dress-code
  "q-shoe-covers": 2,
  "q-uniform-forgot": 2,

  // compensation
  "q-fixit": 2,
  "q-hourly-overrun": 1,
  "q-comm-split": 2,
  "q-commercial-early": 1,

  // cleaning-standards
  "q-room-flow": 1,
  "q-room-order": 2,
  "q-supplies-left": 1,
  "q-team-arrival": 1,
  "q-sardone-direction": 1,
  "q-sardone-dwell": 1,
  "q-sardone-load": 1,
  "q-sardone-spattern": 2,
  "q-sardone-backout": 1,
  "q-sardone-standard": 1,

  // products-tools
  "q-products-granite": 2,
  "q-products-mop": 1,
  "q-products-glass": 2,
  "q-products-simplegreen": 2,

  // maidcentral
  "q-clock-vs-check": 1,
  "q-tier-conflict": 2,
  "q-gps-checkin": 1,
  "q-mc-arrive": 1,
  "q-mc-individual-clocks": 2,
  "q-mc-gps-distance": 1,
  "q-mc-efficiency": 1,
  "q-mc-forgot-checkout": 2,
  "q-mc-travel-pay": 1,
  "q-mc-commercial-1of3": 1,
});

/**
 * Look up an expected answer. Returns null for unknown question ids — the
 * caller (scoring) treats unknown questions as incorrect.
 */
export function expectedAnswer(questionId: string): number | null {
  const v = SERVER_ANSWER_KEY[questionId];
  return v == null ? null : v;
}
