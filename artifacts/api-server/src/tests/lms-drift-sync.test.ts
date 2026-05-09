/**
 * LMS — answer-key drift-sync test.
 *
 * Guards the documented invariant in @workspace/training/answer-key.ts:
 * the server-authoritative answer key MUST match the answer key shipped in
 * @workspace/lms-curriculum. If they drift, server-side scoring would
 * disagree with the frontend's immediate-feedback UX, and a regression in
 * one place could ship without the other catching it.
 *
 * The test is run as part of the LMS suite:
 *   pnpm --filter @workspace/api-server run test:lms
 *
 * Pure assertion test — no DB, no network. The DATABASE_URL stub in the
 * test:lms script keeps tsx happy if a transitive import touches the db
 * module on load.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANSWER_KEY, ALL_QUESTION_IDS } from "@workspace/lms-curriculum";
import { SERVER_ANSWER_KEY } from "@workspace/training";

describe("LMS answer-key drift-sync", () => {
  it("server answer key has exactly the same question ids as the curriculum bank", () => {
    const curriculumIds = new Set(Object.keys(ANSWER_KEY));
    const serverIds = new Set(Object.keys(SERVER_ANSWER_KEY));

    const missingFromServer = [...curriculumIds].filter(
      (id) => !serverIds.has(id),
    );
    const extraOnServer = [...serverIds].filter((id) => !curriculumIds.has(id));

    assert.deepEqual(
      missingFromServer,
      [],
      `Server answer key is missing these question ids that the curriculum has: ${missingFromServer.join(
        ", ",
      )}`,
    );
    assert.deepEqual(
      extraOnServer,
      [],
      `Server answer key has these question ids that the curriculum does not: ${extraOnServer.join(
        ", ",
      )}`,
    );
  });

  it("every question id has the same correctIndex on both sides", () => {
    const mismatches: { id: string; curriculum: number; server: number }[] = [];
    for (const id of Object.keys(ANSWER_KEY)) {
      const c = ANSWER_KEY[id];
      const s = SERVER_ANSWER_KEY[id];
      if (c !== s) {
        mismatches.push({ id, curriculum: c, server: s });
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      `Answer-key drift detected:\n${mismatches
        .map(
          (m) =>
            `  ${m.id}: curriculum=${m.curriculum} server=${m.server}`,
        )
        .join("\n")}`,
    );
  });

  it("ALL_QUESTION_IDS exactly enumerates the answer-key keys (no orphans)", () => {
    const fromConst: Set<string> = new Set<string>(ALL_QUESTION_IDS);
    const fromKeys: Set<string> = new Set<string>(Object.keys(ANSWER_KEY));
    const extraInConst: string[] = [...fromConst].filter((id: string) => !fromKeys.has(id));
    const extraInKeys: string[] = [...fromKeys].filter((id: string) => !fromConst.has(id));
    assert.deepEqual(extraInConst, [], `ALL_QUESTION_IDS has orphans not in ANSWER_KEY: ${extraInConst.join(", ")}`);
    assert.deepEqual(extraInKeys, [], `ANSWER_KEY has orphans not in ALL_QUESTION_IDS: ${extraInKeys.join(", ")}`);
  });

  it("answer key has at least one question per QUIZ_MODULE_ID (no empty quizzes)", async () => {
    const { QUIZ_MODULE_IDS, QUESTIONS_BY_MODULE } = await import(
      "@workspace/lms-curriculum"
    );
    for (const m of QUIZ_MODULE_IDS) {
      const qs = QUESTIONS_BY_MODULE[m];
      assert.ok(
        qs.length > 0,
        `Module "${m}" is in QUIZ_MODULE_IDS but has zero questions`,
      );
      for (const qid of qs) {
        assert.ok(
          qid in ANSWER_KEY,
          `Question "${qid}" is in QUESTIONS_BY_MODULE.${m} but missing from ANSWER_KEY`,
        );
      }
    }
  });
});
