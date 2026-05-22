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
  alphanumIdOrNull,
  boolOr,
  csvCell,
  dateOrNull,
  futureDateOrNull,
  isIntakeSubmittable,
  licensePlateOrNull,
  stateOrNull,
  trimOrNull,
  vehicleYearOrNull,
  zipOrNull,
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

// ─────────────────────────────────────────────────────────────────────────────
// zipOrNull (vehicle-and-address PR)
// ─────────────────────────────────────────────────────────────────────────────

describe("zipOrNull", () => {
  it("accepts 5-digit ZIP", () => {
    assert.equal(zipOrNull("60805"), "60805");
  });
  it("accepts 5+4 ZIP with hyphen", () => {
    assert.equal(zipOrNull("60805-1234"), "60805-1234");
  });
  it("rejects 4-digit ZIP", () => {
    assert.equal(zipOrNull("6080"), null);
  });
  it("rejects ZIP with letters", () => {
    assert.equal(zipOrNull("60AB5"), null);
  });
  it("returns null for empty / whitespace / non-string", () => {
    assert.equal(zipOrNull(""), null);
    assert.equal(zipOrNull("   "), null);
    assert.equal(zipOrNull(60805), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stateOrNull
// ─────────────────────────────────────────────────────────────────────────────

describe("stateOrNull", () => {
  it("accepts uppercase 2-letter state code", () => {
    assert.equal(stateOrNull("IL"), "IL");
  });
  it("uppercases lowercase input", () => {
    assert.equal(stateOrNull("il"), "IL");
  });
  it("trims whitespace", () => {
    assert.equal(stateOrNull("  CA  "), "CA");
  });
  it("rejects non-state codes", () => {
    assert.equal(stateOrNull("XX"), null);
    assert.equal(stateOrNull("Illinois"), null);
  });
  it("accepts DC + territories used on DLs", () => {
    assert.equal(stateOrNull("DC"), "DC");
    assert.equal(stateOrNull("PR"), "PR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// vehicleYearOrNull
// ─────────────────────────────────────────────────────────────────────────────

describe("vehicleYearOrNull", () => {
  it("accepts integer in range", () => {
    assert.equal(vehicleYearOrNull(2020, 2026), 2020);
  });
  it("accepts 4-digit string in range", () => {
    assert.equal(vehicleYearOrNull("2020", 2026), 2020);
  });
  it("rejects pre-1980", () => {
    assert.equal(vehicleYearOrNull(1979, 2026), null);
    assert.equal(vehicleYearOrNull("1979", 2026), null);
  });
  it("accepts 1980 exactly", () => {
    assert.equal(vehicleYearOrNull(1980, 2026), 1980);
  });
  it("rejects more than 2 years in the future", () => {
    assert.equal(vehicleYearOrNull(2029, 2026), null);
  });
  it("accepts current year + 1 and + 2", () => {
    assert.equal(vehicleYearOrNull(2027, 2026), 2027);
    assert.equal(vehicleYearOrNull(2028, 2026), 2028);
  });
  it("rejects non-integer + 3-digit + 5-digit strings", () => {
    assert.equal(vehicleYearOrNull("20.5", 2026), null);
    assert.equal(vehicleYearOrNull("999", 2026), null);
    assert.equal(vehicleYearOrNull("20200", 2026), null);
    assert.equal(vehicleYearOrNull(20.5, 2026), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// licensePlateOrNull
// ─────────────────────────────────────────────────────────────────────────────

describe("licensePlateOrNull", () => {
  it("accepts 2-character plate", () => {
    assert.equal(licensePlateOrNull("AB"), "AB");
  });
  it("accepts 8-character plate", () => {
    assert.equal(licensePlateOrNull("ABC12345"), "ABC12345");
  });
  it("uppercases lowercase input", () => {
    assert.equal(licensePlateOrNull("abc1234"), "ABC1234");
  });
  it("strips internal whitespace and hyphens", () => {
    assert.equal(licensePlateOrNull("ABC-1234"), "ABC1234");
    assert.equal(licensePlateOrNull("ABC 1234"), "ABC1234");
  });
  it("rejects 1-character or 9+ character plate", () => {
    assert.equal(licensePlateOrNull("A"), null);
    assert.equal(licensePlateOrNull("ABC123456"), null);
  });
  it("rejects special characters that aren't whitespace/hyphen", () => {
    assert.equal(licensePlateOrNull("ABC@123"), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// alphanumIdOrNull (insurance policy + DL number)
// ─────────────────────────────────────────────────────────────────────────────

describe("alphanumIdOrNull", () => {
  it("accepts 5-character id", () => {
    assert.equal(alphanumIdOrNull("ABC12"), "ABC12");
  });
  it("accepts 30-character id", () => {
    assert.equal(alphanumIdOrNull("A".repeat(30)), "A".repeat(30));
  });
  it("preserves embedded hyphens/spaces in returned value (length checked on stripped form)", () => {
    assert.equal(alphanumIdOrNull("ABC-1234-5678"), "ABC-1234-5678");
  });
  it("rejects 4-character id", () => {
    assert.equal(alphanumIdOrNull("ABC1"), null);
  });
  it("rejects 31-character id", () => {
    assert.equal(alphanumIdOrNull("A".repeat(31)), null);
  });
  it("rejects special characters other than whitespace/hyphen", () => {
    assert.equal(alphanumIdOrNull("ABC@123"), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// futureDateOrNull
// ─────────────────────────────────────────────────────────────────────────────

describe("futureDateOrNull", () => {
  const now = new Date("2026-05-22T12:00:00Z");

  it("accepts a date in the future", () => {
    assert.equal(futureDateOrNull("2027-01-01", now), "2027-01-01");
  });
  it("rejects today (must be strictly future)", () => {
    assert.equal(futureDateOrNull("2026-05-22", now), null);
  });
  it("rejects a date in the past", () => {
    assert.equal(futureDateOrNull("2025-01-01", now), null);
  });
  it("rejects malformed dates", () => {
    assert.equal(futureDateOrNull("2027-13-40", now), null);
    assert.equal(futureDateOrNull("not-a-date", now), null);
  });
  it("returns null for empty / non-string", () => {
    assert.equal(futureDateOrNull("", now), null);
    assert.equal(futureDateOrNull(undefined, now), null);
  });
});
