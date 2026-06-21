// [comms-opt-out 2026-06-21] Unit tests for the pure opt-out helpers — keyword
// detection, phone normalization, and the List-Unsubscribe header/footer
// builder. Runs without a live DB.
//
//   pnpm --filter @workspace/api-server run test:optout
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  phoneDigits,
  isStopKeyword,
  isStartKeyword,
  buildUnsubDataFromToken,
  appBaseUrl,
} from "../lib/opt-out-core.js";

describe("phoneDigits", () => {
  it("normalizes to last 10 digits", () => {
    assert.equal(phoneDigits("(773) 818-8400"), "7738188400");
    assert.equal(phoneDigits("+1 773-818-8400"), "7738188400");
    assert.equal(phoneDigits("7738188400"), "7738188400");
    assert.equal(phoneDigits(null), "");
  });
});

describe("STOP / START keyword detection", () => {
  it("recognizes all carrier STOP keywords (case/space-insensitive)", () => {
    for (const w of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "cancel", "QUIT", "end", "stopall"]) {
      assert.equal(isStopKeyword(w), true, `expected STOP for "${w}"`);
    }
  });
  it("recognizes START keywords", () => {
    for (const w of ["START", "unstop", "YES", "resume"]) {
      assert.equal(isStartKeyword(w), true, `expected START for "${w}"`);
    }
  });
  it("does not treat normal replies as STOP/START", () => {
    for (const w of ["thanks!", "see you then", "5", "stop by anytime"]) {
      assert.equal(isStopKeyword(w), false);
      assert.equal(isStartKeyword(w), false);
    }
  });
});

describe("List-Unsubscribe header + footer", () => {
  it("builds RFC 8058 one-click headers pointing at the tokenized route", () => {
    const u = buildUnsubDataFromToken("tok-123");
    assert.equal(u.unsubUrl, `${appBaseUrl()}/api/comms/unsubscribe?token=tok-123`);
    assert.equal(u.headers["List-Unsubscribe"], `<${u.unsubUrl}>`);
    assert.equal(u.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  });
  it("footer contains a working unsubscribe link (not the dead phes.io/unsubscribe)", () => {
    const u = buildUnsubDataFromToken("tok-xyz");
    assert.match(u.footerHtml, /\/api\/comms\/unsubscribe\?token=tok-xyz/);
    assert.doesNotMatch(u.footerHtml, /phes\.io\/unsubscribe/);
  });
  it("url-encodes the token", () => {
    const u = buildUnsubDataFromToken("a b/c");
    assert.match(u.unsubUrl, /token=a%20b%2Fc/);
  });
});
