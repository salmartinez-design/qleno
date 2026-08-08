// [lead-card-capture 2026-08-08] Sal: "all of this being enabled should take
// priority with a new client. then an existing one."
//
// A card on file has to hang off a client record, so the quote builder only
// offered card capture once an EXISTING client was picked — for a new customer
// the whole Payment Method block was replaced with "select an existing client
// above". That inverted the priority: the call is exactly when someone will read
// a card out, and Maribel had to convert, go find the customer, and ask again.
//
// The fix leans on something convert already did: it materializes a client from
// the lead's details. So the browser parks the one-time Square nonce, ships it
// with the convert, and the server attaches it once the client exists.
//
// Also pinned here: replacing a card must RETIRE the old one in Square.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const quotes = read("../routes/quotes.ts");
const onFile = read("../lib/square-card-onfile.ts");
const builder = read("../../../qleno/src/pages/quote-builder.tsx");

// The convert handler only — assertions must not accidentally match another route.
const convert = quotes.slice(
  quotes.indexOf('router.post("/:id/convert"'),
  quotes.indexOf("router.delete(\"/:id\""),
);

describe("card capture for a brand-new customer", () => {
  it("the quote builder no longer dead-ends new leads", () => {
    assert.ok(
      !builder.includes("Select an existing client above to save a card on file"),
      "the old dead-end copy must be gone",
    );
    assert.ok(builder.includes("saves the moment you book"));
  });

  it("the nonce is parked client-side and shipped with the convert", () => {
    assert.ok(builder.includes("pendingCardToken"));
    assert.ok(builder.includes("square_card_token: pendingCardToken"));
  });

  it("convert attaches the card AFTER the client is materialized", () => {
    const clientCreate = convert.indexOf("INSERT INTO clients");
    const cardSave = convert.indexOf("saveSquareCardOnFile");
    assert.ok(clientCreate > -1 && cardSave > -1);
    assert.ok(cardSave > clientCreate, "card save must come after the client insert");
  });

  it("a card failure never fails the booking", () => {
    // The job is already created by this point. Losing the booking because a
    // card declined would be far worse than a card that needs re-entering.
    const block = convert.slice(convert.indexOf("const squareCardToken"));
    assert.match(block.slice(0, 1400), /try\s*\{[\s\S]*catch \(e: any\)/);
    assert.ok(block.includes("cardSaved = { ok: false"));
  });

  it("a card failure is never silent", () => {
    // Worst case is the office believing a new customer is billable and finding
    // out weeks later when the first invoice can't be charged.
    assert.ok(convert.includes("card_saved: cardSaved"));
    assert.ok(builder.includes("the card didn't save"));
  });

  it("refuses to save against a null tenant", () => {
    assert.match(convert, /squareCardToken && clientId && companyId != null/);
  });
});

describe("replacing a card retires the old one", () => {
  it("disables every other card on the Square customer", () => {
    // chargeSquareCard picks `cards.list(DESC).find(c => c.enabled)`. Leaving the
    // previous card enabled meant the charged card depended on Square's ordering,
    // not on which card the office had just entered — so a customer who called to
    // replace a dead card could still be billed on it.
    assert.ok(onFile.includes("cards.disable("));
    assert.match(onFile, /old\.id === card\.id/, "must never disable the card it just created");
  });

  it("a failed retire does not lose the card that was just saved", () => {
    const block = onFile.slice(onFile.indexOf("cards.list({ customerId: squareCustomerId"));
    assert.match(block.slice(0, 900), /catch \(e: any\)/);
  });
});
