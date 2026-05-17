/**
 * Regression test for the Maribel-class bug pattern in the handbook
 * eligibility + truly-complete gates.
 *
 * Original bug (PR #126 era): a learner who scored >= 80 on every quiz
 * module would see the Roster mark them complete (SSoT defensive rule)
 * but get a 403 / 409 when they tried to click "Sign Handbook" or
 * complete the enrollment, because the write-path gates used strict
 * status='passed' filters.
 *
 * This test exercises the shared pure predicate `isModulePassed` that
 * BOTH the read path (SSoT in lms-status-pure.ts:computeStatusFromData)
 * AND the write paths (lms-handbook.ts:getPassedModuleIds,
 * lms-completion.ts:isEnrollmentTrulyComplete, and the cert backfill)
 * are expected to use after the 2026-05-17 cleanup.
 *
 * If this test fails, one of those paths has regressed to strict-status
 * filtering and Maribel will be re-blocked. Do not relax the assertions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isModulePassed,
  computeStatusFromData,
} from "../lib/lms-status-pure.js";
import {
  QUIZ_MODULE_IDS,
  FINAL_MODULE_ID,
} from "@workspace/lms-curriculum";
import { REQUIRED_PRE_FINAL_SIGNED_DOCS } from "@workspace/db/schema";

describe("isModulePassed — defensive predicate shared by read + write paths", () => {
  it("returns true when status is exactly 'passed' regardless of best_score", () => {
    assert.equal(
      isModulePassed({ status: "passed", best_score: 90 }),
      true,
      "status=passed, score=90 → passed",
    );
    assert.equal(
      isModulePassed({ status: "passed", best_score: 60 }),
      true,
      "status=passed, score=60 (preserved from earlier high) → still passed",
    );
    assert.equal(
      isModulePassed({ status: "passed", best_score: 0 }),
      true,
      "status=passed, score=0 (grandfather/bypass case) → passed",
    );
  });

  it("returns true when best_score >= 80 even if status is 'in_progress' (Maribel pattern)", () => {
    // The exact data state that broke Maribel: she scored 85 on Phes
    // Policies. status was 'in_progress' because the recompute migration
    // hadn't reached her row, or the status overwrite from a retake
    // clobbered it. SSoT reported her as passed. Strict-status write
    // gates rejected her.
    assert.equal(
      isModulePassed({ status: "in_progress", best_score: 85 }),
      true,
      "the Maribel case — status lagged, best_score did not",
    );
    assert.equal(
      isModulePassed({ status: "in_progress", best_score: 80 }),
      true,
      "exactly at threshold counts as passed",
    );
    assert.equal(
      isModulePassed({ status: "failed", best_score: 100 }),
      true,
      "status='failed' from admin retake should NOT erase a 100% pass",
    );
  });

  it("returns false when both signals are below threshold", () => {
    assert.equal(
      isModulePassed({ status: "in_progress", best_score: 79 }),
      false,
      "one point below threshold is not passed",
    );
    assert.equal(
      isModulePassed({ status: "not_started", best_score: 0 }),
      false,
    );
    assert.equal(
      isModulePassed({ status: "failed", best_score: 60 }),
      false,
    );
  });

  it("handles null best_score (fresh row, never attempted) safely", () => {
    assert.equal(
      isModulePassed({ status: "not_started", best_score: null }),
      false,
    );
    assert.equal(
      isModulePassed({ status: "passed", best_score: null }),
      true,
      "status=passed with null score (bypass path) still counts",
    );
  });
});

describe("computeStatusFromData (SSoT) agrees with isModulePassed across every quiz module", () => {
  it("counts a learner as truly complete when every quiz module satisfies isModulePassed", () => {
    // Build the Maribel data state: every quiz module has
    // best_score=85 and status='in_progress'. Plus all required signed
    // docs in place, handbook signed, final exam passed. This is the
    // exact pre-conditions for the handbook sign flow + the
    // isEnrollmentTrulyComplete check.
    const progress = [
      ...QUIZ_MODULE_IDS.map((m: string) => ({
        module_id: m,
        status: "in_progress",
        best_score: 85,
        attempts: 1,
      })),
      {
        module_id: FINAL_MODULE_ID,
        status: "in_progress",
        best_score: 92,
        attempts: 1,
      },
    ];

    const result = computeStatusFromData({
      userId: 99,
      companyId: 1,
      isSandbox: false,
      enrollment: {
        deadline_at: new Date("2026-12-31T00:00:00Z"),
        last_activity_at: new Date(),
      },
      progress,
      signedDocumentTypes: [...REQUIRED_PRE_FINAL_SIGNED_DOCS, "handbook"],
      handbookSignedAt: new Date(),
      finalAttemptsCount: 1,
      pendingReAcks: 0,
      now: new Date("2026-05-17T12:00:00Z"),
    });

    // SSoT must report every quiz module as passed even with strict
    // status='in_progress'. This is the read-side behaviour that broke
    // when paired with strict-status write gates.
    assert.equal(
      result.modulesPassed,
      QUIZ_MODULE_IDS.length,
      `modulesPassed must equal ${QUIZ_MODULE_IDS.length}, got ${result.modulesPassed}. Quiz modules with best_score>=80 but status!='passed' were missed.`,
    );
    assert.equal(
      result.finalExamStatus,
      "passed",
      "final exam with best_score=92 must report as passed",
    );

    // For this data state, every quiz module must be in the passed set.
    for (const m of QUIZ_MODULE_IDS) {
      assert.ok(
        result.passedModuleIds.includes(m),
        `quiz module ${m} (best_score=85, status='in_progress') must be in passedModuleIds — Maribel-class regression detected`,
      );
    }

    // The compliance flag (modules_complete) is what the audit dashboard
    // + truly-complete check both consume. If it's false here, the
    // handbook sign flow will reject and the cert backfill will skip.
    assert.equal(
      result.compliance.modules_complete,
      true,
      "compliance.modules_complete must be true when every quiz module satisfies isModulePassed",
    );
  });

  it("DOES NOT count a learner as passed when best_score is below threshold across the board", () => {
    // Inverse case — confirm the defensive predicate isn't over-permissive.
    const progress = QUIZ_MODULE_IDS.map((m: string) => ({
      module_id: m,
      status: "in_progress",
      best_score: 70,
      attempts: 2,
    }));

    const result = computeStatusFromData({
      userId: 99,
      companyId: 1,
      isSandbox: false,
      enrollment: {
        deadline_at: new Date("2026-12-31T00:00:00Z"),
        last_activity_at: new Date(),
      },
      progress,
      signedDocumentTypes: [],
      handbookSignedAt: null,
      finalAttemptsCount: 0,
      pendingReAcks: 0,
      now: new Date("2026-05-17T12:00:00Z"),
    });

    assert.equal(result.modulesPassed, 0, "score=70 < 80 must not count");
    assert.equal(result.passedModuleIds.length, 0);
    assert.equal(result.compliance.modules_complete, false);
  });
});
