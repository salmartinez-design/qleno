/**
 * @workspace/lms-curriculum
 *
 * Shared curriculum surface used by both the React frontend
 * (artifacts/qleno) and the Express API (artifacts/api-server).
 *
 * What lives here:
 *   - MODULE_ORDER: every module the tech progresses through, in display
 *     order. Includes the final acknowledgment module.
 *   - QUIZ_MODULE_IDS: the subset of MODULE_ORDER that has graded quizzes.
 *     Modules NOT in this set are content-only (read + acknowledge).
 *   - FINAL_MODULE_ID: the reserved id "__final" for the final mixed test.
 *   - ANSWER_KEY: every question id → its 0-based correct option index.
 *   - QUESTIONS_BY_MODULE: every module id → list of question ids it owns.
 *   - QUIZ_PASS_THRESHOLD: 0.80 (pass at >= 80% per spec).
 *   - scoreQuiz(answers, questionIds): pure scoring function.
 *   - isModuleUnlocked(moduleId, completedModuleIds): sequential gating.
 *   - isFinalUnlocked(completedModuleIds): final mixed test gate.
 *
 * What does NOT live here:
 *   - Question prompts and option text (bilingual, owned by the frontend
 *     curriculum file at artifacts/qleno/src/lib/training/curriculum.ts).
 *     This package only carries the gating logic + answer key — the things
 *     the backend needs to be authoritative about.
 *
 * Drift: the answer key here is duplicated in
 * `@workspace/training` (lib/training/answer-key.ts). The drift-sync test
 * in api-server enforces they stay identical. If you add or remove a
 * question, update BOTH here and answer-key.ts in the same commit.
 *
 * Restructure 2026-05-09:
 *   5 modules × 15 quiz questions = 75 module questions. Final mixed
 *   test samples 50 from the pool (FINAL_TEST_SIZE bumped from 15 → 50).
 *   Old per-module ids ("welcome", "attendance", "dress-code",
 *   "cleaning-standards", "qleno-app") consolidated into the new 5
 *   modules.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ModuleId =
  | "phes-policies"
  | "compensation"
  | "cleaning-best-practices"
  | "maidcentral"
  | "products-tools"
  | "il-sexual-harassment"
  | "drug-alcohol"
  | "code-of-conduct"
  | "video-photo-release"
  | "non-solicitation"
  | "social-media"
  | "phes-401k"
  | "supply-kit"
  | "acknowledgment";

export type QuizModuleId = Exclude<ModuleId, "acknowledgment">;

/** Reserved id for the final mixed test. Not in MODULE_ORDER. */
export const FINAL_MODULE_ID = "__final" as const;
export type FinalModuleId = typeof FINAL_MODULE_ID;

export type AnyQuizId = QuizModuleId | FinalModuleId;

// ─────────────────────────────────────────────────────────────────────────────
// Module catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every module the tech sees, in order. Sequential gating uses this — module
 * N is locked until every module before it is in `completedModuleIds`.
 */
export const MODULE_ORDER: readonly ModuleId[] = [
  "phes-policies",
  "compensation",
  "cleaning-best-practices",
  "maidcentral",
  "products-tools",
  "il-sexual-harassment",
  "drug-alcohol",
  "code-of-conduct",
  "video-photo-release",
  "non-solicitation",
  "social-media",
  "phes-401k",
  "supply-kit",
  "acknowledgment",
] as const;

/**
 * Modules with graded quizzes. Modules in MODULE_ORDER but NOT in this list
 * are content-only — they advance via POST /lms/module/acknowledge instead of
 * POST /lms/quiz/submit.
 *
 * il-sexual-harassment is included here because IL Workplace Transparency Act
 * (820 ILCS 96) requires comprehension verification, not just attestation.
 * Phes also re-runs this module annually — content is updated each January
 * and the office uses the admin Reset action to re-enroll the team.
 *
 * drug-alcohol (Phase 3, PR #4) follows the same pattern: quiz to verify
 * comprehension, followed by a SEPARATE signed acknowledgment (legally
 * binding e-signature) handled by lms_signed_documents — the quiz pass
 * does NOT supersede the signed ack requirement.
 *
 * code-of-conduct (Phase 4, PR #5) follows the same shape: 10-question
 * comprehension quiz + separate signed acknowledgment at document_type
 * 'code_of_conduct'. Covers honesty, confidentiality, anti-theft,
 * anti-harassment, anti-discrimination (IL Human Rights Act protected
 * classes), anti-retaliation, reporting channels, conflict of interest,
 * and key / property handling.
 *
 * video-photo-release (Phase 5, PR #6) adds a CO-SIGNED legal release.
 * 9-question comprehension quiz + separate signed acknowledgment at
 * document_type 'video_photo_release'. References Illinois Right of
 * Publicity Act (765 ILCS 1075), includes a 5-year limit on new uses
 * after separation, AI training carve-out, 30-day removal-effort
 * withdrawal clause, and courtesy preview language. Co-signed by the
 * tenant Phes representative (default-resolved by
 * getTenantOwnerForSignature).
 *
 * non-solicitation (Phase 6, PR #7) is also CO-SIGNED. 10-question
 * comprehension quiz + separate signed agreement at document_type
 * 'non_solicitation'. References the Illinois Freedom to Work Act
 * (820 ILCS 90) reasonableness + consideration constraints. Spanish
 * version is one of the FOUR FLAGGED docs for professional translator
 * review (pendingTranslationReview: true). 12-month post-separation
 * limit on soliciting Phes clients; coworkers explicitly carved out
 * of the agreement; general advertising not deemed solicitation.
 *
 * social-media (Phase 7, PR #8) is a one-sided employee
 * acknowledgment (not co-signed). 10-question comprehension quiz +
 * separate signed acknowledgment at document_type 'social_media'.
 * Critical NLRA Section 7 carve-out preserving the right of
 * employees to discuss wages, working conditions, and concerted
 * activity with coworkers and in public. Also preserves the
 * Illinois Right to Privacy in the Workplace Act (820 ILCS 55)
 * protection for off-duty private social-media activity.
 * Restrictions target client confidentiality, in-uniform
 * misrepresentation, and Phes-client solicitation (cross-refs the
 * Non-Solicitation Agreement).
 *
 * phes-401k (Phase 8, PR #9) is a benefits-education module.
 * 10-question comprehension quiz; NO signed legal document; NOT
 * gating the final exam. Covers the Phes 401(k) plan administered
 * by ADP Retirement Services: auto-enrollment at 3%, eligibility
 * (18 + 3 months of service), Safe Harbor Match (100% of first 3%
 * + 50% of next 2%), immediate vesting of employee deferrals and
 * Safe Harbor match, profit-sharing vesting schedule, catch-up
 * contributions (50+ and 60-63 super catch-up), enrollment paths,
 * and the 10% early-withdrawal penalty.
 *
 * supply-kit (Phase 9, PR #10) is the last standalone signed-doc
 * module. 10-question comprehension quiz + separate signed
 * acknowledgment at document_type 'supply_kit'. Establishes the
 * employee's responsibility for Phes-provided cleaning supplies,
 * uniform, keys, and any assigned hardware. Distinguishes
 * reasonable wear (Phes absorbs) from negligent damage (employee
 * may be billed). Does NOT pre-authorize automatic payroll
 * deductions — the Illinois Wage Payment and Collection Act
 * (820 ILCS 115) requires contemporaneous written authorization
 * for any specific deduction, so the agreement reserves Phes's
 * right to seek reimbursement and references that requirement.
 */
export const QUIZ_MODULE_IDS: readonly QuizModuleId[] = [
  "phes-policies",
  "compensation",
  "cleaning-best-practices",
  "maidcentral",
  "products-tools",
  "il-sexual-harassment",
  "drug-alcohol",
  "code-of-conduct",
  "video-photo-release",
  "non-solicitation",
  "social-media",
  "phes-401k",
  "supply-kit",
] as const;

/** Pass threshold per module (and for the final mixed test). 80%. */
export const QUIZ_PASS_THRESHOLD = 0.8;

/**
 * Maximum attempts a learner gets before a module locks. Spec (phes 2026-05-11):
 * three shots at each module quiz, four at the final mixed test. Owners are
 * exempt from this gate via `/lms/admin/bypass-module`. Admins can also
 * extend the deadline or bypass on behalf of a learner from /lms/admin.
 */
// Item 6 (P0/P1 sprint 2026-05-14): per-module cap raised from 3 → 4
// after Sal's audit found 21 attempts on Compensation for one tech
// (server wasn't enforcing the cap; UI showed "3/3 at cap" but the
// /quiz/submit handler accepted submissions anyway). Final exam cap
// stays at 4 for parity. Server-side enforcement now lives in
// /quiz/submit guarded by maxAttemptsFor().
export const MAX_MODULE_ATTEMPTS = 4;
export const MAX_FINAL_ATTEMPTS = 4;

/** Max attempts allowed for a given module id (module or `__final`). */
export function maxAttemptsFor(moduleId: string): number {
  return moduleId === FINAL_MODULE_ID ? MAX_FINAL_ATTEMPTS : MAX_MODULE_ATTEMPTS;
}

/**
 * Returns true when this user should see learner-only UI: attempt
 * counters, "attempts remaining" copy, lockout messages, deadline
 * countdowns — anything that exists to pressure a learner toward
 * completing the module on a schedule.
 *
 * Owners and admins always return false. They get the bypass /
 * preview path instead; the attempt cap is never enforced against
 * them on the server (see canBypassCap in routes/lms.ts), so the
 * UI must match.
 *
 * Lives here (not in training.tsx) so it can be unit-tested with the
 * existing lms-curriculum.test.ts harness without spinning up React.
 * Any new learner-gating widget added to training.tsx, the LMS admin
 * surface, or the field app should consume this predicate so the
 * next "hide this from owners" request has one place to extend.
 */
export function shouldShowLearnerGating(isOwner: boolean): boolean {
  return !isOwner;
}

/**
 * Number of questions sampled for the final mixed test. Drawn at random
 * (without replacement) across every QUIZ_MODULE_IDS. If the curriculum has
 * fewer than this many total questions, the final uses every question.
 *
 * Restructure 2026-05-09: bumped from 15 → 50 to reflect the larger
 * 75-question pool (5 modules × 15 each).
 */
/**
 * Phase 13 (PR #14): sampled to 30 from the now-187-question pool. The
 * user spec calls for 25-30; we pick the upper bound so the test
 * stretches across more modules (sampler is uniform random across all
 * QUIZ_MODULE_IDS, so 30 gives a comfortable spread). Previously 50
 * when the pool was 75; sample-to-pool ratio is now ~16 percent vs the
 * earlier ~67 percent. The lower density is appropriate for a closing
 * mixed test, not a re-test of every concept.
 */
export const FINAL_TEST_SIZE = 30;

// ─────────────────────────────────────────────────────────────────────────────
// Answer key — mirrors artifacts/qleno/src/lib/training/curriculum.ts.
// Keep in sync with @workspace/training/answer-key.ts (drift-sync test).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every question id → its 0-based correct option index.
 *
 * Source of truth: this file + lib/training/answer-key.ts (must match).
 * The frontend curriculum.ts also embeds correctIndex for immediate-feedback
 * UX; that copy is informational and is allowed to drift IF the frontend
 * gracefully reconciles with backend re-scoring. The DRIFT-SYNC TEST only
 * compares lms-curriculum to lib/training.
 */
export const ANSWER_KEY: Readonly<Record<string, number>> = Object.freeze({
  // ── Module 1: phes-policies (34) ─────────────────────────────────────────
  // 15 original + 8 (handbook reconciliation 2026-05-11) + 2 sick-time
  // deep dive + 1 unpaid personal days + 8 (four-bucket policy 2026-05-12:
  // PLAWA → PTO → Unpaid Personal Leave → Unpaid Absence Allowance with
  // the two-condition unexcused rule, PLAWA denial / default / discipline
  // protection, and notice requirements per bucket).
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
  "q-pp-12-pto-plawa-distinct": 2,
  "q-pp-13-emergency-911": 2,
  "q-pp-14-phone-use": 1,
  "q-pp-15-photos": 2,
  "q-pp-16-dishes-beds": 1,
  "q-pp-17-office-exception": 2,
  "q-pp-18-bereavement": 0,
  "q-pp-19-jury-duty": 1,
  "q-pp-20-lactation": 1,
  "q-pp-21-pto-cap": 1,
  "q-pp-22-separation-payout": 1,
  "q-pp-23-holiday-90day": 1,
  "q-pp-24-add-on-pricing": 1,
  "q-pp-25-sick-no-balance": 1,
  "q-pp-26-unpaid-personal": 1,
  "q-pp-27-bucket-order": 1,
  "q-pp-28-unexcused-definition": 1,
  "q-pp-29-plawa-denial": 1,
  "q-pp-30-move-in-empty": 1,
  "q-pp-31-plawa-default": 1,
  "q-pp-32-notice-by-bucket": 1,
  "q-pp-33-plawa-reason": 1,
  "q-pp-34-protected-still-excused": 1,
  "q-pp-35-deep-clean-includes": 1,
  "q-pp-36-deep-clean-excludes": 1,
  "q-pp-37-deep-clean-windows": 0,
  "q-pp-38-heavy-furniture-25lb": 1,
  "q-pp-39-trash-bag-limit": 1,
  "q-pp-40-no-price-discussion": 1,
  "q-pp-41-parking": 1,
  "q-pp-42-supply-maintenance": 1,
  "q-pp-43-ncns": 2,
  "q-pp-44-plawa-increment": 0,
  // E3: PLAWA day-1 grant (2026-07-15)
  "q-pp-plawa-grant": 1,
  // K: meal break entitlement (2026-07-15)
  "q-pp-meal-break": 2,

  // ── Module 2: compensation (16, alignment with handbook hardening 2026-05-21) ───
  // Dropped q-cm-04/06/10 (duplicates + non-legal); added q-cm-17/18/19
  // (legal nuances: recovery tech 3hr min, valid quality complaint
  // definition, refused re-clean $20 base rate). Flipped q-cm-15 correct
  // answer from 1→0 to reflect weekly pay correction.
  "q-cm-01-training-pay": 1,
  "q-cm-02-standard-rate": 2,
  "q-cm-03-deep-clean-rate": 1,
  "q-cm-05-comm-split-200": 2,
  "q-cm-07-clock-in-difference": 1,
  "q-cm-08-hourly-overrun": 1,
  "q-cm-09-commercial-rate": 2,
  "q-cm-11-fixit": 0,
  "q-cm-12-quality-probation": 1,
  "q-cm-13-probation-pay": 1,
  "q-cm-14-mileage": 0,
  "q-cm-15-payroll-cycle": 0,
  "q-cm-16-allowed-hours-math": 1,
  "q-cm-17-recovery-tech-three-hour": 1,
  "q-cm-18-valid-quality-complaint": 1,
  "q-cm-19-refused-reclean-eighteen": 1,
  // E2: paper-check option (2026-07-15)
  "q-cm-paycheck-method": 1,
  "q-cm-20-training-redo-paid": 1,
  "q-cm-21-fix-it-mileage": 0,

  // ── Module 3: cleaning-best-practices (15) ───────────────────────────────
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

  // ── Module 4: maidcentral (15) ───────────────────────────────────────────
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
  // E1: Qleno rebrand additions (2026-07-15)
  "q-mc-qleno-system": 2,
  "q-mc-qleno-arrival": 1,
  "q-mc-qleno-gps": 3,
  "q-mc-qleno-down": 2,
  "q-mc-qleno-fix": 0,

  // ── Module 5: products-tools (15) ────────────────────────────────────────
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

  // ── Module 6: il-sexual-harassment (15, IL Workplace Transparency Act) ────
  // Added 2026-05-12 to satisfy the 820 ILCS 96 annual training requirement.
  // Content reflects IDHR model training: definition, two-form distinction,
  // examples, employer responsibility, reporting channels (Maribel /
  // Francisco / IDHR / EEOC), retaliation prohibition, bystander duty.
  "q-il-01-definition": 1,
  "q-il-02-quid-pro-quo": 1,
  "q-il-03-hostile-environment": 1,
  "q-il-04-not-limited-by-sex": 1,
  "q-il-05-third-party": 1,
  "q-il-06-reporting-channels": 1,
  "q-il-07-retaliation": 1,
  "q-il-08-bystander-duty": 1,
  "q-il-09-idhr-deadline": 2,
  "q-il-10-eeoc-deadline": 2,
  "q-il-11-annual-retraining": 1,
  "q-il-12-severe-or-pervasive": 1,
  "q-il-13-consent-withdrawn": 1,
  "q-il-14-investigation-rights": 1,
  "q-il-15-good-faith-protection": 1,

  // ── Module 7: drug-alcohol (10, Phase 3 PR #4) ──────────────────────────
  // Phes Drug & Alcohol Policy. Quiz verifies comprehension; the binding
  // signed acknowledgment lives in lms_signed_documents (document_type
  // 'drug_alcohol'). Both are required for legal compliance under Illinois
  // Cannabis Regulation & Tax Act + the Illinois Right to Privacy in the
  // Workplace Act (820 ILCS 55).
  "q-da-01-no-pre-employment-test": 1,
  "q-da-02-impairment-not-cannabis-use": 1,
  "q-da-03-impairment-signs": 2,
  "q-da-04-reasonable-suspicion-process": 1,
  "q-da-05-post-accident-threshold": 1,
  "q-da-06-prescription-meds": 1,
  "q-da-07-refusal-to-test": 1,
  "q-da-08-discipline-scale": 1,
  "q-da-09-dui-reporting-window": 1,
  "q-da-10-license-suspension-disclosure": 1,

  // ── Module 8: code-of-conduct (10, Phase 4 PR #5) ───────────────────────
  // Phes Code of Conduct. Quiz verifies comprehension; the binding signed
  // acknowledgment lives in lms_signed_documents (document_type
  // 'code_of_conduct'). Covers honesty / integrity, client-home
  // confidentiality, zero-tolerance theft, anti-harassment + anti-
  // discrimination (Illinois Human Rights Act protected classes),
  // anti-retaliation good-faith reporting, conflict of interest /
  // outside cleaning work for Phes clients, key + property handling,
  // and cooperation with internal investigations.
  "q-coc-01-honesty": 1,
  "q-coc-02-confidentiality": 1,
  "q-coc-03-theft-zero-tolerance": 1,
  "q-coc-04-harassment-reporting": 1,
  "q-coc-05-protected-classes": 1,
  "q-coc-06-retaliation-good-faith": 1,
  "q-coc-07-conflict-of-interest": 1,
  "q-coc-08-key-handling": 1,
  "q-coc-09-cooperation-investigation": 1,
  "q-coc-10-reporting-channels": 1,

  // ── Module 9: video-photo-release (9, Phase 5 PR #6) ────────────────────
  // Phes Video / Photo Release. Co-signed by the Phes representative
  // (tenant owner by default). References Illinois Right of Publicity
  // Act (765 ILCS 1075) for the limits on commercial use of a person's
  // identity. Includes a 5-year post-separation limit on NEW uses,
  // AI-training carve-out, and a 30-day removal-effort withdrawal
  // clause. Spanish translation is NOT in the four flagged docs and
  // ships without a translator-review banner.
  "q-vpr-01-voluntary": 1,
  "q-vpr-02-5-year-limit": 1,
  "q-vpr-03-ai-carve-out": 1,
  "q-vpr-04-withdrawal-30-day": 1,
  "q-vpr-05-third-party-limits": 1,
  "q-vpr-06-il-right-of-publicity": 1,
  "q-vpr-07-co-signature": 1,
  "q-vpr-08-courtesy-preview": 1,
  "q-vpr-09-active-distribution": 1,

  // ── Module 10: non-solicitation (10, Phase 6 PR #7) ─────────────────────
  // Phes Non-Solicitation Agreement. Co-signed by the Phes representative.
  // Constrained by the Illinois Freedom to Work Act (820 ILCS 90): the
  // restriction must be reasonable, supported by adequate consideration,
  // and tailored to a legitimate business interest. The agreement only
  // restricts soliciting Phes CLIENTS (not coworkers, not the general
  // labor market) for 12 months post-separation. Spanish version is one
  // of the FOUR FLAGGED docs for professional translator review.
  "q-ns-01-clients-not-coworkers": 1,
  "q-ns-02-12-month-duration": 1,
  "q-ns-03-what-counts-as-solicit": 1,
  "q-ns-04-general-advertising-ok": 1,
  "q-ns-05-il-freedom-to-work": 1,
  "q-ns-06-during-employment-too": 1,
  "q-ns-07-consideration": 1,
  "q-ns-08-remedy-injunctive": 1,
  "q-ns-09-co-signature": 1,
  "q-ns-10-inbound-clients-exception": 1,
  // Phase 6.5 amendment (post-PR #7): added q-ns-11/12/13 to verify
  // comprehension of the new direct-payment prohibition (Section 12)
  // and trade-secret confidentiality (Section 13).
  "q-ns-11-direct-payment-prohibition": 1,
  "q-ns-12-trade-secret-confidentiality": 1,
  "q-ns-13-trade-secret-vs-section-7": 1,

  // ── Module 11: social-media (10, Phase 7 PR #8) ─────────────────────────
  // Phes Social Media Policy. NOT co-signed. Critical NLRA Section 7
  // carve-out preserving employee rights to discuss wages, working
  // conditions, and concerted activity. Also preserves the IL Right to
  // Privacy in the Workplace Act (820 ILCS 55) protection for off-duty
  // private social media. Restrictions target client confidentiality,
  // in-uniform misrepresentation, and client solicitation (cross-refs
  // the Non-Solicitation Agreement).
  "q-sm-01-client-confidentiality": 1,
  "q-sm-02-nlra-section-7": 1,
  "q-sm-03-off-duty-private": 1,
  "q-sm-04-uniform-misuse": 1,
  "q-sm-05-client-solicitation": 1,
  "q-sm-06-disparagement": 1,
  "q-sm-07-impersonation": 1,
  "q-sm-08-protected-concerted": 1,
  "q-sm-09-harassment-reporting": 1,
  "q-sm-10-client-photos": 1,

  // ── Module 12: phes-401k (10, Phase 8 PR #9) ────────────────────────────
  // Phes 401(k) Plan administered by ADP Retirement Services. Educational
  // module, NOT a signed legal document; does NOT gate the final exam.
  // Plan facts sourced from the ADP Plan Highlights PDF (Plan ID 073781,
  // sponsor PHES LLC). Quiz verifies comprehension of eligibility,
  // auto-enrollment, Safe Harbor match, vesting, catch-up contributions,
  // enrollment paths, early-withdrawal penalty, and beneficiary
  // designation.
  "q-401-01-eligibility": 1,
  "q-401-02-auto-enroll-pct": 1,
  "q-401-03-safe-harbor-formula": 0,
  "q-401-04-match-at-5-pct": 2,
  "q-401-05-vesting-immediate": 0,
  "q-401-06-enrollment-paths": 1,
  "q-401-07-catch-up-50-plus": 1,
  "q-401-08-early-withdrawal-penalty": 1,
  "q-401-09-beneficiary-importance": 1,
  "q-401-10-opt-out-paths": 1,

  // ── Module 13: supply-kit (10, Phase 9 PR #10) ──────────────────────────
  // Phes Supply Kit Responsibility Agreement. NOT co-signed. Establishes
  // employee responsibility for Phes-provided supplies, uniform, keys,
  // and assigned hardware. Distinguishes reasonable wear (Phes absorbs)
  // from negligent damage (employee may be billed). Does NOT
  // pre-authorize payroll deductions; references IL Wage Payment and
  // Collection Act (820 ILCS 115) which requires contemporaneous written
  // authorization for any specific deduction.
  "q-sk-01-property-of-phes": 1,
  "q-sk-02-supply-pickup-responsibility": 1,
  "q-sk-03-report-damage-promptly": 1,
  "q-sk-04-lost-key-procedure": 1,
  "q-sk-05-supply-pickup-out-of-supplies": 1,
  "q-sk-06-no-automatic-deduction": 1,
  "q-sk-07-supply-pickup-office-hours": 1,
  "q-sk-08-supply-pickup-not-compensated": 1,
  "q-sk-09-supply-pickup-planning": 1,
  "q-sk-10-replacement-process": 1,
  // E4: supply-pickup options + paid special trip (2026-07-15)
  "q-sk-supply-options": 2,
  "q-sk-required-trip-pay": 3,
});

/**
 * Module id → list of question ids belonging to that module. Drives
 * per-module scoring and the random-sampling pool for the final mixed test.
 */
export const QUESTIONS_BY_MODULE: Readonly<Record<QuizModuleId, readonly string[]>> =
  Object.freeze({
    "phes-policies": [
      "q-pp-01-w2", "q-pp-02-guarantee", "q-pp-03-scope-oven",
      "q-pp-04-bodily-fluids", "q-pp-05-tipping", "q-pp-06-running-late",
      "q-pp-07-grace-window", "q-pp-08-tardy-progression", "q-pp-09-sick-tomorrow",
      "q-pp-10-pto-request", "q-pp-11-unexcused-fourth", "q-pp-12-pto-plawa-distinct",
      "q-pp-13-emergency-911", "q-pp-14-phone-use", "q-pp-15-photos",
      "q-pp-16-dishes-beds", "q-pp-17-office-exception", "q-pp-18-bereavement",
      "q-pp-19-jury-duty", "q-pp-20-lactation", "q-pp-21-pto-cap",
      "q-pp-22-separation-payout", "q-pp-23-holiday-90day",
      "q-pp-24-add-on-pricing",
      "q-pp-25-sick-no-balance",
      "q-pp-26-unpaid-personal",
      // Four-bucket policy (2026-05-12)
      "q-pp-27-bucket-order", "q-pp-28-unexcused-definition", "q-pp-29-plawa-denial",
      "q-pp-30-move-in-empty", "q-pp-31-plawa-default",
      "q-pp-32-notice-by-bucket", "q-pp-33-plawa-reason",
      "q-pp-34-protected-still-excused",
      // Cleaning checklist + Deep Clean scope (2026-05-12)
      "q-pp-35-deep-clean-includes", "q-pp-36-deep-clean-excludes",
      "q-pp-37-deep-clean-windows", "q-pp-38-heavy-furniture-25lb",
      "q-pp-39-trash-bag-limit", "q-pp-40-no-price-discussion",
      // Parking policy (2026-05-22)
      "q-pp-41-parking",
      // Supply pickup responsibility (2026-05-24)
      "q-pp-42-supply-maintenance",
      // PLAWA compliance: NCNS weight + minimum increment (2026-07-11)
      "q-pp-43-ncns", "q-pp-44-plawa-increment",
      // PLAWA day-1 grant (E3, 2026-07-15)
      "q-pp-plawa-grant",
      // Meal break entitlement (K, 2026-07-15)
      "q-pp-meal-break",
    ],
    compensation: [
      "q-cm-01-training-pay", "q-cm-02-standard-rate", "q-cm-03-deep-clean-rate",
      "q-cm-05-comm-split-200", "q-cm-07-clock-in-difference", "q-cm-08-hourly-overrun",
      "q-cm-09-commercial-rate", "q-cm-11-fixit", "q-cm-12-quality-probation",
      "q-cm-13-probation-pay", "q-cm-14-mileage", "q-cm-15-payroll-cycle",
      "q-cm-16-allowed-hours-math",
      // Handbook-alignment additions (2026-05-21)
      "q-cm-17-recovery-tech-three-hour", "q-cm-18-valid-quality-complaint",
      "q-cm-19-refused-reclean-eighteen",
      // Training-period paid-redo window (2026-05-22)
      "q-cm-20-training-redo-paid",
      // Mileage disambiguation + Fix-It mileage (2026-05-22)
      "q-cm-21-fix-it-mileage",
      // Paper-check option (E2, 2026-07-15)
      "q-cm-paycheck-method",
    ],
    "cleaning-best-practices": [
      "q-cb-01-room-flow", "q-cb-02-room-order", "q-cb-03-direction",
      "q-cb-04-dwell", "q-cb-05-load-caddy", "q-cb-06-spattern",
      "q-cb-07-backout-mop", "q-cb-08-standard-not-time", "q-cb-09-vacuum-before-mop",
      "q-cb-10-team-arrival", "q-cb-11-supplies-left", "q-cb-12-color-cloths",
      "q-cb-13-two-hand", "q-cb-14-dont-backtrack", "q-cb-15-conflict-worksheet-note",
    ],
    maidcentral: [
      "q-mc-01-clock-vs-check", "q-mc-02-arrive-first-job", "q-mc-03-individual-clocks",
      "q-mc-04-gps-distance", "q-mc-05-600-feet", "q-mc-06-efficiency",
      "q-mc-07-efficiency-target", "q-mc-08-forgot-checkout", "q-mc-09-travel-pay",
      "q-mc-10-commute-not-paid", "q-mc-11-end-of-day", "q-mc-12-conflict-note",
      "q-mc-13-commercial-finished-early", "q-mc-14-qleno-coming", "q-mc-15-day-clock-running",
      // Qleno rebrand additions (E1, 2026-07-15)
      "q-mc-qleno-system", "q-mc-qleno-arrival", "q-mc-qleno-gps",
      "q-mc-qleno-down", "q-mc-qleno-fix",
    ],
    "products-tools": [
      "q-pt-01-granite", "q-pt-02-mop", "q-pt-03-glass",
      "q-pt-04-simplegreen", "q-pt-05-zep-bleach", "q-pt-06-zep-fabric",
      "q-pt-07-magic-eraser-paint", "q-pt-08-magic-eraser-glass", "q-pt-09-pumice-where",
      "q-pt-10-pumice-wet", "q-pt-11-steel-wool-grade", "q-pt-12-steel-wool-chrome",
      "q-pt-13-cloth-cross", "q-pt-14-step-stool", "q-pt-15-furniture-stand",
    ],
    "il-sexual-harassment": [
      "q-il-01-definition", "q-il-02-quid-pro-quo", "q-il-03-hostile-environment",
      "q-il-04-not-limited-by-sex", "q-il-05-third-party", "q-il-06-reporting-channels",
      "q-il-07-retaliation", "q-il-08-bystander-duty", "q-il-09-idhr-deadline",
      "q-il-10-eeoc-deadline", "q-il-11-annual-retraining", "q-il-12-severe-or-pervasive",
      "q-il-13-consent-withdrawn", "q-il-14-investigation-rights", "q-il-15-good-faith-protection",
    ],
    "drug-alcohol": [
      "q-da-01-no-pre-employment-test", "q-da-02-impairment-not-cannabis-use",
      "q-da-03-impairment-signs", "q-da-04-reasonable-suspicion-process",
      "q-da-05-post-accident-threshold", "q-da-06-prescription-meds",
      "q-da-07-refusal-to-test", "q-da-08-discipline-scale",
      "q-da-09-dui-reporting-window", "q-da-10-license-suspension-disclosure",
    ],
    "code-of-conduct": [
      "q-coc-01-honesty", "q-coc-02-confidentiality",
      "q-coc-03-theft-zero-tolerance", "q-coc-04-harassment-reporting",
      "q-coc-05-protected-classes", "q-coc-06-retaliation-good-faith",
      "q-coc-07-conflict-of-interest", "q-coc-08-key-handling",
      "q-coc-09-cooperation-investigation", "q-coc-10-reporting-channels",
    ],
    "video-photo-release": [
      "q-vpr-01-voluntary", "q-vpr-02-5-year-limit",
      "q-vpr-03-ai-carve-out", "q-vpr-04-withdrawal-30-day",
      "q-vpr-05-third-party-limits", "q-vpr-06-il-right-of-publicity",
      "q-vpr-07-co-signature", "q-vpr-08-courtesy-preview",
      "q-vpr-09-active-distribution",
    ],
    "non-solicitation": [
      "q-ns-01-clients-not-coworkers", "q-ns-02-12-month-duration",
      "q-ns-03-what-counts-as-solicit", "q-ns-04-general-advertising-ok",
      "q-ns-05-il-freedom-to-work", "q-ns-06-during-employment-too",
      "q-ns-07-consideration", "q-ns-08-remedy-injunctive",
      "q-ns-09-co-signature", "q-ns-10-inbound-clients-exception",
      "q-ns-11-direct-payment-prohibition",
      "q-ns-12-trade-secret-confidentiality",
      "q-ns-13-trade-secret-vs-section-7",
    ],
    "social-media": [
      "q-sm-01-client-confidentiality", "q-sm-02-nlra-section-7",
      "q-sm-03-off-duty-private", "q-sm-04-uniform-misuse",
      "q-sm-05-client-solicitation", "q-sm-06-disparagement",
      "q-sm-07-impersonation", "q-sm-08-protected-concerted",
      "q-sm-09-harassment-reporting", "q-sm-10-client-photos",
    ],
    "phes-401k": [
      "q-401-01-eligibility", "q-401-02-auto-enroll-pct",
      "q-401-03-safe-harbor-formula", "q-401-04-match-at-5-pct",
      "q-401-05-vesting-immediate", "q-401-06-enrollment-paths",
      "q-401-07-catch-up-50-plus", "q-401-08-early-withdrawal-penalty",
      "q-401-09-beneficiary-importance", "q-401-10-opt-out-paths",
    ],
    "supply-kit": [
      "q-sk-01-property-of-phes", "q-sk-02-supply-pickup-responsibility",
      "q-sk-03-report-damage-promptly", "q-sk-04-lost-key-procedure",
      "q-sk-05-supply-pickup-out-of-supplies", "q-sk-06-no-automatic-deduction",
      "q-sk-07-supply-pickup-office-hours", "q-sk-08-supply-pickup-not-compensated",
      "q-sk-09-supply-pickup-planning", "q-sk-10-replacement-process",
      // Supply-pickup options + paid special trip (E4, 2026-07-15)
      "q-sk-supply-options", "q-sk-required-trip-pay",
    ],
  });

/**
 * Reverse index: question id → its module id. Useful for analytics and the
 * "wrong answer feedback by module" frontend.
 */
export const MODULE_BY_QUESTION: Readonly<Record<string, QuizModuleId>> = (() => {
  const out: Record<string, QuizModuleId> = {};
  for (const moduleId of QUIZ_MODULE_IDS) {
    for (const qid of QUESTIONS_BY_MODULE[moduleId]) {
      out[qid] = moduleId;
    }
  }
  return Object.freeze(out);
})();

/** Flat list of every question id, in deterministic order. */
export const ALL_QUESTION_IDS: readonly string[] = Object.freeze(
  QUIZ_MODULE_IDS.flatMap((m) => [...QUESTIONS_BY_MODULE[m]]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoreResult {
  /** Integer 0–100. */
  score: number;
  /** True iff `score >= round(threshold * 100)`. */
  passed: boolean;
  /** Number of correctly answered questions. */
  correctCount: number;
  /** Total number of questions scored. */
  totalCount: number;
  /** Per-question correctness (parallel to questionIds). */
  perQuestion: boolean[];
}

/**
 * Score a quiz submission. Pure function — no I/O, no clock.
 *
 * @param answers       parallel to questionIds; null/undefined = unanswered
 * @param questionIds   the question ids that were served (in order)
 * @param threshold     pass threshold as a fraction (default 0.80)
 * @param answerKey     answer source; defaults to the bundled ANSWER_KEY
 *
 * Edge cases:
 * - Empty questionIds → score 0, passed false.
 * - Answer for an unknown question id → counted incorrect (defensive — drift).
 * - Mismatched array lengths → uses min(answers.length, questionIds.length).
 */
export function scoreQuiz(
  answers: readonly (number | null | undefined)[],
  questionIds: readonly string[],
  threshold: number = QUIZ_PASS_THRESHOLD,
  answerKey: Readonly<Record<string, number>> = ANSWER_KEY,
): ScoreResult {
  const totalCount = questionIds.length;
  if (totalCount === 0) {
    return {
      score: 0,
      passed: false,
      correctCount: 0,
      totalCount: 0,
      perQuestion: [],
    };
  }
  const perQuestion: boolean[] = new Array(totalCount).fill(false);
  let correctCount = 0;
  const len = Math.min(answers.length, totalCount);
  for (let i = 0; i < len; i++) {
    const expected = answerKey[questionIds[i]];
    const got = answers[i];
    const ok = expected != null && got === expected;
    perQuestion[i] = ok;
    if (ok) correctCount++;
  }
  const score = Math.round((correctCount / totalCount) * 100);
  const passingScore = Math.round(threshold * 100);
  const passed = score >= passingScore;
  return { score, passed, correctCount, totalCount, perQuestion };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gating
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sequential gate: a module is unlocked iff every module before it in
 * MODULE_ORDER is in `completedModuleIds`. The first module is always
 * unlocked. Unknown module ids return false (defensive).
 */
export function isModuleUnlocked(
  moduleId: string,
  completedModuleIds: readonly string[],
): boolean {
  const idx = MODULE_ORDER.indexOf(moduleId as ModuleId);
  if (idx < 0) return false;
  if (idx === 0) return true;
  const completed = new Set(completedModuleIds);
  for (let i = 0; i < idx; i++) {
    if (!completed.has(MODULE_ORDER[i])) return false;
  }
  return true;
}

/**
 * Final mixed test is unlocked iff every module preceding "acknowledgment"
 * in MODULE_ORDER is in `completedModuleIds`. (The acknowledgment module
 * itself is gated separately on the final test passing.)
 */
export function isFinalUnlocked(
  completedModuleIds: readonly string[],
): boolean {
  const required = MODULE_ORDER.filter((m) => m !== "acknowledgment");
  const completed = new Set(completedModuleIds);
  return required.every((m) => completed.has(m));
}

// ─────────────────────────────────────────────────────────────────────────────
// Final-test sampling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure sample-without-replacement from ALL_QUESTION_IDS. Caller passes its
 * own random source (seeded for tests; Math.random in production). Returns
 * up to `count` question ids, never more than the total available.
 */
export function sampleFinalQuestionIds(
  count: number = FINAL_TEST_SIZE,
  random: () => number = Math.random,
): string[] {
  const pool = [...ALL_QUESTION_IDS];
  const n = Math.min(count, pool.length);
  // Fisher–Yates partial shuffle for reservoir-style sampling.
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
