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
 *
 * Restructure 2026-05-09: 5 modules × 15 quiz questions = 75 entries.
 */

/**
 * Question id → 0-based correct option index.
 *
 * Sorted by module for readability. The drift test does not depend on the
 * order of keys — it compares the maps as sets of (key, value) pairs.
 */
export const SERVER_ANSWER_KEY: Readonly<Record<string, number>> = Object.freeze({
  // ── Module 1: phes-policies (34, four-bucket policy 2026-05-12) ──────────
  "q-pp-01-w2": 1,
  "q-pp-02-guarantee": 2,
  "q-pp-03-scope-oven": 1,
  "q-pp-04-bodily-fluids": 1,
  "q-pp-05-tipping": 1,
  "q-pp-06-running-late": 2,
  "q-pp-07-grace-window": 2,
  "q-pp-08-tardy-progression": 2,
  "q-pp-09-sick-tomorrow": 1,
  "q-pp-10-pto-request": 1,
  "q-pp-11-unexcused-fourth": 2,
  "q-pp-12-uniform-forgot": 2,
  "q-pp-13-shoe-covers": 2,
  "q-pp-14-phone-use": 2,
  "q-pp-15-photos": 2,
  "q-pp-16-dishes-beds": 1,
  "q-pp-17-office-exception": 1,
  "q-pp-18-bereavement": 1,
  "q-pp-19-jury-duty": 1,
  "q-pp-20-lactation": 1,
  "q-pp-21-pto-cap": 1,
  "q-pp-22-separation-payout": 1,
  "q-pp-23-holiday-90day": 1,
  "q-pp-24-sick-doc": 1,
  "q-pp-25-sick-no-balance": 0,
  "q-pp-26-unpaid-personal": 1,
  "q-pp-27-bucket-order": 1,
  "q-pp-28-unexcused-definition": 1,
  "q-pp-29-plawa-denial": 1,
  "q-pp-30-plawa-no-discipline": 0,
  "q-pp-31-plawa-default": 1,
  "q-pp-32-notice-by-bucket": 1,
  "q-pp-33-plawa-reason": 1,
  "q-pp-34-unpaid-absence-allowance": 1,

  // ── Module 2: compensation ───────────────────────────────────────────────
  "q-cm-01-training-pay": 1,
  "q-cm-02-standard-rate": 2,
  "q-cm-03-deep-clean-rate": 1,
  "q-cm-04-move-in-rate": 1,
  "q-cm-05-comm-split-200": 2,
  "q-cm-06-deep-split-300": 1,
  "q-cm-07-clock-in-difference": 1,
  "q-cm-08-hourly-overrun": 1,
  "q-cm-09-commercial-rate": 2,
  "q-cm-10-commercial-early": 1,
  "q-cm-11-fixit": 1,
  "q-cm-12-quality-probation": 1,
  "q-cm-13-probation-pay": 1,
  "q-cm-14-mileage": 2,
  "q-cm-15-payroll-cycle": 1,

  // ── Module 3: cleaning-best-practices ────────────────────────────────────
  "q-cb-01-room-flow": 1,
  "q-cb-02-room-order": 2,
  "q-cb-03-direction": 1,
  "q-cb-04-dwell": 1,
  "q-cb-05-load-caddy": 1,
  "q-cb-06-spattern": 2,
  "q-cb-07-backout-mop": 1,
  "q-cb-08-standard-not-time": 1,
  "q-cb-09-vacuum-before-mop": 1,
  "q-cb-10-team-arrival": 1,
  "q-cb-11-supplies-left": 1,
  "q-cb-12-color-cloths": 0,
  "q-cb-13-two-hand": 1,
  "q-cb-14-dont-backtrack": 1,
  "q-cb-15-conflict-worksheet-note": 2,

  // ── Module 4: maidcentral ────────────────────────────────────────────────
  "q-mc-01-clock-vs-check": 1,
  "q-mc-02-arrive-first-job": 1,
  "q-mc-03-individual-clocks": 2,
  "q-mc-04-gps-distance": 1,
  "q-mc-05-600-feet": 2,
  "q-mc-06-efficiency": 1,
  "q-mc-07-efficiency-target": 2,
  "q-mc-08-forgot-checkout": 2,
  "q-mc-09-travel-pay": 1,
  "q-mc-10-commute-not-paid": 1,
  "q-mc-11-end-of-day": 1,
  "q-mc-12-conflict-note": 1,
  "q-mc-13-commercial-finished-early": 1,
  "q-mc-14-qleno-coming": 1,
  "q-mc-15-day-clock-running": 1,

  // ── Module 5: products-tools ─────────────────────────────────────────────
  "q-pt-01-granite": 2,
  "q-pt-02-mop": 1,
  "q-pt-03-glass": 2,
  "q-pt-04-simplegreen": 2,
  "q-pt-05-zep-bleach": 2,
  "q-pt-06-zep-fabric": 1,
  "q-pt-07-magic-eraser-paint": 1,
  "q-pt-08-magic-eraser-glass": 2,
  "q-pt-09-pumice-where": 0,
  "q-pt-10-pumice-wet": 2,
  "q-pt-11-steel-wool-grade": 3,
  "q-pt-12-steel-wool-chrome": 1,
  "q-pt-13-cloth-cross": 1,
  "q-pt-14-step-stool": 1,
  "q-pt-15-furniture-stand": 2,

  // ── Module 6: sexual-harassment-prevention (10, IHRA 2026-05-12) ────────
  "q-sh-01-definition": 1,
  "q-sh-02-client-harassment": 1,
  "q-sh-03-quid-pro-quo": 1,
  "q-sh-04-who-to-report": 1,
  "q-sh-05-retaliation": 1,
  "q-sh-06-external-agencies": 2,
  "q-sh-07-zero-tolerance": 0,
  "q-sh-08-protected-groups": 2,
  "q-sh-09-witness": 1,
  "q-sh-10-borderline": 2,
});

/**
 * Look up an expected answer. Returns null for unknown question ids — the
 * caller (scoring) treats unknown questions as incorrect.
 */
export function expectedAnswer(questionId: string): number | null {
  const v = SERVER_ANSWER_KEY[questionId];
  return v == null ? null : v;
}
