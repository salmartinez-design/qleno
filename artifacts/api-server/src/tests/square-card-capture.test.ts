// [square-appid-case 2026-08-07] Guards two things that were silently broken:
//
// 1. GET /api/square/config returns CAMELCASE (`applicationId` / `locationId`).
//    quote-builder.tsx read snake_case, so both ids arrived "" while
//    `configured` stayed true — the modal then called Square.payments("", "")
//    and the SDK answered "The Payment 'applicationId' option is not in the
//    correct format." Nothing type-checks across the HTTP boundary, so these
//    assertions are the only thing holding the two sides together.
//
// 2. Saving a card through a public payment link now alerts the office. Before,
//    a texted/emailed link could be completed by the customer with nothing
//    surfacing it anywhere.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const config = read("../lib/square-config.ts");
const paymentLinks = read("../routes/payment-links.ts");
const prefs = read("../lib/notify-prefs.ts");
const quoteBuilder = read("../../../qleno/src/pages/quote-builder.tsx");
const customerProfile = read("../../../qleno/src/pages/customer-profile.tsx");

describe("square public config — key casing contract", () => {
  it("the server emits camelCase ids", () => {
    assert.ok(config.includes("applicationId"));
    assert.ok(config.includes("locationId"));
    assert.ok(!config.includes("application_id"));
  });

  it("every consumer of /api/square/config reads the camelCase keys", () => {
    // The bug: `d.application_id || ""` — always "" against this endpoint.
    // snake_case belongs only to the PUBLIC /pay payload (payment-links.ts →
    // pay.tsx); neither office page should contain it at all.
    for (const [name, src] of [
      ["quote-builder", quoteBuilder],
      ["customer-profile", customerProfile],
    ] as const) {
      assert.ok(
        src.includes("applicationId") && src.includes("locationId"),
        `${name} must read applicationId/locationId`,
      );
      assert.ok(
        !src.includes("application_id") && !src.includes("location_id"),
        `${name} must not read the snake_case keys — /api/square/config never sends them`,
      );
    }
  });

  it("the card form is never rendered with a blank applicationId", () => {
    // A blank id is what produces the SDK's "not in the correct format" error,
    // so `configured` alone is not a sufficient gate — the ids must be present.
    for (const [name, src] of [
      ["quote-builder", quoteBuilder],
      ["customer-profile", customerProfile],
    ] as const) {
      assert.ok(
        /configured\s*&&\s*sqCfg\.applicationId\s*&&\s*sqCfg\.locationId/.test(src),
        `${name} must gate SquareCardForm on non-empty ids`,
      );
    }
  });
});

describe("office alert when a customer saves a card via a link", () => {
  it("both public save-card rails alert the office", () => {
    const calls = paymentLinks.match(/alertOfficeCardSaved\(/g) ?? [];
    // One at the Stripe endpoint, one at the Square endpoint, plus the definition.
    assert.equal(calls.length, 3);
    assert.ok(paymentLinks.includes('processor: "stripe"'));
    assert.ok(paymentLinks.includes('processor: "square"'));
  });

  it("goes to the office via notifyOfficeUsers", () => {
    assert.ok(paymentLinks.includes("notifyOfficeUsers("));
  });

  it("is IN-APP-ONLY (not mapped to an email category)", () => {
    // An unmapped type delivers to the bell and never emails — see notify.ts.
    assert.ok(!prefs.includes("card_saved"));
  });

  it("never blocks the save it is reporting on", () => {
    // The card is already saved by the time we alert; a failed alert must not
    // turn a successful save into a 500.
    const body = paymentLinks.slice(paymentLinks.indexOf("async function alertOfficeCardSaved"));
    assert.ok(/try\s*\{/.test(body.slice(0, 800)));
    assert.ok(/catch\s*\(e\)/.test(body.slice(0, 1600)));
  });
});
