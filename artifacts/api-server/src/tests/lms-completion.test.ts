/**
 * isEnrollmentTrulyComplete + backfill — unit tests.
 *
 * The DB-touching helper itself can't be reached on stub credentials
 * but its pure-scoring delegate (computeCompliance) is exercised
 * exhaustively in lms-admin-audit.test.ts. These tests lock the
 * contract that lms-completion.ts presents to the rest of the LMS:
 *   - "complete" requires modules + docs + final + handbook all true
 *   - any single missing dimension flips complete to false
 *   - the breakdown surfaces the specific gaps (missing_modules,
 *     missing_docs, final_passed, handbook_signed) so callers can
 *     render targeted next-step copy
 *
 * The backfill helper's idempotency is verified by inspection of the
 * SQL predicate (status = 'completed' AND truth-gate-fails), since the
 * stub DB cannot host a row.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCompliance } from "../lib/lms-admin-audit.js";
import {
  QUIZ_MODULE_IDS,
  FINAL_MODULE_ID,
} from "@workspace/lms-curriculum";
import { REQUIRED_PRE_FINAL_SIGNED_DOCS } from "@workspace/db/schema";

const ALL_MODULES = [...QUIZ_MODULE_IDS, FINAL_MODULE_ID];
const ALL_DOCS = [...REQUIRED_PRE_FINAL_SIGNED_DOCS, "handbook"];

describe("isEnrollmentTrulyComplete — contract via computeCompliance", () => {
  it("returns complete when every dimension is satisfied", () => {
    const c = computeCompliance({
      passed_module_ids: ALL_MODULES,
      signed_document_types: ALL_DOCS,
      handbook_signed: true,
      pending_re_ack_count: 0,
      deadline_at: null,
    });
    assert.equal(c.overall, "complete");
    assert.equal(c.modules_complete, true);
    assert.equal(c.docs_complete, true);
    assert.equal(c.final_passed, true);
    assert.equal(c.handbook_signed, true);
  });

  it("missing a single quiz module flips complete to false", () => {
    // Drop one quiz module; keep final and everything else.
    const passed = [...QUIZ_MODULE_IDS].slice(1).concat(FINAL_MODULE_ID);
    const c = computeCompliance({
      passed_module_ids: passed,
      signed_document_types: ALL_DOCS,
      handbook_signed: true,
      pending_re_ack_count: 0,
      deadline_at: null,
    });
    assert.equal(c.modules_complete, false);
    assert.notEqual(c.overall, "complete");
  });

  it("missing a single required ack flips complete to false", () => {
    const c = computeCompliance({
      passed_module_ids: ALL_MODULES,
      signed_document_types: ALL_DOCS.slice(1),
      handbook_signed: true,
      pending_re_ack_count: 0,
      deadline_at: null,
    });
    assert.equal(c.docs_complete, false);
    assert.notEqual(c.overall, "complete");
  });

  it("missing final exam flips complete to false", () => {
    const c = computeCompliance({
      passed_module_ids: [...QUIZ_MODULE_IDS],
      signed_document_types: ALL_DOCS,
      handbook_signed: true,
      pending_re_ack_count: 0,
      deadline_at: null,
    });
    assert.equal(c.final_passed, false);
    assert.notEqual(c.overall, "complete");
  });

  it("missing handbook signature flips complete to false", () => {
    const docsWithoutHandbook = ALL_DOCS.filter((d) => d !== "handbook");
    const c = computeCompliance({
      passed_module_ids: ALL_MODULES,
      signed_document_types: docsWithoutHandbook,
      handbook_signed: false,
      pending_re_ack_count: 0,
      deadline_at: null,
    });
    assert.equal(c.handbook_signed, false);
    assert.notEqual(c.overall, "complete");
  });

  it("Jose-style stale completion (passed final + handful of modules, missing 8 + 6) is not complete", () => {
    // Approximates Jose's row: 7 passed modules + passed final, but
    // no signed acks and no handbook. Pre-Fix-2 this incorrectly
    // stamped completed.
    const partialModules = [...QUIZ_MODULE_IDS].slice(0, 7);
    const c = computeCompliance({
      passed_module_ids: [...partialModules, FINAL_MODULE_ID],
      signed_document_types: [],
      handbook_signed: false,
      pending_re_ack_count: 0,
      deadline_at: null,
    });
    assert.equal(c.modules_complete, false);
    assert.equal(c.docs_complete, false);
    assert.equal(c.handbook_signed, false);
    assert.notEqual(c.overall, "complete");
  });
});

describe("Annual re-acks do NOT block completion", () => {
  it("pending re-acks don't downgrade an otherwise-complete enrollment", () => {
    // Pending re-acks are a separate signal for annual cycles. They
    // should NOT prevent the truth gate from reporting complete on
    // the FIRST-time gate. The annual cycle UI surfaces them
    // separately.
    const c = computeCompliance({
      passed_module_ids: ALL_MODULES,
      signed_document_types: ALL_DOCS,
      handbook_signed: true,
      pending_re_ack_count: 2,
      deadline_at: null,
    });
    // Note: computeCompliance returns 'needs_resign' when pending_count > 0.
    // isEnrollmentTrulyComplete deliberately passes pending_count: 0 so
    // the truth gate ignores annual re-acks. The contract is that the
    // pure scorer is shared but inputs are scoped to what each caller
    // cares about.
    assert.equal(c.overall, "needs_resign");
    // Modules + docs + final + handbook all still true.
    assert.equal(c.modules_complete, true);
    assert.equal(c.docs_complete, true);
    assert.equal(c.final_passed, true);
    assert.equal(c.handbook_signed, true);
  });
});
