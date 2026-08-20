/** Recurring signups get the agreement. One-time cleans do not. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

// The module under test reaches @workspace/db for its already-has-one check, and
// that module refuses to load without a DATABASE_URL. Nothing here runs a query
// — the pool is lazy — so a placeholder is enough to get the pure gate function
// loaded, and it guarantees these tests can never touch a real database.
process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
const { signupNeedsAgreement } = await import("../lib/signup-agreement.js");

describe("signup agreement gate", () => {
  // Sal, 2026-08-20, on when the website should send the agreement by itself:
  // "only when they sign up for recurring service." A one-time clean is a single
  // transaction. A recurring customer is entering an arrangement with a cadence,
  // a rate and a cancellation notice — that is what the contract covers.
  it("sends on every recurring cadence", () => {
    for (const f of ["weekly", "biweekly", "every_3_weeks", "monthly"]) {
      assert.equal(signupNeedsAgreement(f), true, f);
    }
  });

  it("does not send on a one-time clean", () => {
    for (const f of ["on_demand", "onetime", "one_time", "", null, undefined]) {
      assert.equal(signupNeedsAgreement(f as any), false, String(f));
    }
  });

  // A one-time booking that took the convert-to-recurring upsell IS a recurring
  // signup — the cadence just arrives on the upsell fields instead of `frequency`.
  // Gating on `frequency` alone would silently skip exactly the customers the
  // upsell was built to create.
  it("sends when a one-time booking accepts the recurring upsell", () => {
    assert.equal(signupNeedsAgreement("on_demand", true), true);
  });

  it("is wired into both booking paths", () => {
    const pub = read("../routes/public.ts");
    assert.match(pub, /import \{ maybeSendSignupAgreement \} from "\.\.\/lib\/signup-agreement\.js"/);
    // Once in the Square confirm path, once in the Stripe-disabled fallback.
    assert.equal((pub.match(/await maybeSendSignupAgreement\(/g) || []).length, 2);
    assert.match(pub, /upsellAccepted: upsellAcceptedVal/);
  });

  // The automatic send is an automated communication, so it obeys COMMS_ENABLED
  // and the per-tenant gate — same as the booking confirmation it rides with. The
  // office pressing Send on the profile stays transactional and still bypasses.
  it("the automatic send respects the comms gate, the office send does not", () => {
    const lib = read("../lib/signup-agreement.ts");
    assert.match(lib, /transactional: false/);
    const send = read("../lib/send-agreement.ts");
    assert.match(send, /opts\.transactional !== false/);
  });

  // Two live signing links in one inbox means the second one signed supersedes a
  // contract the customer may already have agreed to.
  it("skips a client who already has an agreement open or signed", () => {
    const lib = read("../lib/signup-agreement.ts");
    assert.match(lib, /status = 'signed' OR \(status = 'pending'/);
  });
});
