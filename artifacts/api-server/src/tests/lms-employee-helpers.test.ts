/**
 * Unit tests for the LMS Add/Edit Employee input validators.
 *
 * Tenant isolation itself is enforced at the SQL layer in
 * `routes/users.ts` (every INSERT / UPDATE / SELECT against
 * `usersTable` carries `eq(usersTable.company_id, req.auth.companyId)`).
 * These tests cover the input-validation half of that contract so a
 * future refactor doesn't loosen the allowed-role set or the email
 * regex by accident.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateLmsTempPassword,
  generateRandomLmsTempPassword,
  isValidEmail,
  isValidIsoDate,
  LMS_ADD_ALLOWED_ROLES,
  LMS_DEFAULT_TEMP_PASSWORD,
  LMS_EDIT_ALLOWED_ROLES,
} from "../lib/lms-employee-helpers.js";

describe("generateLmsTempPassword (onboarding-readiness sprint 2026-05-15)", () => {
  it("returns the literal Sal-mandated default 'chicago23'", () => {
    assert.equal(generateLmsTempPassword(), LMS_DEFAULT_TEMP_PASSWORD);
    assert.equal(LMS_DEFAULT_TEMP_PASSWORD, "chicago23");
  });

  it("is stable across calls (literal, not random)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 50; i++) set.add(generateLmsTempPassword());
    assert.equal(set.size, 1, "literal default should never vary");
  });
});

describe("generateRandomLmsTempPassword (retained for future callers)", () => {
  it("returns a string with the Phes prefix and 6-char suffix (10 total)", () => {
    const pw = generateRandomLmsTempPassword();
    assert.equal(pw.length, 10);
    assert.equal(pw.slice(0, 4), "Phes");
  });

  it("uses only the ambiguous-char-free alphabet (no 0, 1, I, l, O, o)", () => {
    const banned = new Set(["0", "1", "I", "l", "O", "o"]);
    for (let i = 0; i < 200; i++) {
      const pw = generateRandomLmsTempPassword();
      const suffix = pw.slice(4);
      for (const ch of suffix) {
        assert.ok(
          !banned.has(ch),
          `random temp pw produced banned char '${ch}' in suffix '${suffix}'`,
        );
      }
    }
  });

  it("returns a different value across calls (best-effort entropy check)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateRandomLmsTempPassword());
    assert.ok(seen.size >= 95, `expected near-100 unique pws, got ${seen.size}`);
  });
});

describe("isValidEmail", () => {
  it("accepts standard work-domain addresses", () => {
    assert.ok(isValidEmail("sal@phes.io"));
    assert.ok(isValidEmail("New.Hire+lms@phes.io"));
    assert.ok(isValidEmail("a@b.co"));
  });

  it("rejects missing parts", () => {
    assert.equal(isValidEmail(""), false);
    assert.equal(isValidEmail("nobody"), false);
    assert.equal(isValidEmail("a@b"), false);
    assert.equal(isValidEmail("@phes.io"), false);
    assert.equal(isValidEmail("salphes.io"), false);
  });

  it("rejects non-strings", () => {
    assert.equal(isValidEmail(null), false);
    assert.equal(isValidEmail(undefined), false);
    assert.equal(isValidEmail(42 as unknown), false);
    assert.equal(isValidEmail({} as unknown), false);
  });

  it("rejects pathological lengths", () => {
    assert.equal(isValidEmail("a@"), false);
    const long = "a".repeat(260) + "@phes.io";
    assert.equal(isValidEmail(long), false);
  });
});

describe("isValidIsoDate", () => {
  it("accepts a YYYY-MM-DD string", () => {
    assert.ok(isValidIsoDate("2026-05-15"));
    assert.ok(isValidIsoDate("2000-01-01"));
  });

  it("rejects non-ISO shapes", () => {
    assert.equal(isValidIsoDate("5/15/2026"), false);
    assert.equal(isValidIsoDate("2026-5-15"), false);
    assert.equal(isValidIsoDate("2026-05-15T00:00:00Z"), false);
    assert.equal(isValidIsoDate(""), false);
    assert.equal(isValidIsoDate(null), false);
    assert.equal(isValidIsoDate(20260515 as unknown), false);
  });
});

describe("LMS_ADD_ALLOWED_ROLES", () => {
  it("contains exactly technician, team_lead, admin (NO office, NO owner)", () => {
    const expected = new Set(["technician", "team_lead", "admin"]);
    assert.equal(LMS_ADD_ALLOWED_ROLES.size, expected.size);
    for (const r of expected) {
      assert.ok(
        LMS_ADD_ALLOWED_ROLES.has(r),
        `add-allowed role set is missing '${r}'`,
      );
    }
  });

  it("does NOT permit creating owner or office accounts via /lms-add", () => {
    assert.equal(LMS_ADD_ALLOWED_ROLES.has("owner"), false);
    assert.equal(LMS_ADD_ALLOWED_ROLES.has("office"), false);
    assert.equal(LMS_ADD_ALLOWED_ROLES.has("super_admin"), false);
  });
});

describe("LMS_EDIT_ALLOWED_ROLES", () => {
  it("contains technician, team_lead, admin, and office (still NO owner)", () => {
    const expected = new Set(["technician", "team_lead", "admin", "office"]);
    assert.equal(LMS_EDIT_ALLOWED_ROLES.size, expected.size);
    for (const r of expected) {
      assert.ok(
        LMS_EDIT_ALLOWED_ROLES.has(r),
        `edit-allowed role set is missing '${r}'`,
      );
    }
  });

  it("never permits role=owner via /lms-edit (owner is a tenant invariant)", () => {
    assert.equal(LMS_EDIT_ALLOWED_ROLES.has("owner"), false);
    assert.equal(LMS_EDIT_ALLOWED_ROLES.has("super_admin"), false);
  });
});
