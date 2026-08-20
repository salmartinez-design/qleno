/**
 * Portal authentication — capability model and credential handling.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The portal serves two different customers (residential and commercial) from
 * ONE login system. The whole design rests on that divergence living in exactly
 * one function, `portalCapabilities`. If a route ever re-derives "is this
 * commercial?" inline, the two answers drift and someone sees something they
 * shouldn't — silently, because authorization bugs don't throw.
 *
 * The impersonation rule is pinned hardest. Office staff can view as a customer
 * to walk them through a screen, and that session must not be able to spend the
 * customer's money or commit them to work. That's enforced in one place so
 * every capability inherits it; these tests are what keep it there.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-portal-auth";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://stub@stub/stub";

type M = typeof import("../lib/portal-auth.js");
let lib: M;
before(async () => { lib = await import("../lib/portal-auth.js"); });

const residential = (over: Partial<M extends never ? never : any> = {}) => ({
  portalUserId: 1, companyId: 3, email: "jane@example.com",
  clientId: 55, accountContactId: null, impersonatedBy: null, ...over,
});
const commercial = (over: any = {}) => ({
  portalUserId: 2, companyId: 3, email: "ap@ppm.com",
  clientId: null, accountContactId: 77, impersonatedBy: null, ...over,
});

describe("portal capabilities — residential vs commercial", () => {
  it("classifies by which record the login is attached to", () => {
    assert.equal(lib.portalCapabilities(residential()).kind, "residential");
    assert.equal(lib.portalCapabilities(commercial()).kind, "commercial");
  });

  it("gives commercial the account-wide tools and residential none of them", () => {
    const c = lib.portalCapabilities(commercial());
    assert.equal(c.viewBuildings, true);
    assert.equal(c.bulkDownloadInvoices, true, "commercial must get the bulk zip — it's the whole point for PPM");
    assert.equal(c.requestService, true);

    const r = lib.portalCapabilities(residential());
    assert.equal(r.viewBuildings, false);
    assert.equal(r.bulkDownloadInvoices, false);
    // [portal-service-account 2026-08-20] requestService used to be false for
    // residential with the note "later". Later arrived: a residential customer
    // asking for an extra clean goes into the same office queue a commercial
    // one does. A request is an ASK, not work on the board, so there is nothing
    // here that a residential customer may not do.
    assert.equal(r.requestService, true);
  });

  it("gives residential the schedule, the agreement and referrals", () => {
    const r = lib.portalCapabilities(residential());
    assert.equal(r.viewSchedule, true);
    assert.equal(r.viewAgreement, true);
    assert.equal(r.submitReferral, true);

    // A property-management contact has no household to refer.
    assert.equal(lib.portalCapabilities(commercial()).submitReferral, false);
  });

  // [portal-holds-office-only 2026-08-20] Nobody pauses their own service from
  // the portal. Sal: "No pausing for clients at the moment let the office
  // handle that for now." Commercial was already off — a commercial pause is a
  // contract matter for the account manager. Residential is off by the
  // PORTAL_SELF_SERVE_HOLDS switch, which is the one place to flip it back.
  //
  // This is pinned because the surface disappears quietly: the capability is
  // what hides the pause form and the Restart button AND what makes all three
  // hold routes refuse. A stray `true` here puts a customer-facing pause
  // control back on the screen with nothing else in the diff to notice.
  it("lets nobody pause their own service", () => {
    assert.equal(lib.portalCapabilities(residential()).manageHold, false);
    assert.equal(lib.portalCapabilities(commercial()).manageHold, false);
  });

  it("gives rate-a-clean to residential only", () => {
    assert.equal(lib.portalCapabilities(residential()).rateClean, true);
    assert.equal(lib.portalCapabilities(commercial()).rateClean, false);
  });

  it("lets both see visits and invoices", () => {
    for (const s of [residential(), commercial()]) {
      const c = lib.portalCapabilities(s);
      assert.equal(c.viewVisits, true);
      assert.equal(c.viewInvoices, true);
      assert.equal(c.downloadInvoicePdf, true);
    }
  });
});

describe("portal capabilities — impersonation is read-only", () => {
  it("strips every money-moving and committing action, for both customer types", () => {
    for (const build of [residential, commercial]) {
      const viewed = lib.portalCapabilities(build({ impersonatedBy: 9 }));
      assert.equal(viewed.payInvoice, false, "a support session must never spend a customer's money");
      assert.equal(viewed.requestService, false, "a support session must not commit the customer to work");
      assert.equal(viewed.manageContacts, false);
      assert.equal(viewed.rateClean, false, "a support session must not post a review as the customer");
    }
  });

  it("still allows looking — the point is walking them through a screen", () => {
    const viewed = lib.portalCapabilities(commercial({ impersonatedBy: 9 }));
    assert.equal(viewed.viewVisits, true);
    assert.equal(viewed.viewInvoices, true);
    assert.equal(viewed.viewBuildings, true);
    assert.equal(viewed.downloadInvoicePdf, true);
  });

  it("does not treat a normal session as impersonated", () => {
    assert.equal(lib.portalCapabilities(commercial()).payInvoice, true);
    assert.equal(lib.portalCapabilities(residential()).rateClean, true);
  });
});

describe("passwords", () => {
  it("requires at least 10 characters and rejects non-strings", () => {
    assert.ok(lib.passwordProblem("short"));
    assert.ok(lib.passwordProblem(undefined));
    assert.ok(lib.passwordProblem(12345678901 as unknown as string));
    assert.ok(lib.passwordProblem("x".repeat(201)));
    assert.equal(lib.passwordProblem("correct horse battery"), null);
  });

  it("round-trips a hash and rejects the wrong password", async () => {
    const hash = await lib.hashPassword("correct horse battery");
    assert.equal(await lib.verifyPassword("correct horse battery", hash), true);
    assert.equal(await lib.verifyPassword("Correct horse battery", hash), false);
  });

  it("returns false — not a crash — when the user has no password", async () => {
    // Social-only accounts have password_hash NULL, and so does a lookup that
    // found no user at all. Both must behave like a wrong password, because the
    // login route feeds the miss straight into this.
    assert.equal(await lib.verifyPassword("anything at all", null), false);
  });
});

describe("single-use secrets", () => {
  it("hashes tokens before they are stored", () => {
    const raw = "a-raw-token-value";
    const hashed = lib.hashToken(raw);
    assert.notEqual(hashed, raw, "the raw token must never be what lands in the database");
    assert.match(hashed, /^[a-f0-9]{64}$/, "expected sha-256 hex");
    assert.equal(lib.hashToken(raw), hashed, "hashing must be deterministic or lookup breaks");
  });

  it("rejects a non-string token without touching the database", async () => {
    assert.equal(await lib.redeemPortalToken("", "reset"), null);
    assert.equal(await lib.redeemPortalToken(undefined as unknown as string, "reset"), null);
  });
});

describe("email normalisation", () => {
  it("lowercases and trims so one person cannot become two logins", () => {
    assert.equal(lib.normalizeEmail("  Bob@Example.COM "), "bob@example.com");
    assert.equal(lib.normalizeEmail(null), "");
  });
});

describe("session guard", () => {
  it("refuses a STAFF token on portal routes", async () => {
    // Isolation runs both directions: staff tokens are rejected here, portal
    // tokens are rejected by requireAuth (portal-token-isolation.test.ts).
    const { signToken } = await import("../lib/auth.js");
    const staff = signToken({ userId: 7, companyId: 3, role: "office", email: "maribel@phes.io" });

    const req: any = { headers: { authorization: `Bearer ${staff}` } };
    let status: number | undefined;
    const res: any = { status(c: number) { status = c; return { json: () => res }; } };
    let admitted = false;
    await lib.requirePortalAuth(req, res, () => { admitted = true; });

    assert.equal(admitted, false, "a staff token opened a customer session");
    assert.equal(status, 403);
  });

  it("refuses a malformed or missing bearer token", async () => {
    for (const headers of [{}, { authorization: "Bearer not-a-jwt" }, { authorization: "Basic xyz" }]) {
      const req: any = { headers };
      let status: number | undefined;
      const res: any = { status(c: number) { status = c; return { json: () => res }; } };
      let admitted = false;
      await lib.requirePortalAuth(req, res, () => { admitted = true; });
      assert.equal(admitted, false);
      assert.equal(status, 401);
    }
  });
});
