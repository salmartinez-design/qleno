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

  it("an unready branch falls back to the widget's company and says so", () => {
    // A tenant ROW existing is not the same as a tenant being able to take a
    // booking. Phes Schaumburg (company 4) has existed for months with zero
    // jobs and no pricing — routing to it on row-existence alone produces a job
    // with no price and a card on a merchant that tenant cannot charge.
    assert.match(branchRouter, /usedFallback: true/);
    assert.match(branchRouter, /no company matches this branch/);
    assert.match(branchRouter, /has no square_account_key/);
    assert.match(branchRouter, /has no active pricing scopes/);
  });

  it("routing is all-or-nothing across setup and confirm", () => {
    // The card is tokenized against the merchant chosen at /book/setup and saved
    // by /book/confirm. If those resolve to different companies, the save uses
    // the wrong merchant's token and EVERY booking in that branch fails. Both
    // must go through the one resolver, and it must refuse a half-ready tenant.
    assert.match(branchRouter, /square_account_key[\s\S]{0,400}scope_count/);
    const gate = branchRouter.slice(branchRouter.indexOf("export async function resolveBookingTenant"));
    assert.ok(
      gate.includes("if (!row?.account_key)") && gate.includes("Number(row.scope_count ?? 0) === 0"),
      "both readiness conditions must gate the handover",
    );
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

describe("the whole tenant moves, not just the merchant", () => {
  // The gap this closes: /book/setup routed by zip and handed the browser
  // Schaumburg's application id, but /book/confirm kept using the widget's
  // company_id. The card was tokenized on Schaumburg's merchant and then saved
  // with Oak Lawn's access token, so EVERY Schaumburg booking died at the card
  // step — and because the confirm handler returns 422 on card-save failure, the
  // job was never created. A 100% booking outage that reads as "bad card".
  //
  // Rather than re-route inside confirm (which would then price a co1 scope_id
  // against co4 and throw "Scope not found"), the widget reloads the whole
  // tenant while the customer is still on the contact step.
  it("/book/setup hands back the tenant's slug, configured or not", () => {
    const setup = publicRoutes.slice(
      publicRoutes.indexOf('router.post("/book/setup"'),
      publicRoutes.indexOf('router.post("/book/confirm"'),
    );
    assert.ok(setup.includes("booking_company_slug"), "the widget needs a slug to reload the tenant");
    assert.match(setup, /SELECT slug FROM companies WHERE id = \$\{tenant\.companyId\}/,
      "the slug must come from the ZIP-resolved tenant, not the widget's company");
    // Two returns: the square_enabled:false branch and the configured branch.
    // A branch missing its credentials must still stop selling the other
    // branch's prices, so BOTH have to carry the slug.
    const unconfigured = setup.slice(setup.indexOf("square_enabled: false"), setup.indexOf("square_enabled: true"));
    const configured = setup.slice(setup.indexOf("square_enabled: true"));
    assert.ok(unconfigured.includes("booking_company_slug"), "the not-configured branch must still hand over the tenant");
    assert.ok(configured.includes("booking_company_slug"), "the configured branch must hand over the tenant");
  });

  it("the widget reloads the company when the zip names another branch", () => {
    assert.match(
      book,
      /booking_company_slug[\s\S]{0,600}\/api\/public\/company\//,
      "the widget must re-fetch the tenant it was handed, not just its Square ids",
    );
    assert.match(book, /setCompany\(d\)/, "the swapped tenant has to replace company state");
  });

  it("swapping tenants clears pricing picked from the old catalog", () => {
    // Scope ids are per-company (Oak Lawn Standard Clean = 2, Schaumburg = 31),
    // so a carried-over id fails /calculate with "Scope not found" — another way
    // to lose the booking.
    const swap = book.slice(book.indexOf("booking_company_slug"));
    for (const reset of ["setScopeId(null)", "setFrequencyStr(\"\")", "setSelectedAddonIds([])", "setCalcResult(null)"]) {
      assert.ok(swap.includes(reset), `tenant swap must clear stale pricing: ${reset}`);
    }
    assert.ok(
      swap.includes("setSqConfiguredZip(null)"),
      "the Square probe must re-run so the card field mounts on the new merchant",
    );
  });
});

describe("a zip claimed by both branches routes on purpose", () => {
  // Zones are drawn by hand and drift as zips are added. The old lookup was
  // `SELECT location ... LIMIT 1` with no ORDER BY, so a contested zip resolved
  // to whatever row Postgres returned first — and could differ between two
  // consecutive bookings.
  it("every claiming location is read, not just the first row", () => {
    const fn = branchRouter.slice(branchRouter.indexOf("export async function resolveBranchByZip"));
    assert.ok(!/SELECT location FROM service_zones[\s\S]{0,200}LIMIT 1/.test(fn),
      "a single-row lookup cannot tell that a zip is contested");
    assert.match(fn, /SELECT DISTINCT location/, "read every location claiming the zip");
  });

  it("a contested zip goes to the closest home base", () => {
    assert.match(branchRouter, /nearestBranchByHomeBase/);
    const fn = branchRouter.slice(branchRouter.indexOf("async function nearestBranchByHomeBase"));
    assert.match(fn, /haversineMeters/, "distance decides the tie");
    assert.match(
      fn,
      /SELECT address, city, state, zip FROM companies/,
      "base addresses come from the companies table so settings re-aim routing",
    );
  });

  it("an unresolvable tie still answers the same way twice", () => {
    const fn = branchRouter.slice(branchRouter.indexOf("export async function resolveBranchByZip"));
    assert.match(fn, /\[\.\.\.locs\]\.sort\(\)\[0\]/,
      "geocoding may fail; the fallback must be deterministic, not row order");
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
