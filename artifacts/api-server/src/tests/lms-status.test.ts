import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeStatusFromData } from "../lib/lms-status-pure.js";
import {
  QUIZ_MODULE_IDS,
  FINAL_MODULE_ID,
} from "@workspace/lms-curriculum";
import { REQUIRED_PRE_FINAL_SIGNED_DOCS } from "@workspace/db/schema";

const ALL_PASSED_PROGRESS = QUIZ_MODULE_IDS.map((m) => ({
  module_id: m,
  status: "passed" as const,
  best_score: 90,
  attempts: 1,
}));

const ALL_DOCS_SIGNED = [...REQUIRED_PRE_FINAL_SIGNED_DOCS];

const baseInput = () => ({
  userId: 100,
  companyId: 1,
  isSandbox: false,
  enrollment: {
    deadline_at: new Date("2026-12-31T00:00:00Z"),
    last_activity_at: new Date("2026-05-14T12:00:00Z"),
  },
  progress: [] as any[],
  signedDocumentTypes: [] as string[],
  handbookSignedAt: null as Date | null,
  finalAttemptsCount: 0,
  pendingReAcks: 0,
  now: new Date("2026-05-15T12:00:00Z"),
});

describe("computeStatusFromData (Phes admin-view-consistency sprint 2026-05-15)", () => {
  it("counts modulesPassed from best_score >= 80 even when status != 'passed'", () => {
    const input = baseInput();
    // Jose case: best_score=100, status='in_progress' — should still
    // count as passed. The SSoT defensive rule fires regardless of
    // whether the recompute migration has run yet.
    input.progress = [
      {
        module_id: QUIZ_MODULE_IDS[0],
        status: "in_progress",
        best_score: 100,
        attempts: 3,
      },
      {
        module_id: QUIZ_MODULE_IDS[1],
        status: "passed",
        best_score: 85,
        attempts: 1,
      },
    ];
    const result = computeStatusFromData(input);
    assert.equal(result.modulesPassed, 2);
    assert.ok(result.passedModuleIds.includes(QUIZ_MODULE_IDS[0]));
    assert.ok(result.passedModuleIds.includes(QUIZ_MODULE_IDS[1]));
  });

  it("does NOT count modules with best_score below threshold", () => {
    const input = baseInput();
    input.progress = [
      {
        module_id: QUIZ_MODULE_IDS[0],
        status: "in_progress",
        best_score: 75,
        attempts: 2,
      },
    ];
    const result = computeStatusFromData(input);
    assert.equal(result.modulesPassed, 0);
  });

  it("resolves Final Mixed Test to 'passed' when best_score >= 80 (Jose bug)", () => {
    const input = baseInput();
    input.progress = [
      {
        module_id: FINAL_MODULE_ID,
        status: "in_progress",
        best_score: 100,
        attempts: 1,
      },
    ];
    input.finalAttemptsCount = 1;
    const result = computeStatusFromData(input);
    assert.equal(result.finalExamStatus, "passed");
    assert.equal(result.finalExamBestScore, 100);
  });

  it("resolves Final Mixed Test to 'failed' after 4 attempts with no pass", () => {
    const input = baseInput();
    input.progress = [
      {
        module_id: FINAL_MODULE_ID,
        status: "in_progress",
        best_score: 70,
        attempts: 4,
      },
    ];
    input.finalAttemptsCount = 4;
    const result = computeStatusFromData(input);
    assert.equal(result.finalExamStatus, "failed");
  });

  it("resolves Final Mixed Test to 'in_progress' when 0 < attempts < cap and no pass", () => {
    const input = baseInput();
    input.progress = [
      {
        module_id: FINAL_MODULE_ID,
        status: "in_progress",
        best_score: 65,
        attempts: 2,
      },
    ];
    input.finalAttemptsCount = 2;
    const result = computeStatusFromData(input);
    assert.equal(result.finalExamStatus, "in_progress");
  });

  it("resolves Final Mixed Test to 'not_started' when attempts is 0", () => {
    const input = baseInput();
    const result = computeStatusFromData(input);
    assert.equal(result.finalExamStatus, "not_started");
  });

  it("returns enrollmentStatus='sandbox' for sandbox accounts and excludes their progress from the aggregate label", () => {
    const input = baseInput();
    input.isSandbox = true;
    input.progress = ALL_PASSED_PROGRESS;
    input.signedDocumentTypes = ALL_DOCS_SIGNED;
    input.handbookSignedAt = new Date();
    const result = computeStatusFromData(input);
    assert.equal(result.enrollmentStatus, "sandbox");
    assert.equal(result.isSandbox, true);
  });

  it("returns enrollmentStatus='complete' only when all four gates are met", () => {
    const input = baseInput();
    input.progress = [
      ...ALL_PASSED_PROGRESS,
      {
        module_id: FINAL_MODULE_ID,
        status: "passed",
        best_score: 90,
        attempts: 1,
      },
    ];
    input.signedDocumentTypes = [...ALL_DOCS_SIGNED, "handbook"];
    input.handbookSignedAt = new Date("2026-05-14T10:00:00Z");
    input.finalAttemptsCount = 1;
    const result = computeStatusFromData(input);
    assert.equal(result.enrollmentStatus, "complete");
    assert.equal(result.modulesPassed, QUIZ_MODULE_IDS.length);
    assert.equal(result.signedDocumentsCompleted, REQUIRED_PRE_FINAL_SIGNED_DOCS.length);
    assert.equal(result.finalExamStatus, "passed");
    assert.equal(result.handbookSigned, true);
  });

  it("misses 'complete' if any one gate fails (handbook not signed)", () => {
    const input = baseInput();
    input.progress = [
      ...ALL_PASSED_PROGRESS,
      {
        module_id: FINAL_MODULE_ID,
        status: "passed",
        best_score: 90,
        attempts: 1,
      },
    ];
    input.signedDocumentTypes = ALL_DOCS_SIGNED; // no handbook
    input.finalAttemptsCount = 1;
    const result = computeStatusFromData(input);
    assert.notEqual(result.enrollmentStatus, "complete");
    assert.equal(result.handbookSigned, false);
  });

  it("counts signed documents correctly (6 required pre-final)", () => {
    const input = baseInput();
    input.signedDocumentTypes = ["drug_alcohol", "code_of_conduct"];
    const result = computeStatusFromData(input);
    assert.equal(result.signedDocumentsCompleted, 2);
    assert.equal(result.signedDocumentsTotal, REQUIRED_PRE_FINAL_SIGNED_DOCS.length);
    assert.equal(result.signedDocumentsTotal, 6);
  });

  it("picks the first un-passed module as currentModuleId", () => {
    const input = baseInput();
    input.progress = [
      {
        module_id: QUIZ_MODULE_IDS[0],
        status: "passed",
        best_score: 90,
        attempts: 1,
      },
      {
        module_id: QUIZ_MODULE_IDS[1],
        status: "passed",
        best_score: 85,
        attempts: 1,
      },
    ];
    const result = computeStatusFromData(input);
    assert.equal(result.currentModuleId, QUIZ_MODULE_IDS[2]);
  });

  it("points currentModuleId at FINAL_MODULE_ID when all 13 are passed but final isn't", () => {
    const input = baseInput();
    input.progress = ALL_PASSED_PROGRESS;
    const result = computeStatusFromData(input);
    assert.equal(result.currentModuleId, FINAL_MODULE_ID);
  });

  it("returns null currentModuleId when everything is done", () => {
    const input = baseInput();
    input.progress = [
      ...ALL_PASSED_PROGRESS,
      {
        module_id: FINAL_MODULE_ID,
        status: "passed",
        best_score: 90,
        attempts: 1,
      },
    ];
    input.finalAttemptsCount = 1;
    const result = computeStatusFromData(input);
    assert.equal(result.currentModuleId, null);
  });

  it("computes daysRemaining off enrollment.deadline_at", () => {
    const input = baseInput();
    input.enrollment = {
      deadline_at: new Date("2026-05-25T12:00:00Z"),
      last_activity_at: null,
    };
    input.now = new Date("2026-05-15T12:00:00Z");
    const result = computeStatusFromData(input);
    assert.equal(result.daysRemaining, 10);
  });

  it("returns negative daysRemaining when overdue", () => {
    const input = baseInput();
    input.enrollment = {
      deadline_at: new Date("2026-05-10T12:00:00Z"),
      last_activity_at: null,
    };
    input.now = new Date("2026-05-15T12:00:00Z");
    const result = computeStatusFromData(input);
    assert.ok((result.daysRemaining ?? 0) < 0);
  });

  it("returns daysRemaining=null when no deadline is set", () => {
    const input = baseInput();
    input.enrollment = {
      deadline_at: null,
      last_activity_at: null,
    };
    const result = computeStatusFromData(input);
    assert.equal(result.daysRemaining, null);
  });

  it("populates pendingReAcks from the input", () => {
    const input = baseInput();
    input.pendingReAcks = 3;
    const result = computeStatusFromData(input);
    assert.equal(result.pendingReAcks, 3);
  });

  it("exposes compliance.overall consistent with enrollmentStatus", () => {
    const input = baseInput();
    input.progress = [
      ...ALL_PASSED_PROGRESS,
      {
        module_id: FINAL_MODULE_ID,
        status: "passed",
        best_score: 95,
        attempts: 1,
      },
    ];
    input.signedDocumentTypes = ALL_DOCS_SIGNED;
    input.handbookSignedAt = new Date();
    input.finalAttemptsCount = 1;
    const result = computeStatusFromData(input);
    assert.equal(result.compliance.overall, "complete");
    assert.equal(result.enrollmentStatus, "complete");
  });

  it("does not count FINAL_MODULE_ID toward modulesPassed (separate gate)", () => {
    const input = baseInput();
    input.progress = [
      {
        module_id: FINAL_MODULE_ID,
        status: "passed",
        best_score: 100,
        attempts: 1,
      },
    ];
    input.finalAttemptsCount = 1;
    const result = computeStatusFromData(input);
    assert.equal(result.modulesPassed, 0);
    assert.equal(result.modulesTotal, QUIZ_MODULE_IDS.length);
    assert.equal(result.finalExamStatus, "passed");
  });
});
