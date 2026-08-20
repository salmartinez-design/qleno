// [agreement-body-version 2026-08-20] The agreement wording lives in code but
// is served from the database. The boot migration only copies a new body over
// when AGREEMENT_BODY_SEED_VERSION is higher than the number stamped on the
// row. Edit the wording and forget the bump and nothing happens: the code says
// one thing, every customer reads another, and everything looks fine.
//
// That is exactly what happened with the Section 9 hold fix, so this test
// pins each body to a fingerprint. Change a single character of either
// agreement and this fails until you bump the version and update the
// fingerprint below in the same commit.
import { describe, it } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import {
  AGREEMENT_BODY_SEED_VERSION,
  RESIDENTIAL_AGREEMENT_BODY,
  COMMERCIAL_AGREEMENT_BODY,
} from "../lib/agreement-bodies.js";

const fp = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// Bump AGREEMENT_BODY_SEED_VERSION and refresh these two lines together.
const EXPECTED = {
  version: 3,
  residential: "308a7182bc7dc581",
  commercial: "584fe0448d428792",
};

describe("agreement wording actually reaches customers", () => {
  it("the seed version matches the wording in this commit", () => {
    assert.strictEqual(
      AGREEMENT_BODY_SEED_VERSION,
      EXPECTED.version,
      "AGREEMENT_BODY_SEED_VERSION changed. Update EXPECTED.version here too.",
    );
  });

  it("neither body changed without a version bump", () => {
    assert.strictEqual(
      fp(RESIDENTIAL_AGREEMENT_BODY),
      EXPECTED.residential,
      "The residential agreement wording changed. Bump AGREEMENT_BODY_SEED_VERSION or the change never reaches the database.",
    );
    assert.strictEqual(
      fp(COMMERCIAL_AGREEMENT_BODY),
      EXPECTED.commercial,
      "The commercial agreement wording changed. Bump AGREEMENT_BODY_SEED_VERSION or the change never reaches the database.",
    );
  });

  it("the hold section owes the notice period, not one visit", () => {
    assert.match(RESIDENTIAL_AGREEMENT_BODY, /would have fallen inside your \{\{termination_notice_days\}\} day notice period/);
    assert.doesNotMatch(RESIDENTIAL_AGREEMENT_BODY, /one final visit/);
  });

  it("no em or en dashes in either agreement", () => {
    assert.ok(!RESIDENTIAL_AGREEMENT_BODY.includes("—") && !RESIDENTIAL_AGREEMENT_BODY.includes("–"));
    assert.ok(!COMMERCIAL_AGREEMENT_BODY.includes("—") && !COMMERCIAL_AGREEMENT_BODY.includes("–"));
  });
});
