/**
 * Google sign-in — the gate and the token checks.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * This is an authentication path, and the two ways it goes wrong are silent.
 *
 * 1. Audience. `verifyIdToken` is only safe because it checks that the token's
 *    audience is OUR client id. Drop that and a token minted for any other
 *    Google app is accepted here — anyone with a Google login anywhere could
 *    sign in as a customer. Nothing would error; it would just work.
 *
 * 2. The gate. The feature must be completely inert until
 *    GOOGLE_PORTAL_CLIENT_ID is set, so a tenant that hasn't configured it
 *    never renders a button and never accepts a credential.
 *
 * The link/no-link rules (invite-only, verified-email-only) live in the route
 * and need a database; they're asserted by review, not here — see the PR.
 */
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

let lib: typeof import("../lib/portal-google.js");
before(async () => { lib = await import("../lib/portal-google.js"); });

const ORIGINAL = process.env.GOOGLE_PORTAL_CLIENT_ID;
beforeEach(() => { delete process.env.GOOGLE_PORTAL_CLIENT_ID; });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GOOGLE_PORTAL_CLIENT_ID;
  else process.env.GOOGLE_PORTAL_CLIENT_ID = ORIGINAL;
});

describe("google sign-in — the configuration gate", () => {
  it("is disabled when no client id is set", () => {
    assert.equal(lib.googlePortalEnabled(), false);
    assert.equal(lib.googlePortalClientId(), null);
  });

  it("enables only once a client id is present", () => {
    process.env.GOOGLE_PORTAL_CLIENT_ID = "123.apps.googleusercontent.com";
    assert.equal(lib.googlePortalEnabled(), true);
    assert.equal(lib.googlePortalClientId(), "123.apps.googleusercontent.com");
  });

  it("refuses to verify anything while disabled", async () => {
    // Load-bearing: an unconfigured tenant must not accept a credential at all,
    // rather than falling through to a verification that might somehow pass.
    assert.equal(await lib.verifyGoogleIdToken("any.token.value.that.is.long.enough"), null);
  });
});

describe("google sign-in — token rejection", () => {
  beforeEach(() => { process.env.GOOGLE_PORTAL_CLIENT_ID = "123.apps.googleusercontent.com"; });

  it("rejects non-string credentials", async () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      assert.equal(await lib.verifyGoogleIdToken(bad as unknown as string), null, `accepted ${JSON.stringify(bad)}`);
    }
  });

  it("rejects implausible lengths without calling out to Google", async () => {
    assert.equal(await lib.verifyGoogleIdToken(""), null);
    assert.equal(await lib.verifyGoogleIdToken("short"), null);
    // An 8KB+ "token" is not a JWT; refuse before spending a network round trip.
    assert.equal(await lib.verifyGoogleIdToken("x".repeat(9000)), null);
  });

  it("rejects a well-formed but unsigned JWT", async () => {
    // header.payload.signature shaped, self-asserting a Google subject — the
    // signature check is what stops this, and it must not be skippable.
    const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const forged = [
      b64({ alg: "none", typ: "JWT" }),
      b64({ sub: "attacker", email: "ap@ppm.com", email_verified: true, aud: "123.apps.googleusercontent.com" }),
      "not-a-real-signature",
    ].join(".");
    assert.equal(await lib.verifyGoogleIdToken(forged), null, "an unsigned token was accepted");
  });

  it("returns null rather than throwing, so a bad token is a failed sign-in", async () => {
    // The route maps null to the same generic message as a wrong password. If
    // this threw, the customer would get a 500 and the log would fill with
    // stack traces for what is simply someone mistyping.
    await assert.doesNotReject(() => lib.verifyGoogleIdToken("garbage.garbage.garbage"));
  });
});
