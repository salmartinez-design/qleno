/**
 * View-as-customer — the read-only guarantee.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Office staff can open a customer's portal to walk them through a screen. That
 * session must be able to LOOK at everything and CHANGE nothing: it cannot pay
 * an invoice, commit the customer to work, or post a review in their name.
 *
 * The rule lives in exactly one place — `portalCapabilities` strips those
 * actions whenever `impersonatedBy` is set — so that every route inherits it
 * and no new screen can forget. These tests pin that, because the failure is
 * invisible: a support session that can spend a customer's money looks
 * identical to one that can't until someone spends it.
 *
 * `requestService` is included deliberately. It's the newest capability, and
 * it's exactly the kind of thing that gets added to the "commercial" branch
 * without anyone remembering the impersonation case.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-view-as";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://stub@stub/stub";

let lib: typeof import("../lib/portal-auth.js");
before(async () => { lib = await import("../lib/portal-auth.js"); });

const commercial = (over: any = {}) => ({
  portalUserId: 2, companyId: 3, email: "ap@ppm.com",
  clientId: null, accountContactId: 77, impersonatedBy: null, ...over,
});
const residential = (over: any = {}) => ({
  portalUserId: 1, companyId: 3, email: "jane@example.com",
  clientId: 55, accountContactId: null, impersonatedBy: null, ...over,
});

// Everything a support session must NOT be able to do.
const MUTATIONS = ["payInvoice", "requestService", "manageContacts", "rateClean"] as const;
// Everything it still SHOULD be able to do — the point is walking them through.
const READS = ["viewVisits", "viewInvoices", "downloadInvoicePdf"] as const;

describe("view-as — a support session cannot act", () => {
  it("strips every mutation for a commercial customer", () => {
    const caps = lib.portalCapabilities(commercial({ impersonatedBy: 9 }));
    for (const m of MUTATIONS) {
      assert.equal(caps[m], false, `impersonated session retained ${m}`);
    }
  });

  it("strips every mutation for a residential customer", () => {
    const caps = lib.portalCapabilities(residential({ impersonatedBy: 9 }));
    for (const m of MUTATIONS) {
      assert.equal(caps[m], false, `impersonated session retained ${m}`);
    }
  });

  it("still allows reading, or view-as would be pointless", () => {
    const caps = lib.portalCapabilities(commercial({ impersonatedBy: 9 }));
    for (const r of READS) assert.equal(caps[r], true, `impersonated session lost ${r}`);
    assert.equal(caps.viewBuildings, true);
  });

  it("does not confuse impersonation with customer type", () => {
    // A viewed commercial session is still commercial — support must see the
    // same screen the customer sees, not the residential one.
    assert.equal(lib.portalCapabilities(commercial({ impersonatedBy: 9 })).kind, "commercial");
    assert.equal(lib.portalCapabilities(residential({ impersonatedBy: 9 })).kind, "residential");
  });

  it("leaves a real customer session fully able to act", () => {
    const caps = lib.portalCapabilities(commercial());
    assert.equal(caps.payInvoice, true);
    assert.equal(caps.requestService, true);
    assert.equal(caps.manageContacts, true);
  });

  it("treats impersonatedBy = 0 as impersonation, not as absent", () => {
    // Guards against a `!impersonatedBy` style check, where a staff user id of
    // 0 would read as falsy and silently grant a support session full rights.
    assert.equal(lib.portalCapabilities(commercial({ impersonatedBy: 0 })).payInvoice, false);
  });
});

describe("view-as — the capability guard", () => {
  const run = (session: any, cap: any) => {
    const req: any = { portalSession: session };
    let status: number | undefined;
    const res: any = { status(c: number) { status = c; return { json: () => res }; } };
    let passed = false;
    lib.requireCapability(cap)(req, res, () => { passed = true; });
    return { passed, status };
  };

  it("blocks a mutation route in a support session", () => {
    const out = run(commercial({ impersonatedBy: 9 }), "requestService");
    assert.equal(out.passed, false);
    assert.equal(out.status, 403);
  });

  it("allows the same route for the real customer", () => {
    assert.equal(run(commercial(), "requestService").passed, true);
  });

  it("allows reads in a support session", () => {
    assert.equal(run(commercial({ impersonatedBy: 9 }), "viewInvoices").passed, true);
  });
});
