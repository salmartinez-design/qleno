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
  version: 5,
  residential: "60047ecd077ccdd6",
  commercial: "71f9f1d6620bd90c",
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
    assert.match(RESIDENTIAL_AGREEMENT_BODY, /the visits that would have taken place during the last \{\{termination_notice_days\}\} days of that hold/);
    assert.doesNotMatch(RESIDENTIAL_AGREEMENT_BODY, /one final visit/);
  });

  // A customer on weekly service owes about four final visits and a monthly
  // customer owes one. The old wording left them to work that out; a bill that
  // is four times what someone expected is the complaint this sentence exists
  // to prevent, so it has to survive future edits to Section 9.
  it("the hold section says the final bill depends on how often we clean", () => {
    assert.match(RESIDENTIAL_AGREEMENT_BODY, /depends both on how often we clean for you and on where those dates fall in the calendar/);
  });

  // Charged the day the hold ends, on the card already on file. Section 12 has
  // to authorize that or the charge has no basis.
  it("the card authorization covers the hold and notice charge", () => {
    assert.match(RESIDENTIAL_AGREEMENT_BODY, /any visit billed during a hold or notice period under Section 9 or Section 10/);
  });

  it("no em or en dashes in either agreement", () => {
    assert.ok(!RESIDENTIAL_AGREEMENT_BODY.includes("—") && !RESIDENTIAL_AGREEMENT_BODY.includes("–"));
    assert.ok(!COMMERCIAL_AGREEMENT_BODY.includes("—") && !COMMERCIAL_AGREEMENT_BODY.includes("–"));
  });
});
