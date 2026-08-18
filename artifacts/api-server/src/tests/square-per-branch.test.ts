// [square-per-branch 2026-08-18] Oak Lawn and Schaumburg are separate businesses
// on separate Square MERCHANT accounts. Money from a Schaumburg job has to
// settle into Schaumburg's Square account.
//
// The failure this guards against is silent and expensive: a Square call that
// reads process.env directly transacts on whichever merchant the process was
// started with, regardless of whose customer it is. That looks like a working
// booking and puts the money in the other business's bank account — or saves a
// card on a merchant that can never charge it, since Square cards are
// merchant-scoped and cannot be moved.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const creds = read("../lib/square-credentials.ts");
const cardOnFile = read("../lib/square-card-onfile.ts");
const squareCharge = read("../lib/square-charge.ts");
const chargeInvoice = read("../lib/charge-invoice.ts");
const squareConfig = read("../lib/square-config.ts");
const branchRouter = read("../lib/branchRouter.ts");
const publicRoutes = read("../routes/public.ts");
const squareRoutes = read("../routes/square.ts");
const paymentLinks = read("../routes/payment-links.ts");
const migration = read("../phes-data-migration.ts");
const book = read("../../../qleno/src/pages/book.tsx");

describe("no Square call transacts on the ambient process environment", () => {
  // Each of these files performs money movement or card storage. If any reads
  // SQUARE_ACCESS_TOKEN itself, it bypasses the per-company resolver and bills
  // through whichever merchant the process happens to hold.
  const MONEY_FILES: Array<[string, string]> = [
    ["square-card-onfile", cardOnFile],
    ["square-charge", squareCharge],
    ["charge-invoice", chargeInvoice],
    ["square-config", squareConfig],
  ];

  it("only square-credentials.ts reads the SQUARE_* env vars", () => {
    for (const [name, src] of MONEY_FILES) {
      assert.ok(
        !/process\.env\.SQUARE_ACCESS_TOKEN/.test(src),
        `${name} must resolve credentials per company, not from process.env`,
      );
      assert.ok(
        !/process\.env\.SQUARE_ENV/.test(src),
        `${name} must take its environment from the resolved credentials`,
      );
    }
    assert.ok(creds.includes("SQUARE_ACCESS_TOKEN"), "the resolver is where env reads belong");
  });

  it("every money path resolves credentials from a companyId", () => {
    for (const [name, src] of MONEY_FILES) {
      assert.ok(
        /resolveSquareCredentials\(/.test(src),
        `${name} must call resolveSquareCredentials`,
      );
    }
  });

  it("chargeSquareCard requires a companyId from its callers", () => {
    assert.match(squareCharge, /companyId: number;/);
    // Both charge buttons (dispatch + customer profile) must pass it, or the
    // charge silently uses the default merchant.
    for (const [name, src] of [
      ["payments route", read("../routes/payments.ts")],
      ["jobs route", read("../routes/jobs.ts")],
    ] as const) {
      assert.match(src, /chargeSquareCard\(\{\s*\n\s*companyId/, `${name} must pass companyId`);
    }
  });
});

describe("a misconfigured branch fails loudly instead of billing the other one", () => {
  // Every one of these would otherwise resolve to the DEFAULT merchant, which is
  // Oak Lawn. Silently. That is the single worst outcome available here, so each
  // returns not-configured rather than falling through.
  it("an unknown company does not fall back to the default merchant", () => {
    assert.match(creds, /no company \$\{companyId\}[\s\S]{0,80}refusing to fall back/);
  });

  it("an invalid account key does not fall back", () => {
    assert.ok(creds.includes("invalid square_account_key"));
    assert.match(creds, /VALID_KEY = \/\^\[A-Z\]/);
  });

  it("a branch whose env vars are missing is reported, not silently defaulted", () => {
    assert.match(creds, /wants Square account '\$\{key\}'/);
  });

  it("the access token is never in the browser-safe payload", () => {
    assert.match(creds, /export function publicPart[\s\S]{0,320}\}/);
    const publicFn = creds.slice(creds.indexOf("export function publicPart"));
    assert.ok(!publicFn.includes("accessToken"), "publicPart must not expose the secret");
  });
});

describe("the zip picks the branch, and the branch picks the merchant", () => {
  it("branch resolution is DB-first, with the hardcoded list as fallback", () => {
    // Sal edits service_zones, not branchRouter.ts. Two zip lists that can drift
    // is how a zip gets billed to one branch and emailed to the other.
    assert.match(branchRouter, /FROM service_zones[\s\S]{0,120}zip_codes @> ARRAY/);
    assert.ok(branchRouter.includes("return getBranchByZip(clean).branch"), "fallback retained");
  });

  it("an unmapped branch falls back to the widget's company and says so", () => {
    // Before the Schaumburg tenant exists, bookings must keep working exactly as
    // they do today — but never silently.
    assert.match(branchRouter, /usedFallback: true/);
    assert.match(branchRouter, /console\.warn\([\s\S]{0,200}no company matches it/);
  });

  it("/book/setup resolves the merchant from the ZIP, not the widget's slug", () => {
    // The application id handed to the browser decides which merchant KEEPS the
    // card. It must be the destination branch's, chosen before the card mounts.
    assert.match(publicRoutes, /resolveBookingTenant\(String\(zip/);
    assert.match(publicRoutes, /getSquarePublicConfig\(tenant\.companyId\)/);
  });

  it("the widget re-fetches config when the zip changes", () => {
    // A customer who corrects their zip after the card field mounted must get a
    // field pointed at the other merchant, or the card lands in the wrong business.
    assert.ok(book.includes("sqConfiguredZip"));
    assert.match(book, /\}, \[step, company, zip\]\);/);
    assert.match(book, /body: JSON\.stringify\(\{ company_id: company\.id, zip,/);
  });
});

describe("office and link surfaces are company-scoped too", () => {
  it("GET /api/square/config serves the caller's own branch", () => {
    assert.match(squareRoutes, /getSquarePublicConfig\(req\.auth!\.companyId!\)/);
  });

  it("a public /pay link uses the link's own company", () => {
    assert.match(paymentLinks, /getSquarePublicConfig\(link\.company_id\)/);
  });
});

describe("the column exists before anything reads it", () => {
  it("square_account_key is added on cold start, idempotently", () => {
    assert.match(migration, /companies\.square_account_key[\s\S]{0,140}ADD COLUMN IF NOT EXISTS square_account_key TEXT/);
  });
});
