/**
 * LMS Onboarding Intake — unit tests.
 *
 * Pure tests over the routes' helper functions. The DB-touching
 * endpoints (GET /me, POST /save, GET /admin/learner/:userId,
 * GET /admin/export) require a live Postgres + signed JWTs and are
 * exercised by manual / integration testing.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:lms
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INTAKE_REQUIRED_FIELDS,
  boolOr,
  csvCell,
  dateOrNull,
  isIntakeSubmittable,
  trimOrNull,
} from "../lib/lms-onboarding-intake-helpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// trimOrNull
// ─────────────────────────────────────────────────────────────────────────────

describe("trimOrNull", () => {
  it("returns the trimmed string when non-empty", () => {
    assert.equal(trimOrNull("  Jose  "), "Jose");
  });

  it("returns null for empty string", () => {
    assert.equal(trimOrNull(""), null);
  });

  it("returns null for whitespace-only string", () => {
    assert.equal(trimOrNull("   "), null);
  });

  it("returns null for undefined", () => {
    assert.equal(trimOrNull(undefined), null);
  });

  it("returns null for null", () => {
    assert.equal(trimOrNull(null), null);
  });

  it("returns null for non-string values (number, boolean, object)", () => {
    assert.equal(trimOrNull(42), null);
    assert.equal(trimOrNull(true), null);
    assert.equal(trimOrNull({}), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// boolOr
// ─────────────────────────────────────────────────────────────────────────────

describe("boolOr", () => {
  it("returns true when value is true", () => {
    assert.equal(boolOr(true, false), true);
  });

  it("returns false when value is false", () => {
    assert.equal(boolOr(false, true), false);
  });

  it("returns fallback for undefined", () => {
    assert.equal(boolOr(undefined, true), true);
    assert.equal(boolOr(undefined, false), false);
  });

  it("returns fallback for non-boolean values (defends against truthy coercion)", () => {
    // Strings + numbers would coerce to truthy under naive Boolean(v).
    // We require an explicit boolean.
    assert.equal(boolOr("true", false), false);
    assert.equal(boolOr("false", true), true);
    assert.equal(boolOr(1, false), false);
    assert.equal(boolOr(0, true), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dateOrNull
// ─────────────────────────────────────────────────────────────────────────────

describe("dateOrNull", () => {
  it("accepts YYYY-MM-DD", () => {
    assert.equal(dateOrNull("2026-05-13"), "2026-05-13");
  });

  it("trims surrounding whitespace before validation", () => {
    assert.equal(dateOrNull("  2026-05-13  "), "2026-05-13");
  });

  it("returns null for empty string", () => {
    assert.equal(dateOrNull(""), null);
  });

  it("returns null for whitespace-only string", () => {
    assert.equal(dateOrNull("   "), null);
  });

  it("returns null for non-YYYY-MM-DD strings (defensive against Date.toString())", () => {
    assert.equal(dateOrNull("May 13, 2026"), null);
    assert.equal(dateOrNull("Wed May 13 2026 12:00:00 GMT-0500"), null);
    assert.equal(dateOrNull("13/05/2026"), null);
    assert.equal(dateOrNull("2026-5-13"), null);
    assert.equal(dateOrNull("2026-05-13T12:00:00Z"), null);
  });

  it("returns null for non-string input", () => {
    assert.equal(dateOrNull(20260513), null);
    assert.equal(dateOrNull(new Date()), null);
    assert.equal(dateOrNull(undefined), null);
    assert.equal(dateOrNull(null), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INTAKE_REQUIRED_FIELDS + isIntakeSubmittable
// ─────────────────────────────────────────────────────────────────────────────

describe("INTAKE_REQUIRED_FIELDS", () => {
  it("lists exactly the three emergency-contact fields", () => {
    assert.deepEqual([...INTAKE_REQUIRED_FIELDS], [
      "emergency_contact_name",
      "emergency_contact_relationship",
      "emergency_contact_phone",
    ]);
  });
});

describe("isIntakeSubmittable", () => {
  it("returns true when all three required fields are populated", () => {
    assert.equal(
      isIntakeSubmittable({
        emergency_contact_name: "Maria Ardila",
        emergency_contact_relationship: "Spouse",
        emergency_contact_phone: "+1-708-555-0142",
      }),
      true,
    );
  });

  it("returns false when emergency_contact_name is missing", () => {
    assert.equal(
      isIntakeSubmittable({
        emergency_contact_name: null,
        emergency_contact_relationship: "Spouse",
        emergency_contact_phone: "+1-708-555-0142",
      }),
      false,
    );
  });

  it("returns false when any field is an empty string", () => {
    assert.equal(
      isIntakeSubmittable({
        emergency_contact_name: "Maria Ardila",
        emergency_contact_relationship: "",
        emergency_contact_phone: "+1-708-555-0142",
      }),
      false,
    );
  });

  it("returns false when any field is whitespace-only", () => {
    assert.equal(
      isIntakeSubmittable({
        emergency_contact_name: "Maria Ardila",
        emergency_contact_relationship: "Spouse",
        emergency_contact_phone: "   ",
      }),
      false,
    );
  });

  it("returns false when given an empty object (defensive)", () => {
    assert.equal(isIntakeSubmittable({}), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// csvCell
// ─────────────────────────────────────────────────────────────────────────────

describe("csvCell", () => {
  it("returns empty string for null and undefined", () => {
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
  });

  it("returns raw string when no special chars present", () => {
    assert.equal(csvCell("Jose Ardila"), "Jose Ardila");
  });

  it("quotes when value contains a comma (RFC 4180)", () => {
    assert.equal(csvCell("Ardila, Jose"), `"Ardila, Jose"`);
  });

  it("quotes when value contains a double quote, and escapes the quote by doubling", () => {
    assert.equal(csvCell('He said "hi"'), `"He said ""hi"""`);
  });

  it("quotes when value contains a newline", () => {
    assert.equal(csvCell("line1\nline2"), `"line1\nline2"`);
  });

  it("stringifies numbers and booleans without quoting", () => {
    assert.equal(csvCell(42), "42");
    assert.equal(csvCell(true), "true");
    assert.equal(csvCell(false), "false");
  });
});
