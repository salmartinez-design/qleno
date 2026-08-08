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
const square = read("../routes/square.ts");
const prefs = read("../lib/notify-prefs.ts");
const notify = read("../lib/notify.ts");
const alertLib = read("../lib/card-saved-alert.ts");
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

describe("office alert whenever a card lands on file", () => {
  // [card-saved-email 2026-08-08] Sal: notify on EVERY save, office-entered
  // included. The first build covered only customer-completed links, which left
  // the owner blind to cards taken over the phone — most of them.
  it("fires from all THREE save paths", () => {
    const linkCalls = paymentLinks.match(/alertCardSaved\(/g) ?? [];
    assert.equal(linkCalls.length, 2, "Stripe link + Square link");
    assert.ok(square.includes("alertCardSaved("), "office save-card must alert too");
  });

  it("distinguishes who entered the card", () => {
    // The body text differs, so the office can tell a customer-completed link
    // from a card someone took over the phone.
    assert.ok(paymentLinks.includes('source: "link"'));
    assert.ok(square.includes('source: "office"'));
    assert.ok(alertLib.includes("customer added it themselves"));
  });

  it("emails the SHARED inbox, not a copy to each person", () => {
    // Sal, 2026-08-08: alerts "should go to general inbox info@phes.io" — that's
    // where the office already watches Square's mail. A per-person copy is noise
    // and easy to miss on a day someone is out. The bell still fans out to
    // individuals; only the email is consolidated.
    assert.ok(alertLib.includes("sendCompanyInboxAlert("));
    assert.ok(alertLib.includes("notifyOfficeUsers("), "the in-app bell still reaches everyone");
    assert.ok(!alertLib.includes("forceEmail"), "per-person email is no longer used here");
  });

  it("the shared inbox comes from existing columns — no new schema", () => {
    // Adding a column would repeat the 8/7 drift that broke three things.
    assert.match(notify, /SELECT email, lead_notify_email FROM companies/);
    assert.match(notify, /c\.lead_notify_email \|\| c\.email/);
  });

  it("`card_saved` stays out of TYPE_TO_CATEGORY", () => {
    // A mapping would require new notification_prefs COLUMNS. The shared-inbox
    // send deliberately sidesteps the per-user pref system entirely.
    assert.ok(!prefs.includes("card_saved"));
  });

  it("a missing inbox or API key is logged, never silent", () => {
    // The failure mode that cost an afternoon: the bell fires, no email arrives,
    // and nothing anywhere says why.
    assert.ok(notify.includes("has no shared inbox"));
    assert.ok(notify.includes("RESEND_API_KEY not set"));
  });

  it("never blocks the save it is reporting on", () => {
    // The card is already saved by the time this runs; a failed alert must not
    // turn a successful save into a 500 for whoever just took a customer's card.
    assert.match(alertLib, /export async function alertCardSaved[\s\S]*try\s*\{[\s\S]*catch \(e\)/);
  });
});
