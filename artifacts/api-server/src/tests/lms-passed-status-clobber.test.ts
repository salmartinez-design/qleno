/**
 * Regression test for the Katie-class /module/start clobber bug.
 *
 * Original bug (2026-05-21 report, learner: Katie):
 *   - Katie passed Phes Policies quiz (status='passed', best_score=97,
 *     passed_at='2026-05-20T22:14:55Z', attempts=1).
 *   - Katie reopened the module the next day to review.
 *   - Frontend auto-fires `POST /lms/module/start` on view.
 *   - The route handler unconditionally wrote
 *     `{ status: 'in_progress', started_at: now }` into the upsert.
 *   - The defensive SSoT read predicate (`isModulePassed`, which honors
 *     `best_score >= 80`) still showed her as passed in admin views, but
 *     the persisted row was clobbered to 'in_progress'.
 *   - Consequence: the frontend "Resume Quiz" CTA re-opened the quiz UI
 *     with all answers cleared and let her retake an already-passed
 *     module. Defeats the whole pass concept.
 *
 * Fix: route handler now delegates to `canDowngradeToInProgress` so the
 * decision is shared with the read path. If the existing row satisfies
 * `isModulePassed`, the patch OMITS `status` so the upsert preserves the
 * passed state. If the row is genuinely in-progress / failed / fresh,
 * the patch includes `status: 'in_progress'` as before.
 *
 * Do NOT relax these assertions. If they fail, either the route handler
 * regressed to unconditional status writes, or the predicate was made
 * stricter and a Maribel/Katie-pattern row will be silently downgraded.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canDowngradeToInProgress,
  isModulePassed,
} from "../lib/lms-status-pure.js";

describe("canDowngradeToInProgress — /module/start clobber guard", () => {
  it("returns true when no row exists yet (fresh start)", () => {
    // First time the learner opens the module — there's no row to
    // protect. Route handler may write status='in_progress'.
    assert.equal(
      canDowngradeToInProgress(undefined),
      true,
      "fresh insert path must be allowed to set in_progress",
    );
  });

  it("returns true when the row is genuinely in-progress (sub-threshold)", () => {
    assert.equal(
      canDowngradeToInProgress({ status: "in_progress", best_score: 60 }),
      true,
      "in-progress, score 60 → still allowed to reaffirm in_progress",
    );
    assert.equal(
      canDowngradeToInProgress({ status: "in_progress", best_score: 79 }),
      true,
      "one point below threshold → still in-progress",
    );
    assert.equal(
      canDowngradeToInProgress({ status: "not_started", best_score: 0 }),
      true,
      "not_started → fresh, allowed",
    );
    assert.equal(
      canDowngradeToInProgress({ status: "failed", best_score: 60 }),
      true,
      "failed with sub-threshold score → may resume as in_progress",
    );
  });

  it("returns FALSE when status is exactly 'passed' (canonical pass state)", () => {
    // The clean case — a properly recorded pass. Reopening must not
    // overwrite this with 'in_progress'.
    assert.equal(
      canDowngradeToInProgress({ status: "passed", best_score: 97 }),
      false,
      "passed at 97% must not be downgraded by /module/start",
    );
    assert.equal(
      canDowngradeToInProgress({ status: "passed", best_score: 80 }),
      false,
      "passed at threshold must not be downgraded",
    );
    assert.equal(
      canDowngradeToInProgress({ status: "passed", best_score: 0 }),
      false,
      "grandfather/bypass pass (status=passed, score=0) must not be downgraded",
    );
  });

  it("returns FALSE for the Maribel-class lag pattern (status='in_progress' but best_score>=80)", () => {
    // The defensive predicate covers rows where the recompute migration
    // hasn't reached the row yet, or an admin retake clobbered status
    // but the GREATEST() preserved the original best_score. Viewing such
    // a row must NOT entrench the bad status — it must be left alone so
    // the recompute can heal it on next cold-start.
    assert.equal(
      canDowngradeToInProgress({ status: "in_progress", best_score: 85 }),
      false,
      "Maribel pattern: status lagged, best_score didn't — protect it",
    );
    assert.equal(
      canDowngradeToInProgress({ status: "failed", best_score: 100 }),
      false,
      "admin retake regressed status to 'failed' but score is 100 → still a pass; do not downgrade",
    );
  });

  it("returns FALSE for the exact Katie row pattern from the 2026-05-21 bug report", () => {
    // Production data state pre-fix:
    //   id=117, status='in_progress', best_score=97,
    //   passed_at='2026-05-20T22:14:55Z', attempts=1
    // She got into this state because she viewed the module after passing.
    // Even AFTER the fix is shipped, on next cold-start runStatusRecompute
    // will heal the row to status='passed'. Until then, the route handler
    // must not deepen the damage by re-writing in_progress on every view.
    const katieRow = {
      status: "in_progress",
      best_score: 97,
    };
    assert.equal(
      isModulePassed(katieRow),
      true,
      "Katie row must satisfy the defensive predicate",
    );
    assert.equal(
      canDowngradeToInProgress(katieRow),
      false,
      "Katie row must be protected from further /module/start clobbers",
    );
  });

  it("agrees with isModulePassed on every case (contract invariant)", () => {
    // canDowngradeToInProgress = NOT isModulePassed(existing) when existing
    // is defined. Lock that relationship so a future refactor can't drift
    // the two predicates.
    const cases: Array<{ status: string; best_score: number | null }> = [
      { status: "passed", best_score: 100 },
      { status: "passed", best_score: 80 },
      { status: "passed", best_score: 0 },
      { status: "passed", best_score: null },
      { status: "in_progress", best_score: 100 },
      { status: "in_progress", best_score: 80 },
      { status: "in_progress", best_score: 79 },
      { status: "in_progress", best_score: 0 },
      { status: "in_progress", best_score: null },
      { status: "failed", best_score: 100 },
      { status: "failed", best_score: 60 },
      { status: "not_started", best_score: 0 },
    ];
    for (const row of cases) {
      const passed = isModulePassed(row);
      const canDowngrade = canDowngradeToInProgress(row);
      assert.equal(
        canDowngrade,
        !passed,
        `contract drift: row=${JSON.stringify(row)} isModulePassed=${passed} canDowngradeToInProgress=${canDowngrade} (expected ${!passed})`,
      );
    }
  });
});
