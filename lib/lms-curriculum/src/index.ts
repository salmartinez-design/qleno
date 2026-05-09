/**
 * @workspace/lms-curriculum
 *
 * Shared curriculum surface used by both the React frontend
 * (artifacts/qleno) and the Express API (artifacts/api-server).
 *
 * What lives here:
 *   - MODULE_ORDER: every module the tech progresses through, in display
 *     order. Includes content-only modules (qleno-app) and the final
 *     acknowledgment module.
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
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ModuleId =
  | "welcome"
  | "attendance"
  | "dress-code"
  | "compensation"
  | "cleaning-standards"
  | "products-tools"
  | "maidcentral"
  | "qleno-app"
  | "acknowledgment";

export type QuizModuleId = Exclude<ModuleId, "qleno-app" | "acknowledgment">;

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
  "welcome",
  "attendance",
  "dress-code",
  "compensation",
  "cleaning-standards",
  "products-tools",
  "maidcentral",
  "qleno-app",
  "acknowledgment",
] as const;

/**
 * Modules with graded quizzes. Modules in MODULE_ORDER but NOT in this list
 * are content-only — they advance via POST /lms/module/acknowledge instead of
 * POST /lms/quiz/submit.
 */
export const QUIZ_MODULE_IDS: readonly QuizModuleId[] = [
  "welcome",
  "attendance",
  "dress-code",
  "compensation",
  "cleaning-standards",
  "products-tools",
  "maidcentral",
] as const;

/** Pass threshold per module (and for the final mixed test). 80%. */
export const QUIZ_PASS_THRESHOLD = 0.8;

/**
 * Number of questions sampled for the final mixed test. Drawn at random
 * (without replacement) across every QUIZ_MODULE_IDS. If the curriculum has
 * fewer than this many total questions, the final uses every question.
 */
export const FINAL_TEST_SIZE = 15;

// ─────────────────────────────────────────────────────────────────────────────
// Answer key — generated from artifacts/qleno/src/lib/training/curriculum.ts.
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
  // welcome (1)
  "q-scope-oven": 1,

  // attendance (4)
  "q-running-late": 2,
  "q-sick-tomorrow": 2,
  "q-pto-request": 1,
  "q-unexcused-fourth": 2,

  // dress-code (2)
  "q-shoe-covers": 2,
  "q-uniform-forgot": 2,

  // compensation (4)
  "q-fixit": 2,
  "q-hourly-overrun": 1,
  "q-comm-split": 2,
  "q-commercial-early": 1,

  // cleaning-standards (10)
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

  // products-tools (4)
  "q-products-granite": 2,
  "q-products-mop": 1,
  "q-products-glass": 2,
  "q-products-simplegreen": 2,

  // maidcentral (10)
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
 * Module id → list of question ids belonging to that module. Drives
 * per-module scoring and the random-sampling pool for the final mixed test.
 */
export const QUESTIONS_BY_MODULE: Readonly<Record<QuizModuleId, readonly string[]>> =
  Object.freeze({
    welcome: ["q-scope-oven"],
    attendance: [
      "q-running-late",
      "q-sick-tomorrow",
      "q-pto-request",
      "q-unexcused-fourth",
    ],
    "dress-code": ["q-shoe-covers", "q-uniform-forgot"],
    compensation: [
      "q-fixit",
      "q-hourly-overrun",
      "q-comm-split",
      "q-commercial-early",
    ],
    "cleaning-standards": [
      "q-room-flow",
      "q-room-order",
      "q-supplies-left",
      "q-team-arrival",
      "q-sardone-direction",
      "q-sardone-dwell",
      "q-sardone-load",
      "q-sardone-spattern",
      "q-sardone-backout",
      "q-sardone-standard",
    ],
    "products-tools": [
      "q-products-granite",
      "q-products-mop",
      "q-products-glass",
      "q-products-simplegreen",
    ],
    maidcentral: [
      "q-clock-vs-check",
      "q-tier-conflict",
      "q-gps-checkin",
      "q-mc-arrive",
      "q-mc-individual-clocks",
      "q-mc-gps-distance",
      "q-mc-efficiency",
      "q-mc-forgot-checkout",
      "q-mc-travel-pay",
      "q-mc-commercial-1of3",
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
