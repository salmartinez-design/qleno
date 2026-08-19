// [square-per-branch 2026-08-19] Oak Lawn and Schaumburg are separately OWNED
// businesses on separate Square merchants paying into separate bank accounts.
// Square customers, saved cards and payment nonces are all merchant-scoped and
// non-transferable, so reading `process.env.SQUARE_ACCESS_TOKEN` anywhere that
// already knows its company is not a style problem — it is money landing in the
// wrong owner's account, or a card written onto a client that the branch holding
// that client can never actually charge.
//
// PR #1498 introduced resolveSquareCredentials() and converted the booking +
// payment-link rails. It did NOT convert the office rails, which kept reading the
// ambient token while scoping their SQL by req.auth.companyId — the exact
// mismatch that puts a Schaumburg client's card on Oak Lawn's merchant.
//
// These assertions are deliberately source-level greps. The alternative is
// booting Express against two live Square merchants, and a test that needs real
// credentials is a test nobody runs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const squareRoutes = read("../routes/square.ts");
const publicRoutes = read("../routes/public.ts");
const webhook = read("../routes/square-webhook.ts");
const customerMap = read("../lib/square-customer-map.ts");
const credentials = read("../lib/square-credentials.ts");

// Comments explain the ambient token; only real reads count.
const ambientReads = (src: string) =>
  (src.match(/^(?!\s*(\/\/|\*)).*process\.env\.SQUARE_ACCESS_TOKEN/gm) || []).length;

describe("no tenant-aware surface reads the ambient Square token", () => {
  it("the office card rails resolve credentials per company", () => {
    // refresh-card and link-card both scope the client by req.auth.companyId,
    // then used to hand Oak Lawn's token to fetchSquareCards. A same-named
    // stranger on the wrong merchant is a plausible match, and link-card writes
    // whatever it matched onto the client as chargeable.
    assert.equal(ambientReads(squareRoutes), 0,
      "routes/square.ts must resolve the token per company, never from the environment");
    const resolved = squareRoutes.match(/resolveSquareCredentials\(companyId\)/g) || [];
    assert.ok(resolved.length >= 2,
      "both refresh-card and link-card must resolve against the caller's company");
  });

  it("the public booking gates check the merchant that will receive the card", () => {
    // The widget swaps the whole tenant on a Schaumburg zip, so company_id here
    // can be 4 while SQUARE_ACCESS_TOKEN still holds Oak Lawn's. Gating on the
    // ambient var both refuses valid Schaumburg bookings (if Oak Lawn's var is
    // unset) and admits ones that must fail later at the card save, after the
    // job row already exists.
    assert.equal(ambientReads(publicRoutes), 0,
      "routes/public.ts must gate on the booking company's credentials");
    assert.ok(publicRoutes.includes("resolveSquareCredentials(Number(company_id))"));
  });

  it("the customer-map sync walks the right merchant's book", () => {
    assert.equal(ambientReads(customerMap), 0,
      "syncSquareCustomerMap must default to the company's own merchant");
  });
});

describe("the resolver refuses to guess", () => {
  it("never falls back to the default merchant when a branch key is set", () => {
    // Falling back is the single most dangerous behaviour available here: it is
    // silent, it looks like success, and it deposits into the other owner's bank
    // account. An unconfigured branch must fail loudly instead.
    assert.ok(credentials.includes("NOT_CONFIGURED"));
    assert.match(credentials, /refusing to fall back/);
  });

  it("rejects an account key that is not a legal env-var suffix", () => {
    assert.match(credentials, /VALID_KEY\s*=\s*\/\^\[A-Z\]\[A-Z0-9_\]\*\$\//);
  });

  it("keeps the access token out of the browser-safe payload", () => {
    const pub = credentials.slice(credentials.indexOf("export function publicPart"));
    assert.ok(!/accessToken/.test(pub.slice(0, 400)),
      "publicPart must never expose the access token");
  });
});

describe("the payment webhook attributes by the merchant that signed", () => {
  it("does not pin every payment to company 1", () => {
    assert.ok(!/const companyId = Number\(process\.env\.SQUARE_COMPANY_ID \?\? 1\)/.test(webhook),
      "a hardcoded tenant credits Schaumburg payments against Oak Lawn's invoices");
    assert.ok(webhook.includes("companyForAccountKey(signedBy)"));
  });

  it("verifies against every configured merchant's signing key", () => {
    // Each Square merchant signs with its own secret. Checking only the
    // unsuffixed key rejects every Schaumburg event as an invalid signature —
    // which fails CLOSED (payments simply never reconcile) but silently.
    assert.ok(webhook.includes("listSquareAccountKeys"));
    assert.ok(webhook.includes("webhookSignatureKey"));
  });

  it("still accepts nothing when no signing key is configured", () => {
    // This endpoint marks invoices paid, so there is no unsigned dev fallback.
    assert.ok(webhook.includes("anyKeyConfigured"));
    assert.match(webhook, /if \(!anyKeyConfigured\)[\s\S]{0,220}status\(503\)/);
    assert.match(webhook, /if \(!verified\)[\s\S]{0,200}status\(401\)/);
  });

  it("drops an unattributable payment instead of guessing a company", () => {
    assert.match(webhook, /companyId == null[\s\S]{0,300}unattributed/);
  });

  it("identifies the tenant only from VERIFIED signature, never the payload", () => {
    // The body is attacker-controlled until a signature verifies. Reading
    // location_id to pick a tenant before verification would let an unsigned
    // caller choose which company's books to touch.
    const sigIdx = webhook.indexOf("if (!verified)");
    const bodyIdx = webhook.indexOf("JSON.parse(rawBody");
    assert.ok(sigIdx > -1 && bodyIdx > sigIdx,
      "the body must not be parsed before the signature is verified");
  });
});
