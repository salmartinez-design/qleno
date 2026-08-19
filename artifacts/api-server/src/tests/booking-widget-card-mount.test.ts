// [square-attach-hang-widget 2026-08-19] The 2026-08-19 fix to
// components/square-card-form.tsx did NOT cover the public booking widget:
// book.tsx mounts the Square card field itself, and carried both original
// mistakes — it re-attached into one fixed element id and fired destroy()
// without awaiting it.
//
// That matters most here, and specifically for the two-branch setup. The mount
// effect re-runs whenever the merchant ids change, and the ids change whenever
// the customer's zip moves them between Oak Lawn and Schaumburg. So the second
// mount racing the first is the NORMAL path on this page, not an edge case:
// correct a zip on step 4 and the old code attached a Schaumburg card field
// into a node still holding Oak Lawn's dying iframe. card.attach() does not
// reject there — it never settles — so the customer sat on an empty card box
// with no error, at the last step before booking.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const book = read("../../../qleno/src/pages/book.tsx");
const form = read("../../../qleno/src/components/square-card-form.tsx");

describe("booking widget card field", () => {
  it("reuses the shared bounded-await helpers rather than re-rolling them", () => {
    // One source of truth for the timeout machinery, same as loadSquareSdk.
    assert.ok(form.includes("export function withTimeout"));
    assert.ok(form.includes("export const ATTACH_TIMEOUT_MS"));
    assert.ok(form.includes("export const TEARDOWN_WAIT_MS"));
    assert.match(book, /import \{[^}]*withTimeout[^}]*\} from "@\/components\/square-card-form"/);
  });

  it("bounds every await against the Square SDK", () => {
    // An unsettled promise never reaches the catch, so without these the
    // failure has no error state and no retry — just a dead box.
    assert.match(book, /withTimeout<any>\(\s*payments\.card\(/);
    assert.match(book, /withTimeout\(\s*card\.attach\(mount\)/);
  });

  it("attaches to a fresh node, never a reused container id", () => {
    assert.ok(
      !book.includes('card.attach("#square-card-element-book")'),
      "must not attach by fixed id — that node has already held an iframe",
    );
    assert.match(book, /const mount = document\.createElement\("div"\)/);
    assert.match(book, /host\.replaceChildren\(mount\)/);
  });

  it("never rips the previous iframe out from under the SDK", () => {
    assert.ok(
      !book.includes('container.innerHTML = ""'),
      "clearing innerHTML orphans an iframe the SDK still references",
    );
  });

  it("serialises teardown so a merchant switch cannot race the old card", () => {
    assert.match(book, /teardownRef\.current = teardownRef\.current/);
    assert.match(book, /await Promise\.race\(\[\s*teardownRef\.current/);
    assert.ok(
      !/if \(cardInstance\) \{ try \{ cardInstance\.destroy\(\); \} catch/.test(book),
      "fire-and-forget destroy is what let the next mount race the dying iframe",
    );
  });

  it("a failed mount is visible and retryable, not silent", () => {
    // The old code called setSqEnabled(false), which removed the whole card
    // step. The customer never learned why and could not retry.
    assert.match(book, /setSqCardError\(/);
    assert.match(book, /setSqCardRetry\(/);
    assert.ok(book.includes("Try again"));
    assert.match(book, /\}, \[sqEnabled, sqAppId, sqLocationId, sqEnvironment, step, sqCardRetry\]\)/);
  });

  it("a failed card never blocks the booking itself", () => {
    // Losing the sale is worse than losing the card: the office can still send
    // a card link afterwards. The Book button must fall through on error.
    assert.match(book, /sqEnabled === true && !sqCardReady && !sqCardError/);
    assert.ok(
      !/console\.warn\("\[square\] booking card field failed to mount", err\);\s*setSqEnabled\(false\)/.test(book),
      "a mount failure must not silently disable card capture",
    );
  });

  it("still re-fetches the merchant when the zip changes branch", () => {
    // The routing this whole fix exists to protect.
    assert.ok(book.includes("sqConfiguredZip"));
    assert.match(book, /\}, \[step, company, zip\]\)/);
  });
});
