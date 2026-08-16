import test from "node:test";
import assert from "node:assert/strict";
import { isSuperAdminRow, resolveTargetCompany, type CompanyRef } from "../lib/tenant-scope.js";

// [ai-access-superadmin 2026-08-16] The cross-tenant resolver.
//
// What is on trial here is not whether a super-admin can reach another company —
// that is the easy half. It is that a `company` argument, which arrives from a
// model and can therefore be shaped by anything the model has read, can never
// widen reach beyond the list computed from the credential, and can never be
// GUESSED at when it is ambiguous. A wrong guess here answers a question about
// one business with another business's numbers, and nothing downstream looks
// wrong: the figures are real, they are simply not the ones that were asked for.

const PHES: CompanyRef = { id: 1, name: "Phes Cleaning Services" };
const SCHAUMBURG: CompanyRef = { id: 4, name: "Phes Cleaning Services - Schaumburg" };
const OTHER: CompanyRef = { id: 9, name: "Evinco" };

const ONE = [PHES];
const MANY = [PHES, SCHAUMBURG, OTHER];

const ok = (r: ReturnType<typeof resolveTargetCompany>) => {
  assert.ok(!("error" in r), `expected a company, got: ${(r as any).error}`);
  return r as { companyId: number; company: CompanyRef };
};
const refused = (r: ReturnType<typeof resolveTargetCompany>) => {
  assert.ok("error" in r, `expected a refusal, got company ${(r as any).companyId}`);
  return (r as { error: string }).error;
};

// ── The single-tenant case, which is almost every request ────────────────────

test("no company argument means the home company", () => {
  assert.equal(ok(resolveTargetCompany(undefined, ONE, 1)).companyId, 1);
  assert.equal(ok(resolveTargetCompany(null, ONE, 1)).companyId, 1);
  assert.equal(ok(resolveTargetCompany("", ONE, 1)).companyId, 1);
  // Home stays home even when the connection could go elsewhere.
  assert.equal(ok(resolveTargetCompany(undefined, MANY, 4)).companyId, 4);
});

test("a single-tenant connection refuses a company argument rather than ignoring it", () => {
  // Ignoring it would answer with the home company's real numbers under another
  // company's name. The refusal is the only outcome an operator can notice.
  for (const arg of ["4", 4, "Schaumburg", "Evinco"]) {
    const msg = refused(resolveTargetCompany(arg, ONE, 1));
    assert.match(msg, /only/i);
  }
});

// ── The argument is a hint, never an authority ───────────────────────────────

test("a company outside the allowed list is refused however it is named", () => {
  // 4 and "Evinco" are real companies — they are simply not on this credential's
  // list, because the grant is single-tenant or because that tenant has AI
  // access switched off. Both cases must answer identically: a different message
  // would turn this endpoint into a directory of every business on Qleno.
  const byId = refused(resolveTargetCompany("4", [PHES, OTHER], 1));
  const byName = refused(resolveTargetCompany("Schaumburg", [PHES, OTHER], 1));
  assert.match(byId, /list_companies/);
  assert.match(byName, /list_companies/);
});

test("an id is matched exactly, not parsed loosely", () => {
  assert.equal(ok(resolveTargetCompany("4", MANY, 1)).companyId, 4);
  assert.equal(ok(resolveTargetCompany(4, MANY, 1)).companyId, 4);
  // "4x" is not company 4. Number("4x") is NaN, but a lenient parseInt would
  // have said 4 — the kind of coercion that turns a typo into another tenant.
  refused(resolveTargetCompany("4x", MANY, 1));
  refused(resolveTargetCompany("999", MANY, 1));
});

// ── Names, where the real risk lives ─────────────────────────────────────────

test("an exact name wins over a company whose name contains it", () => {
  // "Phes Cleaning Services" is a substring of the Schaumburg name. Without the
  // exact-match-first rule, asking for the Oak Lawn company by its full name is
  // ambiguous and either fails or silently lands on Schaumburg.
  assert.equal(ok(resolveTargetCompany("Phes Cleaning Services", MANY, 4)).companyId, 1);
  assert.equal(ok(resolveTargetCompany("phes cleaning services", MANY, 4)).companyId, 1);
});

test("an ambiguous name is refused rather than guessed", () => {
  // "Phes" matches two. Picking the first would be a coin flip between two real
  // businesses, decided by SQL row order.
  const msg = refused(resolveTargetCompany("Phes", MANY, 1));
  assert.match(msg, /more than one/i);
  assert.match(msg, /Schaumburg/);
});

test("a partial name that is unambiguous resolves", () => {
  assert.equal(ok(resolveTargetCompany("Schaumburg", MANY, 1)).companyId, 4);
  assert.equal(ok(resolveTargetCompany("evinco", MANY, 1)).companyId, 9);
});

test("an empty allowed list never resolves to anything", () => {
  // Reachable when every company on the connection has AI access switched off
  // between approval and this call. Returning the home id from a list that does
  // not contain it would read a tenant that had just turned this off.
  refused(resolveTargetCompany(undefined, [], 1));
  refused(resolveTargetCompany("1", [], 1));
});

// ── The live flag ────────────────────────────────────────────────────────────

test("both representations of super-admin are honored, and nothing else is", () => {
  // Production carries both: the dedicated column and the legacy role. Reading
  // only one of them would mean a person who can reach the admin console cannot
  // reach it through an assistant — or worse, the reverse.
  assert.equal(isSuperAdminRow({ is_super_admin: true, role: "owner" }), true);
  assert.equal(isSuperAdminRow({ is_super_admin: "t", role: "owner" }), true);
  assert.equal(isSuperAdminRow({ role: "super_admin" }), true);

  assert.equal(isSuperAdminRow({ role: "owner" }), false);
  assert.equal(isSuperAdminRow({ role: "admin", is_super_admin: false }), false);
  assert.equal(isSuperAdminRow({ role: "office" }), false);
  assert.equal(isSuperAdminRow({}), false);
  // Strings that are merely truthy must not pass: "f" is how a false boolean
  // comes back from some drivers, and `if (row.is_super_admin)` would have
  // handed platform-wide reach to every user in the table.
  assert.equal(isSuperAdminRow({ is_super_admin: "f" }), false);
  assert.equal(isSuperAdminRow({ is_super_admin: "false" }), false);
  assert.equal(isSuperAdminRow({ is_super_admin: 0 }), false);
});
