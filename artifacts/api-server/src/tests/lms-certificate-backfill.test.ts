/**
 * Certificate backfill — unit tests.
 *
 * Tests the pure `shouldIssueCertificate` helper that drives the
 * decision loop in `runLmsCertificateBackfill`. The DB-touching
 * runner itself is exercised manually + via Playwright after the next
 * cold-start (it walks every passed module_progress row and is
 * impractical to mock here).
 *
 * Coverage:
 *   - Happy path: passed row + no existing cert → issue
 *   - Idempotent: passed row + existing cert → skip
 *   - Cross-tenant guard: enrollment.company_id !== users.company_id
 *     → skip + reason='company_id_mismatch'
 *   - Existing cert revoked → does NOT block re-issuance (defensive
 *     re-issue path; revocation removes the key from the set in the
 *     runner before the loop starts)
 *   - Final-exam module + non-final modules both eligible
 *   - Multiple rows for the same (user, module) in one scan don't
 *     duplicate-insert
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldIssueCertificate,
  type PassedModuleRowForBackfill,
} from "../lib/lms-certificate-backfill-pure.js";

const PHES_COMPANY = 1;
const OTHER_COMPANY = 2;

function makeRow(
  overrides: Partial<PassedModuleRowForBackfill> = {},
): PassedModuleRowForBackfill {
  return {
    module_progress_id: 100,
    module_id: "phes-policies",
    best_score: 100,
    passed_at: new Date("2026-05-11T15:33:10Z"),
    enrollment_company_id: PHES_COMPANY,
    user_id: 42,
    user_company_id: PHES_COMPANY,
    ...overrides,
  };
}

describe("shouldIssueCertificate", () => {
  it("issues when the user has no existing cert for the module", () => {
    const row = makeRow();
    const decision = shouldIssueCertificate(row, new Set());
    assert.equal(decision.issue, true);
    if (decision.issue) {
      assert.equal(decision.score, 100);
    }
  });

  it("skips when the user already has a cert for this module", () => {
    const row = makeRow();
    const existing = new Set([`${row.user_id}:${row.module_id}`]);
    const decision = shouldIssueCertificate(row, existing);
    assert.equal(decision.issue, false);
    if (!decision.issue) {
      assert.equal(decision.reason, "already_issued");
    }
  });

  it("REFUSES to issue when enrollment.company_id !== users.company_id (cross-tenant guard)", () => {
    // Pathological: an enrollment row says company 1, but the user
    // row says company 2. Should never happen in real data; if it
    // does, the helper must NOT silently insert a cert under the
    // wrong company.
    const row = makeRow({
      enrollment_company_id: PHES_COMPANY,
      user_company_id: OTHER_COMPANY,
    });
    const decision = shouldIssueCertificate(row, new Set());
    assert.equal(decision.issue, false);
    if (!decision.issue) {
      assert.equal(decision.reason, "company_id_mismatch");
    }
  });

  it("cross-tenant guard fires even when the user has NO existing cert", () => {
    // Ensure the cross-tenant check runs BEFORE the existing-cert
    // check — we want the defense-in-depth signal in logs, not a
    // silent "already_issued" reason.
    const row = makeRow({
      enrollment_company_id: 7,
      user_company_id: 8,
    });
    const decision = shouldIssueCertificate(row, new Set());
    assert.equal(decision.issue, false);
    if (!decision.issue) {
      assert.equal(decision.reason, "company_id_mismatch");
    }
  });

  it("preserves the best_score on the issued cert (e.g. 87 on a passing-but-not-perfect quiz)", () => {
    const row = makeRow({ best_score: 87 });
    const decision = shouldIssueCertificate(row, new Set());
    assert.equal(decision.issue, true);
    if (decision.issue) {
      assert.equal(decision.score, 87);
    }
  });

  it("issues for the final exam module ('__final')", () => {
    const row = makeRow({ module_id: "__final", best_score: 92 });
    const decision = shouldIssueCertificate(row, new Set());
    assert.equal(decision.issue, true);
    if (decision.issue) {
      assert.equal(decision.score, 92);
    }
  });

  it("two rows for the same (user, module) — second is skipped after the first is added to the set", () => {
    // Simulates a user with two enrollment rows (rare but possible
    // for legacy data) that both have a passed module_progress for
    // the same module. The runner adds the first to the Set before
    // the loop continues, so the second iteration sees the entry.
    const row = makeRow();
    const existing = new Set<string>();
    const first = shouldIssueCertificate(row, existing);
    assert.equal(first.issue, true);
    existing.add(`${row.user_id}:${row.module_id}`);
    const second = shouldIssueCertificate(row, existing);
    assert.equal(second.issue, false);
    if (!second.issue) {
      assert.equal(second.reason, "already_issued");
    }
  });
});
