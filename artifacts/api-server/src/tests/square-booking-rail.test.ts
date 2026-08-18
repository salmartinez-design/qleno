// [square-booking 2026-08-18] The public booking widget captures cards with
// SQUARE, not Stripe.
//
// Sal: "we just want to unplug stripe and connect Square to take its place."
// Square is the house merchant. Before this, an online booking went to Stripe
// while the SAME customer calling the office went to Square — two processors,
// two card-on-file records, and a day-of-service charge that depended on which
// way they happened to book.
//
// These are source-text assertions because nothing type-checks across the HTTP
// boundary or between the widget and the confirm handlers. The specific
// regressions they hold shut are named on each test.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const publicRoutes = read("../routes/public.ts");
const book = read("../../../qleno/src/pages/book.tsx");
const cardForm = read("../../../qleno/src/components/square-card-form.tsx");
const paymentSource = read("../lib/payment-source.ts");
const chargeInvoice = read("../lib/charge-invoice.ts");
const claudeMd = read("../../../../CLAUDE.md");

describe("the booking widget captures with Square, not Stripe", () => {
  it("book.tsx has no Stripe card capture left in it", () => {
    // A leftover Stripe Element would mount a second card field and the
    // customer would fill in whichever one rendered.
    const code = book.replace(/^.*\[square-booking 2026-08-18\] Was Stripe.*$/m, "");
    assert.ok(!/js\.stripe\.com/.test(code), "no Stripe SDK script");
    assert.ok(!/confirmCardSetup/.test(code), "no SetupIntent confirmation");
    assert.ok(!/stripe-card-element-book/.test(code), "no Stripe card container");
    assert.ok(!/payment_method_id/.test(code), "no Stripe payment_method_id in the payload");
  });

  it("book.tsx tokenizes with Square and posts the nonce", () => {
    assert.ok(book.includes("sqCard.tokenize()"));
    assert.ok(book.includes("square_source_id: squareSourceId"));
    assert.ok(book.includes('id="square-card-element-book"'));
  });

  it("the widget reuses the hardened SDK loader instead of its own", () => {
    // The widget is the revenue funnel. A hand-rolled one-shot loader there
    // (which is what the Stripe path had) turns one CDN blip into a lost sale.
    assert.match(book, /import \{ loadSquareSdk.*\} from "@\/components\/square-card-form"/);
    assert.match(cardForm, /export function loadSquareSdk/);
  });

  it("/book/setup is a config probe — no SetupIntent, no Stripe customer", () => {
    // Square tokenizes from the two PUBLIC ids alone; there is no client_secret
    // to mint, so this endpoint must not create anything.
    assert.ok(publicRoutes.includes("square_enabled"));
    assert.ok(publicRoutes.includes("square_application_id"));
    assert.ok(publicRoutes.includes("square_location_id"));
    assert.ok(!publicRoutes.includes("setupIntents.create"));
    assert.ok(!publicRoutes.includes("stripe.customers.create"));
  });

  it("both confirm handlers take the nonce and save through Square", () => {
    const saves = publicRoutes.match(/saveSquareCardOnFile\(\{/g) ?? [];
    assert.equal(saves.length, 2, "residential /book/confirm + /book/commercial-confirm");
    assert.ok(!publicRoutes.includes("paymentMethods.retrieve"));
    assert.ok(!publicRoutes.includes("paymentMethods.attach"));
  });

  it("saveSquareCardOnFile is the ONLY writer of card columns on booking", () => {
    // Writing card_last_four in the confirm handler too is how a displayed
    // last4 drifts from the card that actually gets charged.
    assert.ok(!/payment_source = 'stripe'/.test(publicRoutes));
    assert.ok(!/stripe_payment_method_id = \$\{/.test(publicRoutes));
    assert.ok(!/card_last_four = \$\{/.test(publicRoutes));
  });

  it("the no-card fallback stays shut whenever Square is live", () => {
    // POST /api/public/book creates a booking with NO card on file. Its guard
    // used to read STRIPE_SECRET_KEY — with Stripe unplugged, removing that key
    // would have swung the path open and let jobs book uncollectably.
    assert.match(publicRoutes, /if \(getSquarePublicConfig\(\)\.configured\) \{[\s\S]{0,160}Card verification required/);
    // Match the env READ, not the word — the comment above that guard explains
    // what it used to read, and should not fail its own test.
    assert.ok(!publicRoutes.includes("process.env.STRIPE_SECRET_KEY"));
  });
});

describe("existing Stripe clients keep working", () => {
  // Unplugging CAPTURE must not unplug COLLECTION. Clients who booked online
  // before the switch still hold a stripe_payment_method_id and are charged
  // through Stripe until their next card save migrates them.
  it("derivePaymentSource still routes a stored Stripe method to Stripe", () => {
    assert.match(paymentSource, /stripe_payment_method_id \? "stripe" : "square"/);
  });

  it("the charge path still handles Stripe", () => {
    assert.ok(/stripe/i.test(chargeInvoice), "charge-invoice must keep its Stripe branch");
  });
});

describe("CLAUDE.md records the reversal", () => {
  // The old text was under "Hard Rules — Never Reverse" and said the widget
  // always uses Stripe. Leaving it would point the next session at the
  // behavior this change just removed.
  it("states the single Square rail and drops the widget-stays-Stripe rule", () => {
    assert.ok(claudeMd.includes("SINGLE-RAIL SQUARE"));
    assert.ok(!claudeMd.includes("the PUBLIC website booking widget always uses\n  Stripe"));
  });

  it("keeps the charge path explicitly protected", () => {
    assert.ok(claudeMd.includes("Stripe is capture-dead, charge-alive"));
  });
});
