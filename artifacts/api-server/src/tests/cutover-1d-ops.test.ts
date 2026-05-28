/**
 * Cutover 1D — Office live-view tests.
 *
 * The integrity gates for 1D:
 *
 *   1. Tenant isolation — every endpoint scopes by req.auth!.companyId.
 *      Route source greps assert nothing reads companyId from the body
 *      or query and that every WHERE has an eq(...company_id, companyId)
 *      clause.
 *
 *   2. Role gate — techs (non-office roles) get 403. The route file
 *      applies `requireRole("owner", "admin", "office", "super_admin")`
 *      at the router level so EVERY endpoint inherits it. We assert
 *      the role list and the use() ordering.
 *
 *   3. Late-detection uses LATE_THRESHOLD_MINUTES from the shared
 *      constants (mirrors lib/job-status.ts). Verified by grep + a
 *      direct re-export check.
 *
 *   4. Clock-correction NEVER overwrites the original — this was
 *      tested in 1C (cutover-1c-clock-integrity.test.ts) but we
 *      re-assert the office route still uses INSERT, not UPDATE, on
 *      the corrections handler. Defense in depth: a refactor on the
 *      office side cannot break the audit guarantee.
 *
 *   5. Exception review marks reviewed without altering the underlying
 *      event (only sets exception_reviewed_by_user_id +
 *      exception_reviewed_at).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LATE_THRESHOLD_MINUTES, NO_SHOW_WAIT_MINUTES } from "../lib/job-status-constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 2. Tenant isolation + role gate (route source)
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1D — role gate (techs blocked)", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/ops.ts"),
    "utf8",
  );

  it("ops.ts applies requireRole(owner, admin, office, super_admin) at the router level", () => {
    assert.ok(
      /router\.use\(requireAuth, officeOnly\)/.test(src),
      "ops.ts must apply requireAuth + officeOnly at the router level so EVERY endpoint inherits",
    );
    assert.ok(
      /const officeOnly = requireRole\("owner", "admin", "office", "super_admin"\)/.test(src),
      "ops.ts must restrict to owner/admin/office/super_admin (techs 403)",
    );
  });

  it("ops.ts does NOT include 'technician' or 'team_lead' in the role gate", () => {
    assert.ok(
      !/requireRole\([^)]*technician[^)]*\)/.test(src),
      "ops.ts must NOT permit technicians",
    );
    assert.ok(
      !/requireRole\([^)]*team_lead[^)]*\)/.test(src),
      "ops.ts must NOT permit team_lead",
    );
  });
});

describe("Cutover 1D — tenant isolation (route source)", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/ops.ts"),
    "utf8",
  );

  it("ops.ts sources companyId from req.auth!.companyId only", () => {
    assert.ok(
      /req\.auth!\.companyId/.test(src),
      "ops.ts must source companyId from req.auth!.companyId",
    );
    assert.ok(
      !/req\.body\.company_?id|req\.query\.company_?id/i.test(src),
      "ops.ts must NEVER read company_id from body or query",
    );
  });

  it("every db.select in ops.ts is followed by a WHERE that filters on company_id", () => {
    // Cheap structural assertion: every db.select(...).from(...)...where
    // chain in this file should contain `eq(...company_id, companyId)`.
    // Count select chains vs the company_id WHERE clauses — they should
    // match.
    const selectCount = (src.match(/db\s*\.select\(/g) ?? []).length;
    const companyIdWhereCount = (src.match(/\.company_id,\s*companyId\)/g) ?? []).length;
    assert.ok(
      companyIdWhereCount >= selectCount,
      `ops.ts has ${selectCount} db.select chains but only ${companyIdWhereCount} company_id WHERE clauses — tenant scoping gap`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Late-detection constants
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1D — late-detection constants", () => {
  it("LATE_THRESHOLD_MINUTES matches the frontend value (20)", () => {
    assert.equal(LATE_THRESHOLD_MINUTES, 20);
  });

  it("NO_SHOW_WAIT_MINUTES matches the frontend value (20)", () => {
    assert.equal(NO_SHOW_WAIT_MINUTES, 20);
  });

  it("ops.ts imports LATE_THRESHOLD_MINUTES from job-status-constants", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/routes/ops.ts"),
      "utf8",
    );
    assert.ok(
      /import\s+\{[^}]*LATE_THRESHOLD_MINUTES[^}]*\}\s+from\s+"\.\.\/lib\/job-status-constants/.test(src),
      "ops.ts must import LATE_THRESHOLD_MINUTES from lib/job-status-constants",
    );
    assert.ok(
      !/const\s+LATE_THRESHOLD_MINUTES\s*=/.test(src),
      "ops.ts must NOT redefine LATE_THRESHOLD_MINUTES locally — use the shared constant",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Clock-correction never-overwrites (defense in depth at the 1D layer)
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1D — office correction route still append-only (1C reused)", () => {
  // The 1D UI calls the 1C write endpoint — but we re-assert here so
  // the office-side audit guarantee is part of the 1D gate. Same grep
  // pattern as cutover-1c-clock-integrity.test.ts.
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/office-clock.ts"),
    "utf8",
  );

  it("office-clock.ts clock-correction handler INSERTs, never UPDATEs", () => {
    const matchIdx = src.indexOf('"/jobs/:jobId/clock-correction"');
    assert.ok(matchIdx >= 0, "1D depends on office-clock.ts correction handler");
    const blockEnd = src.indexOf('"/clock-exceptions"', matchIdx);
    const block = src.slice(matchIdx, blockEnd);
    assert.ok(
      /\.insert\(jobClockEventsTable\)/.test(block),
      "correction handler must INSERT a new event",
    );
    assert.ok(
      !/\.update\(jobClockEventsTable\)/.test(block),
      "correction handler must NOT update the existing event row",
    );
  });

  it("office-clock.ts exception-review handler only sets reviewed_*  fields", () => {
    const matchIdx = src.indexOf('"/clock-exceptions/:id/review"');
    assert.ok(matchIdx >= 0);
    const block = src.slice(matchIdx, matchIdx + 1500);
    // The review handler updates the existing row to set the reviewed
    // metadata, but it must NOT touch the source-of-truth fields
    // (event_at, latitude, longitude, exception_reason).
    const updateMatch = /\.update\(jobClockEventsTable\)\s*\.set\(\{([^}]+)\}/.exec(block);
    assert.ok(updateMatch, "review handler must use .update().set({...}) on jobClockEvents");
    const setFields = updateMatch[1];
    assert.ok(
      !/event_at|latitude|longitude|exception_reason/.test(setFields),
      "review handler must NOT alter source-of-truth fields",
    );
    assert.ok(
      /exception_reviewed_by_user_id/.test(setFields),
      "review handler must set exception_reviewed_by_user_id",
    );
    assert.ok(
      /exception_reviewed_at/.test(setFields),
      "review handler must set exception_reviewed_at",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Endpoint surface — every spec endpoint is wired
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1D — endpoint surface (route source)", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/ops.ts"),
    "utf8",
  );

  const required = [
    '"/today/summary"',
    '"/today/active-jobs"',
    '"/today/exceptions"',
    '"/today/live-locations"',
    '"/jobs/:jobId/detail"',
  ];
  for (const ep of required) {
    it(`ops.ts declares endpoint ${ep}`, () => {
      assert.ok(src.includes(ep), `ops.ts must declare ${ep}`);
    });
  }

  it("routes/index.ts mounts ops at /api/ops", () => {
    const idxSrc = readFileSync(
      path.resolve(process.cwd(), "src/routes/index.ts"),
      "utf8",
    );
    assert.ok(
      /router\.use\("\/ops",\s*opsRouter\)/.test(idxSrc),
      "routes/index.ts must mount opsRouter at /ops",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Filter contract (the workhorse list's filter pill values)
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1D — active-jobs filter contract", () => {
  const src = readFileSync(
    path.resolve(process.cwd(), "src/routes/ops.ts"),
    "utf8",
  );

  // The page UI builds filter pills with these values. If the server
  // drops one, the pill silently does nothing — guard via grep.
  const filters = ["all", "in_progress", "late", "exceptions", "complete", "pending"];
  for (const f of filters) {
    it(`ops.ts handles filter='${f}'`, () => {
      assert.ok(
        src.includes(`case "${f}":`),
        `ops.ts active-jobs handler must implement filter='${f}'`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Schema cross-checks (1C tables present so 1D can read them)
// ─────────────────────────────────────────────────────────────────────────────

describe("Cutover 1D — 1C dependencies present in schema", () => {
  it("jobClockEventsTable exposes exception_reviewed_at + correction fields", async () => {
    const { jobClockEventsTable } = await import("@workspace/db/schema");
    const cols: any = jobClockEventsTable;
    assert.ok(cols.exception_reviewed_at);
    assert.ok(cols.exception_reviewed_by_user_id);
    assert.ok(cols.is_correction);
    assert.ok(cols.correction_of_event_id);
    assert.ok(cols.correction_old_value);
  });

  it("jobWorksheetTable + technicianNotesTable + onMyWayEventsTable are present", async () => {
    const schema = await import("@workspace/db/schema");
    assert.ok((schema as any).jobWorksheetTable);
    assert.ok((schema as any).technicianNotesTable);
    assert.ok((schema as any).onMyWayEventsTable);
  });
});
