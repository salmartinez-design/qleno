// [office-branch-toggle 2026-08-19] Sal: "ensure that Francisco and Maribel can
// keep their logins and the branch toggle is their only access needed between
// locations."
//
// Before this, `user_companies` held four rows — Sal on both tenants, Ivan on
// Schaumburg, and one technician. The two office users had none at all, which
// made Schaumburg unreachable for them: the header switcher is populated purely
// from that table and `POST /auth/switch-company` 403s without a matching row.
// So every Schaumburg card, quote and invoice had to go through the owner.
//
// The grant is data, not a new permission model — their credentials, home
// tenant and role are all untouched.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const migration = read("../phes-data-migration.ts");
const auth = read("../routes/auth.ts");

// The grant statement, isolated so a later edit elsewhere can't accidentally
// satisfy these assertions.
const GRANT = (() => {
  const i = migration.indexOf("grant Oak Lawn office staff the Schaumburg branch toggle");
  assert.ok(i > 0, "the office branch-toggle grant is missing from the migration");
  return migration.slice(i, migration.indexOf("` },", i));
})();

describe("the branch toggle is the only thing office staff need", () => {
  it("grants both tenants, not just Schaumburg", () => {
    // users.company_id decides which tenant they LAND in, but it is not itself
    // a membership — auth.ts reads user_companies and nothing else. Granting
    // only company 4 would let them reach Schaumburg and never get back.
    assert.match(GRANT, /c\.id IN \(1, 4\)/);
  });

  it("is scoped to office staff whose home tenant is Oak Lawn", () => {
    assert.match(GRANT, /u\.company_id = 1/);
    assert.match(GRANT, /u\.role IN \('owner', 'admin', 'office'\)/);
  });

  it("never grants a Schaumburg user Oak Lawn", () => {
    // The branches are separately owned (Sal vs Sal+Ivan). A co4 owner must not
    // inherit Oak Lawn's books, so the grant reads FROM company 1 only —
    // anything that selected on c.id alone would sweep Ivan in.
    assert.ok(
      !/u\.company_id IN/.test(GRANT) && !/u\.company_id = 4/.test(GRANT),
      "the grant must originate from company 1 only",
    );
  });

  it("leaves technicians out — cross-branch work is an assignment, not a login", () => {
    assert.ok(!/technician/.test(GRANT));
  });

  it("re-running it on the next boot is a no-op", () => {
    // Every boot replays this file; without the conflict clause the second one
    // would throw on the (user_id, company_id) unique and, per [schema-guard],
    // be swallowed as non-fatal — hiding a real failure.
    assert.match(GRANT, /ON CONFLICT \(user_id, company_id\) DO NOTHING/);
  });

  it("does not touch credentials, home tenant or role", () => {
    // The whole point of "keep their logins". A password reset or a role
    // rewrite hiding in here would be the regression.
    for (const bad of [/UPDATE\s+users/i, /password/i, /DELETE/i]) {
      assert.ok(!bad.test(GRANT), `the grant must not ${bad}`);
    }
    // The role carried into company 4 is their existing one, copied across.
    assert.match(GRANT, /SELECT u\.id, c\.id, u\.role/);
  });
});

describe("what the toggle actually reads", () => {
  it("login lists exactly the user_companies rows", () => {
    // If this ever changes to union in users.company_id, the two-row grant
    // above becomes over-broad rather than wrong — worth knowing.
    assert.match(auth, /\.from\(userCompaniesTable\)[\s\S]{0,200}eq\(userCompaniesTable\.user_id, user\[0\]\.id\)/);
  });

  it("switch-company refuses a tenant with no membership row", () => {
    const sw = auth.slice(auth.indexOf('router.post("/switch-company"'));
    assert.match(sw, /if \(!membership\[0\]\)/);
    assert.match(sw, /403/);
  });

  it("the reissued token keeps the user's own role", () => {
    // Office in Oak Lawn must be office in Schaumburg — not demoted, and not
    // silently promoted by picking up some other tenant's role.
    const sw = auth.slice(auth.indexOf('router.post("/switch-company"'));
    assert.match(sw, /role: user\[0\]\.role/);
    assert.match(sw, /companyId: company_id/);
  });
});
