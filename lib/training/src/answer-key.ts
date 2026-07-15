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
  "q-pp-01-w2": 0,
  "q-pp-02-guarantee": 3,
  "q-pp-03-scope-oven": 0,
  "q-pp-04-bodily-fluids": 1,
  "q-pp-05-tipping": 2,
  "q-pp-06-running-late": 3,
  "q-pp-07-grace-window": 0,
  "q-pp-08-tardy-progression": 1,
  "q-pp-09-sick-tomorrow": 2,
  "q-pp-10-pto-request": 3,
  "q-pp-11-unexcused-fourth": 0,
  "q-pp-12-pto-plawa-distinct": 1,
  "q-pp-13-emergency-911": 2,
  "q-pp-14-phone-use": 3,
  "q-pp-15-photos": 0,
  "q-pp-16-dishes-beds": 1,
  "q-pp-17-office-exception": 2,
  "q-pp-18-bereavement": 3,
  "q-pp-19-jury-duty": 0,
  "q-pp-20-lactation": 1,
  "q-pp-21-pto-cap": 2,
  "q-pp-22-separation-payout": 3,
  "q-pp-23-holiday-90day": 0,
  "q-pp-24-add-on-pricing": 1,
  "q-pp-25-sick-no-balance": 2,
  "q-pp-26-unpaid-personal": 3,
  "q-pp-27-bucket-order": 0,
  "q-pp-28-unexcused-definition": 1,
  "q-pp-29-plawa-denial": 2,
  "q-pp-30-move-in-empty": 3,
  "q-pp-31-plawa-default": 0,
  "q-pp-32-notice-by-bucket": 1,
  "q-pp-33-plawa-reason": 2,
  "q-pp-34-protected-still-excused": 3,
  "q-pp-35-deep-clean-includes": 0,
  "q-pp-36-deep-clean-excludes": 1,
  "q-pp-37-deep-clean-windows": 2,
  "q-pp-38-heavy-furniture-25lb": 3,
  "q-pp-39-trash-bag-limit": 0,
  "q-pp-40-no-price-discussion": 1,
  "q-pp-41-parking": 2,
  "q-pp-42-supply-maintenance": 3,
  "q-pp-43-ncns": 0,
  "q-pp-44-plawa-increment": 1,
  // E3: PLAWA day-1 grant (2026-07-15)
  "q-pp-plawa-grant": 2,
  // K: meal break entitlement (2026-07-15)
  "q-pp-meal-break": 3,

  // ── Module 2: compensation (16, alignment 2026-05-21) ────────────────────
  // Mirror of curriculum ANSWER_KEY. Drift-sync test verifies they match.
  "q-cm-01-training-pay": 0,
  "q-cm-02-standard-rate": 2,
  "q-cm-03-deep-clean-rate": 3,
  "q-cm-05-comm-split-200": 0,
  "q-cm-07-clock-in-difference": 1,
  "q-cm-08-hourly-overrun": 2,
  "q-cm-09-commercial-rate": 3,
  "q-cm-11-fixit": 0,
  "q-cm-12-quality-probation": 1,
  "q-cm-13-probation-pay": 2,
  "q-cm-14-mileage": 3,
  "q-cm-15-payroll-cycle": 0,
  "q-cm-16-allowed-hours-math": 1,
  "q-cm-17-recovery-tech-three-hour": 2,
  "q-cm-18-valid-quality-complaint": 3,
  "q-cm-19-refused-reclean-eighteen": 0,
  "q-cm-20-training-redo-paid": 1,
  "q-cm-21-fix-it-mileage": 2,
  // E2: paper-check option (2026-07-15)
  "q-cm-paycheck-method": 3,

  // ── Module 3: cleaning-best-practices ────────────────────────────────────
  "q-cb-01-room-flow": 0,
  "q-cb-02-room-order": 2,
  "q-cb-03-direction": 3,
  "q-cb-04-dwell": 0,
  "q-cb-05-load-caddy": 1,
  "q-cb-06-spattern": 2,
  "q-cb-07-backout-mop": 3,
  "q-cb-08-standard-not-time": 0,
  "q-cb-09-vacuum-before-mop": 1,
  "q-cb-10-team-arrival": 2,
  "q-cb-11-supplies-left": 3,
  "q-cb-12-color-cloths": 0,
  "q-cb-13-two-hand": 1,
  "q-cb-14-dont-backtrack": 2,
  "q-cb-15-conflict-worksheet-note": 3,

  // ── Module 4: maidcentral ────────────────────────────────────────────────
  "q-mc-01-clock-vs-check": 0,
  "q-mc-02-arrive-first-job": 1,
  "q-mc-03-individual-clocks": 2,
  "q-mc-04-gps-distance": 3,
  "q-mc-05-600-feet": 0,
  "q-mc-06-efficiency": 1,
  "q-mc-07-efficiency-target": 2,
  "q-mc-08-forgot-checkout": 3,
  "q-mc-09-travel-pay": 0,
  "q-mc-10-commute-not-paid": 1,
  "q-mc-11-end-of-day": 2,
  "q-mc-12-conflict-note": 3,
  "q-mc-13-commercial-finished-early": 0,
  "q-mc-14-qleno-coming": 1,
  "q-mc-15-day-clock-running": 2,
  // E1: Qleno rebrand additions (2026-07-15)
  "q-mc-qleno-system": 3,
  "q-mc-qleno-arrival": 0,
  "q-mc-qleno-gps": 1,
  "q-mc-qleno-down": 2,
  "q-mc-qleno-fix": 3,

  // ── Module 5: products-tools ─────────────────────────────────────────────
  "q-pt-01-granite": 0,
  "q-pt-02-mop": 2,
  "q-pt-03-glass": 3,
  "q-pt-04-simplegreen": 0,
  "q-pt-05-zep-bleach": 1,
  "q-pt-06-zep-fabric": 2,
  "q-pt-07-magic-eraser-paint": 3,
  "q-pt-08-magic-eraser-glass": 0,
  "q-pt-09-pumice-where": 1,
  "q-pt-10-pumice-wet": 2,
  "q-pt-11-steel-wool-grade": 3,
  "q-pt-12-steel-wool-chrome": 0,
  "q-pt-13-cloth-cross": 1,
  "q-pt-14-step-stool": 2,
  "q-pt-15-furniture-stand": 3,

  // ── Module 6: il-sexual-harassment (15, IL 820 ILCS 96 annual training) ───
  "q-il-01-definition": 0,
  "q-il-02-quid-pro-quo": 2,
  "q-il-03-hostile-environment": 3,
  "q-il-04-not-limited-by-sex": 0,
  "q-il-05-third-party": 1,
  "q-il-06-reporting-channels": 2,
  "q-il-07-retaliation": 3,
  "q-il-08-bystander-duty": 0,
  "q-il-09-idhr-deadline": 1,
  "q-il-10-eeoc-deadline": 2,
  "q-il-11-annual-retraining": 3,
  "q-il-12-severe-or-pervasive": 0,
  "q-il-13-consent-withdrawn": 1,
  "q-il-14-investigation-rights": 2,
  "q-il-15-good-faith-protection": 3,

  // ── Module 7: drug-alcohol (10, Phase 3 PR #4) ─────────────────────────
  "q-da-01-no-pre-employment-test": 0,
  "q-da-02-impairment-not-cannabis-use": 3,
  "q-da-03-impairment-signs": 0,
  "q-da-04-reasonable-suspicion-process": 1,
  "q-da-05-post-accident-threshold": 2,
  "q-da-06-prescription-meds": 3,
  "q-da-07-refusal-to-test": 0,
  "q-da-08-discipline-scale": 1,
  "q-da-09-dui-reporting-window": 2,
  "q-da-10-license-suspension-disclosure": 3,

  // ── Module 8: code-of-conduct (10, Phase 4 PR #5) ──────────────────────
  "q-coc-01-honesty": 0,
  "q-coc-02-confidentiality": 3,
  "q-coc-03-theft-zero-tolerance": 0,
  "q-coc-04-harassment-reporting": 1,
  "q-coc-05-protected-classes": 2,
  "q-coc-06-retaliation-good-faith": 3,
  "q-coc-07-conflict-of-interest": 0,
  "q-coc-08-key-handling": 1,
  "q-coc-09-cooperation-investigation": 2,
  "q-coc-10-reporting-channels": 3,

  // ── Module 9: video-photo-release (9, Phase 5 PR #6) ───────────────────
  "q-vpr-01-voluntary": 3,
  "q-vpr-02-5-year-limit": 0,
  "q-vpr-03-ai-carve-out": 1,
  "q-vpr-04-withdrawal-30-day": 2,
  "q-vpr-05-third-party-limits": 3,
  "q-vpr-06-il-right-of-publicity": 0,
  "q-vpr-07-co-signature": 1,
  "q-vpr-08-courtesy-preview": 2,
  "q-vpr-09-active-distribution": 3,

  // ── Module 10: non-solicitation (10, Phase 6 PR #7) ────────────────────
  "q-ns-01-clients-not-coworkers": 3,
  "q-ns-02-12-month-duration": 0,
  "q-ns-03-what-counts-as-solicit": 1,
  "q-ns-04-general-advertising-ok": 2,
  "q-ns-05-il-freedom-to-work": 3,
  "q-ns-06-during-employment-too": 0,
  "q-ns-07-consideration": 1,
  "q-ns-08-remedy-injunctive": 2,
  "q-ns-09-co-signature": 3,
  "q-ns-10-inbound-clients-exception": 0,
  // Phase 6.5 amendment — added q-ns-11/12/13.
  "q-ns-11-direct-payment-prohibition": 1,
  "q-ns-12-trade-secret-confidentiality": 2,
  "q-ns-13-trade-secret-vs-section-7": 3,

  // ── Module 11: social-media (10, Phase 7 PR #8) ────────────────────────
  "q-sm-01-client-confidentiality": 0,
  "q-sm-02-nlra-section-7": 3,
  "q-sm-03-off-duty-private": 0,
  "q-sm-04-uniform-misuse": 1,
  "q-sm-05-client-solicitation": 2,
  "q-sm-06-disparagement": 3,
  "q-sm-07-impersonation": 0,
  "q-sm-08-protected-concerted": 1,
  "q-sm-09-harassment-reporting": 2,
  "q-sm-10-client-photos": 3,

  // ── Module 12: phes-401k (10, Phase 8 PR #9) ───────────────────────────
  "q-401-01-eligibility": 0,
  "q-401-02-auto-enroll-pct": 3,
  "q-401-03-safe-harbor-formula": 0,
  "q-401-04-match-at-5-pct": 1,
  "q-401-05-vesting-immediate": 2,
  "q-401-06-enrollment-paths": 3,
  "q-401-07-catch-up-50-plus": 0,
  "q-401-08-early-withdrawal-penalty": 1,
  "q-401-09-beneficiary-importance": 2,
  "q-401-10-opt-out-paths": 3,

  // ── Module 13: supply-kit (10, Phase 9 PR #10) ─────────────────────────
  "q-sk-01-property-of-phes": 0,
  "q-sk-02-supply-pickup-responsibility": 1,
  "q-sk-03-report-damage-promptly": 2,
  "q-sk-04-lost-key-procedure": 3,
  "q-sk-05-supply-pickup-out-of-supplies": 0,
  "q-sk-06-no-automatic-deduction": 1,
  "q-sk-07-supply-pickup-office-hours": 2,
  "q-sk-08-supply-pickup-not-compensated": 3,
  "q-sk-09-supply-pickup-planning": 0,
  "q-sk-10-replacement-process": 1,
  // E4: supply-pickup options + paid special trip (2026-07-15)
  "q-sk-supply-options": 2,
  "q-sk-required-trip-pay": 3,
});

/**
 * Look up an expected answer. Returns null for unknown question ids — the
 * caller (scoring) treats unknown questions as incorrect.
 */
export function expectedAnswer(questionId: string): number | null {
  const v = SERVER_ANSWER_KEY[questionId];
  return v == null ? null : v;
}
