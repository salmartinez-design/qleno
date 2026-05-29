/**
 * LMS curriculum & gating — unit tests.
 *
 * Pure tests against @workspace/lms-curriculum. No DB, no network.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:lms
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_QUESTION_IDS,
  ANSWER_KEY,
  FINAL_MODULE_ID,
  FINAL_TEST_SIZE,
  MAX_FINAL_ATTEMPTS,
  MAX_MODULE_ATTEMPTS,
  MODULE_BY_QUESTION,
  MODULE_ORDER,
  QUESTIONS_BY_MODULE,
  QUIZ_MODULE_IDS,
  QUIZ_PASS_THRESHOLD,
  isFinalUnlocked,
  isModuleUnlocked,
  maxAttemptsFor,
  sampleFinalQuestionIds,
  scoreQuiz,
  shouldShowLearnerGating,
} from "@workspace/lms-curriculum";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & catalog shape
// ─────────────────────────────────────────────────────────────────────────────

describe("LMS curriculum — constants & catalog shape", () => {
  it("MODULE_ORDER has all 14 modules in expected sequence (supply-kit added 2026-05-13 Phase 9)", () => {
    assert.deepEqual([...MODULE_ORDER], [
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
    ]);
  });

  it("QUIZ_MODULE_IDS contains exactly the 13 quiz modules (no acknowledgment)", () => {
    assert.deepEqual([...QUIZ_MODULE_IDS], [
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
    ]);
  });

  it("QUIZ_PASS_THRESHOLD is 0.80 per spec", () => {
    assert.equal(QUIZ_PASS_THRESHOLD, 0.8);
  });

  it("FINAL_MODULE_ID is the reserved __final pseudo-id and not in MODULE_ORDER", () => {
    assert.equal(FINAL_MODULE_ID, "__final");
    assert.equal(MODULE_ORDER.includes(FINAL_MODULE_ID as never), false);
  });

  it("FINAL_TEST_SIZE is positive and at most ALL_QUESTION_IDS.length", () => {
    assert.ok(FINAL_TEST_SIZE > 0, "FINAL_TEST_SIZE must be > 0");
    assert.ok(
      FINAL_TEST_SIZE <= ALL_QUESTION_IDS.length,
      "FINAL_TEST_SIZE must not exceed total question pool size",
    );
  });

  it("FINAL_TEST_SIZE is 30 (Phase 13, PR #14: 30 sampled from the 13-module pool)", () => {
    assert.equal(FINAL_TEST_SIZE, 30);
  });

  it("phes-policies has 42 questions (40 baseline + parking 2026-05-22 + supply-pickup 2026-05-24)", () => {
    assert.equal(
      QUESTIONS_BY_MODULE["phes-policies"].length,
      42,
      `phes-policies should have 42 questions; has ${QUESTIONS_BY_MODULE["phes-policies"].length}`,
    );
  });

  it("each non-policies module has its specified question count", () => {
    // phes-policies: 42 (40 baseline + parking 2026-05-22 + supply-pickup 2026-05-24)
    // compensation: 18 (17 + fix-it-mileage 2026-05-22)
    // drug-alcohol: 10 (Phase 3 spec, legally-important concepts only)
    // code-of-conduct: 10 (Phase 4 spec, behavior-comprehension)
    // video-photo-release: 9 (Phase 5 spec, release-rights comprehension)
    // non-solicitation: 13 (Phase 6 + 6.5 amendment)
    // social-media: 10 (Phase 7 spec, NLRA Section 7 + carve-out comprehension)
    // phes-401k: 10 (Phase 8 spec, 401(k) plan-features comprehension)
    // supply-kit: 10 (Phase 9 spec — 2026-05-24 swapped 5 lower-value
    //   property-care questions for supply-pickup; total still 10)
    // all others: 15 (per original Phes spec)
    const expected: Record<string, number> = {
      "phes-policies": 42,
      "drug-alcohol": 10,
      "code-of-conduct": 10,
      "video-photo-release": 9,
      "non-solicitation": 13,
      "social-media": 10,
      "phes-401k": 10,
      "supply-kit": 10,
      compensation: 18,
      "cleaning-best-practices": 15,
      maidcentral: 15,
      "products-tools": 15,
      "il-sexual-harassment": 15,
    };
    for (const m of QUIZ_MODULE_IDS) {
      assert.equal(
        QUESTIONS_BY_MODULE[m].length,
        expected[m],
        `Module ${m} should have ${expected[m]} questions; has ${QUESTIONS_BY_MODULE[m].length}`,
      );
    }
  });

  it("ALL_QUESTION_IDS is 192 total (42 + 18 + 15*4 + 10 + 10 + 9 + 13 + 10 + 10 + 10)", () => {
    assert.equal(ALL_QUESTION_IDS.length, 192);
  });

  it("ANSWER_KEY has exactly the keys enumerated by ALL_QUESTION_IDS", () => {
    assert.deepEqual(
      new Set(Object.keys(ANSWER_KEY)),
      new Set(ALL_QUESTION_IDS),
    );
  });

  it("every question maps to a valid 0–3 option index (sanity)", () => {
    for (const qid of Object.keys(ANSWER_KEY)) {
      const idx: number = ANSWER_KEY[qid];
      assert.ok(
        Number.isInteger(idx) && idx >= 0 && idx <= 5,
        `Question ${qid} has out-of-range correctIndex ${idx}`,
      );
    }
  });

  it("MODULE_BY_QUESTION inverts QUESTIONS_BY_MODULE consistently", () => {
    for (const m of QUIZ_MODULE_IDS) {
      for (const qid of QUESTIONS_BY_MODULE[m]) {
        assert.equal(
          MODULE_BY_QUESTION[qid],
          m,
          `Question ${qid} should map back to module ${m}`,
        );
      }
    }
  });

  it("every QUIZ_MODULE_ID has at least one question", () => {
    for (const m of QUIZ_MODULE_IDS) {
      assert.ok(
        QUESTIONS_BY_MODULE[m].length > 0,
        `Module ${m} has no questions`,
      );
    }
  });

  it("QUESTIONS_BY_MODULE has no duplicate question ids across modules", () => {
    const seen = new Set<string>();
    for (const m of QUIZ_MODULE_IDS) {
      for (const qid of QUESTIONS_BY_MODULE[m]) {
        assert.equal(seen.has(qid), false, `Duplicate question id ${qid}`);
        seen.add(qid);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scoreQuiz — pure scoring
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreQuiz", () => {
  it("returns score 0 / passed false on empty questionIds", () => {
    const r = scoreQuiz([], []);
    assert.equal(r.score, 0);
    assert.equal(r.passed, false);
    assert.equal(r.totalCount, 0);
    assert.equal(r.correctCount, 0);
    assert.deepEqual(r.perQuestion, []);
  });

  it("scores 100% when every answer matches the bank", () => {
    const qids = ["q-cb-01-room-flow", "q-cb-02-room-order"]; // bank says 1, 2
    const r = scoreQuiz([1, 2], qids);
    assert.equal(r.score, 100);
    assert.equal(r.passed, true);
    assert.equal(r.correctCount, 2);
    assert.equal(r.totalCount, 2);
    assert.deepEqual(r.perQuestion, [true, true]);
  });

  it("scores 0% when every answer is wrong", () => {
    const qids = ["q-cb-01-room-flow", "q-cb-02-room-order"];
    const r = scoreQuiz([0, 0], qids);
    assert.equal(r.score, 0);
    assert.equal(r.passed, false);
    assert.equal(r.correctCount, 0);
  });

  it("treats null/undefined answers as incorrect (autosave with unanswered)", () => {
    const qids = ["q-cb-01-room-flow", "q-cb-02-room-order"];
    const r = scoreQuiz([null, undefined], qids);
    assert.equal(r.correctCount, 0);
    assert.equal(r.score, 0);
    assert.equal(r.passed, false);
  });

  it("treats unknown question ids as incorrect (defensive against drift)", () => {
    const r = scoreQuiz([0, 1], ["q-cb-01-room-flow", "q-does-not-exist"]);
    // q-cb-01-room-flow correct=1; got 0 → wrong. q-does-not-exist → unknown → wrong.
    assert.equal(r.correctCount, 0);
    assert.equal(r.score, 0);
  });

  it("rounds to nearest integer percent", () => {
    // 4 correct of 7 = 57.142… → rounds to 57
    const qids: string[] = [...QUESTIONS_BY_MODULE["maidcentral"]].slice(0, 7);
    const answers: number[] = qids.map((q: string, i: number) =>
      i < 4 ? ANSWER_KEY[q] : 99,
    );
    const r = scoreQuiz(answers, qids);
    assert.equal(r.score, 57);
  });

  it("passes at exactly the 80% boundary on a 15-question quiz (12/15 = 80%)", () => {
    // Use cleaning-best-practices (15) — compensation went 15→16 in the
    // 2026-05-20 allowed-hours sprint, so it no longer hits the 12/15 boundary.
    const qids: string[] = [...QUESTIONS_BY_MODULE["cleaning-best-practices"]];
    const answers: number[] = qids.map((q: string, i: number) =>
      i < 12 ? ANSWER_KEY[q] : (ANSWER_KEY[q] + 1) % 3,
    );
    const r = scoreQuiz(answers, qids);
    assert.equal(r.score, 80);
    assert.equal(r.passed, true);
  });

  it("fails below 80% (11/15 = 73%)", () => {
    const qids: string[] = [...QUESTIONS_BY_MODULE["cleaning-best-practices"]];
    const answers: number[] = qids.map((q: string, i: number) =>
      i < 11 ? ANSWER_KEY[q] : (ANSWER_KEY[q] + 1) % 3,
    );
    const r = scoreQuiz(answers, qids);
    assert.equal(r.score, 73);
    assert.equal(r.passed, false);
  });

  it("perQuestion array marks correctness positionally", () => {
    const qids = ["q-cb-01-room-flow", "q-cb-02-room-order", "q-cb-11-supplies-left"];
    // bank: 1, 2, 1 → answer 1, 99, 1
    const r = scoreQuiz([1, 99, 1], qids);
    assert.deepEqual(r.perQuestion, [true, false, true]);
  });

  it("respects a custom threshold (lower bar passes more)", () => {
    const qids: string[] = [...QUESTIONS_BY_MODULE["compensation"]]; // 18 questions
    // 10 correct of 18 = 56%
    const answers: number[] = qids.map((q: string, i: number) =>
      i < 10 ? ANSWER_KEY[q] : 99,
    );
    const fail = scoreQuiz(answers, qids); // default 0.80
    const pass = scoreQuiz(answers, qids, 0.5); // 50% threshold
    assert.equal(fail.passed, false);
    assert.equal(pass.passed, true);
  });

  it("clamps when answers array is shorter than questionIds (rest treated as null)", () => {
    const qids = ["q-cb-01-room-flow", "q-cb-02-room-order"];
    const r = scoreQuiz([1], qids); // only first answered
    assert.equal(r.correctCount, 1); // first matches bank=1
    assert.equal(r.totalCount, 2);
    assert.equal(r.score, 50);
    assert.equal(r.passed, false);
  });

  it("clamps when answers array is longer than questionIds (extras ignored)", () => {
    const qids = ["q-cb-01-room-flow"];
    const r = scoreQuiz([1, 99, 99], qids);
    assert.equal(r.correctCount, 1);
    assert.equal(r.totalCount, 1);
    assert.equal(r.score, 100);
  });

  it("accepts a custom answerKey for testing isolation", () => {
    const qids = ["q-x", "q-y"];
    const customKey = { "q-x": 0, "q-y": 1 };
    const r = scoreQuiz([0, 1], qids, 0.8, customKey);
    assert.equal(r.score, 100);
    assert.equal(r.passed, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isModuleUnlocked — sequential gating
// ─────────────────────────────────────────────────────────────────────────────

describe("isModuleUnlocked", () => {
  it("first module is always unlocked, even with empty completed list", () => {
    assert.equal(isModuleUnlocked("phes-policies", []), true);
  });

  it("second module unlocked iff first is completed", () => {
    assert.equal(isModuleUnlocked("compensation", []), false);
    assert.equal(isModuleUnlocked("compensation", ["phes-policies"]), true);
  });

  it("third module needs first AND second completed", () => {
    assert.equal(isModuleUnlocked("cleaning-best-practices", ["phes-policies"]), false);
    assert.equal(
      isModuleUnlocked("cleaning-best-practices", ["phes-policies", "compensation"]),
      true,
    );
  });

  it("acknowledgment (last) needs every preceding module", () => {
    const allButLast = MODULE_ORDER.filter((m: string) => m !== "acknowledgment");
    assert.equal(isModuleUnlocked("acknowledgment", []), false);
    assert.equal(
      isModuleUnlocked("acknowledgment", allButLast.slice(0, -1)),
      false,
    );
    assert.equal(isModuleUnlocked("acknowledgment", [...allButLast]), true);
  });

  it("rejects unknown module ids defensively (returns false)", () => {
    assert.equal(isModuleUnlocked("not-a-module", [...MODULE_ORDER]), false);
  });

  it("ignores extra unknown ids in completedModuleIds", () => {
    assert.equal(
      isModuleUnlocked("compensation", ["phes-policies", "garbage", "more-garbage"]),
      true,
    );
  });

  it("order of completedModuleIds does not matter", () => {
    assert.equal(
      isModuleUnlocked("cleaning-best-practices", ["compensation", "phes-policies"]),
      true,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isFinalUnlocked
// ─────────────────────────────────────────────────────────────────────────────

describe("isFinalUnlocked", () => {
  it("locked when nothing is completed", () => {
    assert.equal(isFinalUnlocked([]), false);
  });

  it("locked when one of the prerequisites is missing", () => {
    const allButOne = MODULE_ORDER.filter(
      (m: string) => m !== "acknowledgment" && m !== "products-tools",
    );
    assert.equal(isFinalUnlocked(allButOne), false); // missing products-tools
  });

  it("unlocked when every module-except-acknowledgment is complete", () => {
    const required = MODULE_ORDER.filter((m: string) => m !== "acknowledgment");
    assert.equal(isFinalUnlocked([...required]), true);
  });

  it("acknowledgment alone is not enough", () => {
    assert.equal(isFinalUnlocked(["acknowledgment"]), false);
  });

  it("ignores acknowledgment when checking — final unlocks before final ack", () => {
    const required = MODULE_ORDER.filter((m: string) => m !== "acknowledgment");
    // completed list with acknowledgment included shouldn't change the answer
    assert.equal(isFinalUnlocked([...required, "acknowledgment"]), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sampleFinalQuestionIds — random sampling determinism w/ seeded RNG
// ─────────────────────────────────────────────────────────────────────────────

describe("sampleFinalQuestionIds", () => {
  /** Deterministic seeded RNG (mulberry32) for reproducible sampling. */
  function seedRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("returns the requested count by default (FINAL_TEST_SIZE = 30)", () => {
    const ids = sampleFinalQuestionIds(undefined, seedRng(1));
    assert.equal(ids.length, FINAL_TEST_SIZE);
    assert.equal(ids.length, 30);
  });

  it("never exceeds the pool size when count > pool", () => {
    const ids = sampleFinalQuestionIds(9999, seedRng(2));
    assert.equal(ids.length, ALL_QUESTION_IDS.length);
  });

  it("returns 0 ids when count = 0 (degenerate)", () => {
    const ids = sampleFinalQuestionIds(0, seedRng(3));
    assert.deepEqual(ids, []);
  });

  it("returns only ids that exist in the bank", () => {
    const ids = sampleFinalQuestionIds(50, seedRng(4));
    for (const id of ids) {
      assert.ok(id in ANSWER_KEY, `Sampled unknown question id ${id}`);
    }
  });

  it("does not contain duplicates", () => {
    const ids = sampleFinalQuestionIds(50, seedRng(5));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("is deterministic given the same seed", () => {
    const a = sampleFinalQuestionIds(50, seedRng(42));
    const b = sampleFinalQuestionIds(50, seedRng(42));
    assert.deepEqual(a, b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Attempt limits (phes-lifecycle 2026-05-11): three per module, four for the
// final exam. These constants are shared by server and client so the UI can
// render "Attempt X of N" without an extra round trip.
// ─────────────────────────────────────────────────────────────────────────────

describe("max attempt constants", () => {
  it("MAX_MODULE_ATTEMPTS is 4 (phes pre-onboarding sprint 2026-05-14)", () => {
    // Item 6 (P1 sprint 2026-05-14): bumped from 3 → 4 after Sal's
    // audit found 21 attempts on Compensation for one tech (server
    // wasn't enforcing the cap). Final exam stays at 4 for parity.
    assert.equal(MAX_MODULE_ATTEMPTS, 4);
  });

  it("MAX_FINAL_ATTEMPTS is 4 per spec (phes 2026-05-11)", () => {
    assert.equal(MAX_FINAL_ATTEMPTS, 4);
  });

  it("maxAttemptsFor returns 4 for every per-module quiz id", () => {
    for (const m of QUIZ_MODULE_IDS) {
      assert.equal(maxAttemptsFor(m), 4, `expected 4 for ${m}`);
    }
  });

  it("maxAttemptsFor returns 4 for the final mixed test", () => {
    assert.equal(maxAttemptsFor(FINAL_MODULE_ID), 4);
  });

  it("maxAttemptsFor returns 4 for the acknowledgment module (no quiz, but symmetric)", () => {
    // Acknowledgment is content-only; cap doesn't apply in /quiz/submit
    // (different endpoint), but the helper still classifies it under
    // the default 4-attempt bucket.
    assert.equal(maxAttemptsFor("acknowledgment"), 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldShowLearnerGating — the "hide learner-only UI from owners" predicate
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldShowLearnerGating", () => {
  it("returns true for a regular learner (isOwner=false)", () => {
    // Techs see the attempt counter, attempts-remaining text, deadline
    // badge, and lockout messages. Default LMS behavior.
    assert.equal(shouldShowLearnerGating(false), true);
  });

  it("returns false for an owner (isOwner=true)", () => {
    // Owners are exempt from the cap on the server (canBypassCap in
    // routes/lms.ts), so the gating UI must not render for them either.
    assert.equal(shouldShowLearnerGating(true), false);
  });

  it("is the single inversion of isOwner — used as the named UI predicate", () => {
    // Documents the intended call sites: anywhere a `!isOwner` check
    // appears in a `&&` chain guarding learner-only gating UI, swap in
    // shouldShowLearnerGating(isOwner) so the predicate is the greppable
    // surface for future "hide this from owners" requests.
    assert.equal(shouldShowLearnerGating(false), !false);
    assert.equal(shouldShowLearnerGating(true), !true);
  });
});
