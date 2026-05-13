/**
 * Admin audit helpers — unit tests (Phase 15, PR #16).
 *
 * Covers compliance scoring + CSV serialization. The DB-touching
 * aggregation in `routes/lms-admin-audit.ts` is exercised via
 * integration testing on a live Postgres.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_CSV_HEADERS,
  buildAuditCsv,
  computeCompliance,
  toAuditCsvRow,
} from "../lib/lms-admin-audit.js";
import {
  QUIZ_MODULE_IDS,
  FINAL_MODULE_ID,
} from "@workspace/lms-curriculum";
import { REQUIRED_PRE_FINAL_SIGNED_DOCS } from "@workspace/db/schema";

const ALL_MODULES = [...QUIZ_MODULE_IDS];
const ALL_DOCS = [...REQUIRED_PRE_FINAL_SIGNED_DOCS];

const FULLY_COMPLIANT = {
  passed_module_ids: [...ALL_MODULES, FINAL_MODULE_ID],
  signed_document_types: [...ALL_DOCS],
  handbook_signed: true,
  pending_re_ack_count: 0,
  deadline_at: null,
};

describe("computeCompliance", () => {
  it("returns overall='complete' when every dimension is satisfied", () => {
    const c = computeCompliance(FULLY_COMPLIANT);
    assert.equal(c.modules_complete, true);
    assert.equal(c.docs_complete, true);
    assert.equal(c.final_passed, true);
    assert.equal(c.handbook_signed, true);
    assert.equal(c.pending_count, 0);
    assert.equal(c.overall, "complete");
  });

  it("returns 'needs_resign' when pending re-acks are open (even if everything else green)", () => {
    const c = computeCompliance({
      ...FULLY_COMPLIANT,
      pending_re_ack_count: 1,
    });
    assert.equal(c.overall, "needs_resign");
  });

  it("returns 'overdue' when deadline is past and not all dimensions are green", () => {
    const past = new Date("2025-12-31T00:00:00Z");
    const now = new Date("2026-05-13T00:00:00Z");
    const c = computeCompliance({
      passed_module_ids: [],
      signed_document_types: [],
      handbook_signed: false,
      pending_re_ack_count: 0,
      deadline_at: past,
      now,
    });
    assert.equal(c.overall, "overdue");
  });

  it("returns 'in_progress' when deadline is in the future and not complete", () => {
    const future = new Date("2027-01-01T00:00:00Z");
    const now = new Date("2026-05-13T00:00:00Z");
    const c = computeCompliance({
      passed_module_ids: [ALL_MODULES[0]],
      signed_document_types: [],
      handbook_signed: false,
      pending_re_ack_count: 0,
      deadline_at: future,
      now,
    });
    assert.equal(c.overall, "in_progress");
  });

  it("returns 'in_progress' when deadline is null and not complete", () => {
    const c = computeCompliance({
      passed_module_ids: [],
      signed_document_types: [],
      handbook_signed: false,
      pending_re_ack_count: 0,
      deadline_at: null,
    });
    assert.equal(c.overall, "in_progress");
  });

  it("modules_complete is false until ALL QUIZ_MODULE_IDS are passed", () => {
    const c = computeCompliance({
      ...FULLY_COMPLIANT,
      passed_module_ids: ALL_MODULES.slice(0, -1).concat(FINAL_MODULE_ID),
    });
    assert.equal(c.modules_complete, false);
    assert.notEqual(c.overall, "complete");
  });

  it("docs_complete is false when any REQUIRED_PRE_FINAL_SIGNED_DOCS slug is missing", () => {
    const c = computeCompliance({
      ...FULLY_COMPLIANT,
      signed_document_types: ALL_DOCS.slice(1),
    });
    assert.equal(c.docs_complete, false);
    assert.notEqual(c.overall, "complete");
  });

  it("final_passed is false without FINAL_MODULE_ID in passed_module_ids", () => {
    const c = computeCompliance({
      ...FULLY_COMPLIANT,
      passed_module_ids: [...ALL_MODULES],
    });
    assert.equal(c.final_passed, false);
    assert.notEqual(c.overall, "complete");
  });

  it("clamps negative pending counts to zero", () => {
    const c = computeCompliance({
      ...FULLY_COMPLIANT,
      pending_re_ack_count: -5,
    });
    assert.equal(c.pending_count, 0);
    assert.equal(c.overall, "complete");
  });

  it("deadline_at as ISO string parses correctly", () => {
    const c = computeCompliance({
      passed_module_ids: [],
      signed_document_types: [],
      handbook_signed: false,
      pending_re_ack_count: 0,
      deadline_at: "2025-01-01T00:00:00Z",
      now: new Date("2026-05-13T00:00:00Z"),
    });
    assert.equal(c.overall, "overdue");
  });

  it("garbage deadline_at falls back to 'in_progress' (does not crash)", () => {
    const c = computeCompliance({
      passed_module_ids: [],
      signed_document_types: [],
      handbook_signed: false,
      pending_re_ack_count: 0,
      deadline_at: "not a date",
    });
    assert.equal(c.overall, "in_progress");
  });
});

describe("AUDIT_CSV_HEADERS", () => {
  it("includes the required columns", () => {
    const required = [
      "user_id",
      "full_name",
      "email",
      "role",
      "modules_complete",
      "docs_complete",
      "final_passed",
      "handbook_signed",
      "pending_count",
      "overall",
    ];
    for (const col of required) {
      assert.ok(
        (AUDIT_CSV_HEADERS as readonly string[]).includes(col),
        `missing column ${col}`,
      );
    }
  });
});

describe("toAuditCsvRow", () => {
  const baseRow = {
    user_id: 7,
    full_name: "Jane Doe",
    email: "jane@phes.io",
    role: "technician",
    hire_date: "2026-01-15",
    enrolled_at: new Date("2026-01-15T00:00:00Z"),
    deadline_at: new Date("2026-12-31T23:59:59Z"),
    completed_at: null,
    last_activity_at: new Date("2026-05-13T12:00:00Z"),
    compliance: computeCompliance(FULLY_COMPLIANT),
    handbook_signed_at: new Date("2026-04-01T00:00:00Z"),
    final_passed_at: new Date("2026-03-15T00:00:00Z"),
  };

  it("serializes booleans as 'true'/'false'", () => {
    const line = toAuditCsvRow(baseRow);
    assert.ok(line.includes(",true,true,true,true,"));
  });

  it("serializes dates as ISO strings", () => {
    const line = toAuditCsvRow(baseRow);
    assert.ok(line.includes("2026-12-31T23:59:59.000Z"));
  });

  it("escapes commas inside fields with quotes", () => {
    const line = toAuditCsvRow({
      ...baseRow,
      full_name: "Doe, Jane",
    });
    assert.ok(line.includes(`,"Doe, Jane",`));
  });

  it("escapes embedded quotes by doubling them", () => {
    const line = toAuditCsvRow({
      ...baseRow,
      full_name: 'Jane "Q" Doe',
    });
    assert.ok(line.includes(`"Jane ""Q"" Doe"`));
  });

  it("serializes null fields as empty cells", () => {
    const line = toAuditCsvRow({
      ...baseRow,
      hire_date: null,
      completed_at: null,
      handbook_signed_at: null,
      final_passed_at: null,
    });
    const cells = line.split(",");
    // Indexes for hire_date (4), completed_at (7), handbook_signed_at (15),
    // final_passed_at (16). Trust the header order.
    assert.equal(cells[4], "");
    assert.equal(cells[7], "");
  });
});

describe("buildAuditCsv", () => {
  it("returns headers + each row on a separate line, trailing newline", () => {
    const csv = buildAuditCsv([]);
    assert.equal(csv.startsWith(AUDIT_CSV_HEADERS.join(",")), true);
    assert.equal(csv.endsWith("\n"), true);
    assert.equal(csv.split("\n").length, 2); // header + trailing empty
  });

  it("emits one data row per input", () => {
    const baseRow = {
      user_id: 1,
      full_name: "Alice",
      email: "a@phes.io",
      role: "technician",
      hire_date: null,
      enrolled_at: null,
      deadline_at: null,
      completed_at: null,
      last_activity_at: null,
      compliance: computeCompliance(FULLY_COMPLIANT),
      handbook_signed_at: null,
      final_passed_at: null,
    };
    const csv = buildAuditCsv([baseRow, baseRow, baseRow]);
    const lines = csv.split("\n");
    assert.equal(lines.length, 5); // header + 3 rows + trailing empty
  });
});
