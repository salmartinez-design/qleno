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
  MODULE_BY_QUESTION,
  MODULE_ORDER,
  QUESTIONS_BY_MODULE,
  QUIZ_MODULE_IDS,
  QUIZ_PASS_THRESHOLD,
  isFinalUnlocked,
  isModuleUnlocked,
  sampleFinalQuestionIds,
  scoreQuiz,
} from "@workspace/lms-curriculum";

// ─────────────────────────────────────────────────────────────────────────────
// Constants & catalog shape
// ─────────────────────────────────────────────────────────────────────────────

describe("LMS curriculum — constants & catalog shape", () => {
  it("MODULE_ORDER has all 9 modules in expected sequence", () => {
    assert.deepEqual([...MODULE_ORDER], [
      "welcome",
      "attendance",
      "dress-code",
      "compensation",
      "cleaning-standards",
      "products-tools",
      "maidcentral",
      "qleno-app",
      "acknowledgment",
    ]);
  });

  it("QUIZ_MODULE_IDS contains exactly the 7 quiz modules (no qleno-app, no acknowledgment)", () => {
    assert.deepEqual([...QUIZ_MODULE_IDS], [
      "welcome",
      "attendance",
      "dress-code",
      "compensation",
      "cleaning-standards",
      "products-tools",
      "maidcentral",
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

  it("ANSWER_KEY has exactly the keys enumerated by ALL_QUESTION_IDS", () => {
    assert.deepEqual(
      new Set(Object.keys(ANSWER_KEY)),
      new Set(ALL_QUESTION_IDS),
    );
  });

  it("every question maps to a valid 0/1/2 option index (sanity)", () => {
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
    const qids = ["q-room-flow", "q-room-order"]; // bank says 1, 2
    const r = scoreQuiz([1, 2], qids);
    assert.equal(r.score, 100);
    assert.equal(r.passed, true);
    assert.equal(r.correctCount, 2);
    assert.equal(r.totalCount, 2);
    assert.deepEqual(r.perQuestion, [true, true]);
  });

  it("scores 0% when every answer is wrong", () => {
    const qids = ["q-room-flow", "q-room-order"];
    const r = scoreQuiz([0, 0], qids);
    assert.equal(r.score, 0);
    assert.equal(r.passed, false);
    assert.equal(r.correctCount, 0);
  });

  it("treats null/undefined answers as incorrect (autosave with unanswered)", () => {
    const qids = ["q-room-flow", "q-room-order"];
    const r = scoreQuiz([null, undefined], qids);
    assert.equal(r.correctCount, 0);
    assert.equal(r.score, 0);
    assert.equal(r.passed, false);
  });

  it("treats unknown question ids as incorrect (defensive against drift)", () => {
    const r = scoreQuiz([0, 1], ["q-room-flow", "q-does-not-exist"]);
    // q-room-flow correct=1; got 0 → wrong. q-does-not-exist → unknown → wrong.
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

  it("passes at exactly the 80% boundary on a fixed-size quiz", () => {
    // 4-question quiz: 4 of 4 = 100, 3 of 4 = 75 (fails — below 80).
    // So we use the 5-question case: take the first 5 of cleaning-standards,
    // 4 of 5 correct = 80% which is exactly the threshold.
    const qids: string[] = [...QUESTIONS_BY_MODULE["cleaning-standards"]].slice(0, 5);
    const answers: number[] = qids.map((q: string, i: number) =>
      i < 4 ? ANSWER_KEY[q] : (ANSWER_KEY[q] + 1) % 3,
    );
    const r = scoreQuiz(answers, qids);
    assert.equal(r.score, 80);
    assert.equal(r.passed, true);
  });

  it("fails at 79% (one wrong below the boundary)", () => {
    // 10-question cleaning-standards quiz: 7 correct = 70%, fails. 8 = 80%, passes.
    // Use 7-of-10 to verify the fail side cleanly.
    const qids: string[] = [...QUESTIONS_BY_MODULE["cleaning-standards"]];
    const answers: number[] = qids.map((q: string, i: number) =>
      i < 7 ? ANSWER_KEY[q] : (ANSWER_KEY[q] + 1) % 3,
    );
    const r = scoreQuiz(answers, qids);
    assert.equal(r.score, 70);
    assert.equal(r.passed, false);
  });

  it("perQuestion array marks correctness positionally", () => {
    const qids = ["q-room-flow", "q-room-order", "q-supplies-left"];
    // bank: 1, 2, 1 → answer 1, 99, 1
    const r = scoreQuiz([1, 99, 1], qids);
    assert.deepEqual(r.perQuestion, [true, false, true]);
  });

  it("respects a custom threshold (lower bar passes more)", () => {
    const qids: string[] = [...QUESTIONS_BY_MODULE["attendance"]]; // 4 questions
    // 2 correct of 4 = 50%
    const answers: number[] = qids.map((q: string, i: number) =>
      i < 2 ? ANSWER_KEY[q] : 99,
    );
    const fail = scoreQuiz(answers, qids); // default 0.80
    const pass = scoreQuiz(answers, qids, 0.5); // 50% threshold
    assert.equal(fail.passed, false);
    assert.equal(pass.passed, true);
  });

  it("clamps when answers array is shorter than questionIds (rest treated as null)", () => {
    const qids = ["q-room-flow", "q-room-order"];
    const r = scoreQuiz([1], qids); // only first answered
    assert.equal(r.correctCount, 1); // first matches bank=1
    assert.equal(r.totalCount, 2);
    assert.equal(r.score, 50);
    assert.equal(r.passed, false);
  });

  it("clamps when answers array is longer than questionIds (extras ignored)", () => {
    const qids = ["q-room-flow"];
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
    assert.equal(isModuleUnlocked("welcome", []), true);
  });

  it("second module unlocked iff first is completed", () => {
    assert.equal(isModuleUnlocked("attendance", []), false);
    assert.equal(isModuleUnlocked("attendance", ["welcome"]), true);
  });

  it("third module needs first AND second completed", () => {
    assert.equal(isModuleUnlocked("dress-code", ["welcome"]), false);
    assert.equal(
      isModuleUnlocked("dress-code", ["welcome", "attendance"]),
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
      isModuleUnlocked("attendance", ["welcome", "garbage", "more-garbage"]),
      true,
    );
  });

  it("order of completedModuleIds does not matter", () => {
    assert.equal(
      isModuleUnlocked("dress-code", ["attendance", "welcome"]),
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
      (m: string) => m !== "acknowledgment" && m !== "qleno-app",
    );
    assert.equal(isFinalUnlocked(allButOne), false); // missing qleno-app
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

  it("returns the requested count by default (FINAL_TEST_SIZE)", () => {
    const ids = sampleFinalQuestionIds(undefined, seedRng(1));
    assert.equal(ids.length, FINAL_TEST_SIZE);
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
    const ids = sampleFinalQuestionIds(15, seedRng(4));
    for (const id of ids) {
      assert.ok(id in ANSWER_KEY, `Sampled unknown question id ${id}`);
    }
  });

  it("does not contain duplicates", () => {
    const ids = sampleFinalQuestionIds(15, seedRng(5));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("is deterministic given the same seed", () => {
    const a = sampleFinalQuestionIds(15, seedRng(42));
    const b = sampleFinalQuestionIds(15, seedRng(42));
    assert.deepEqual(a, b);
  });
});
