/**
 * resolveSender from-number fallback.
 *
 * Manual / company-scoped sends pass no branch, and Phes (co1) keeps its Twilio
 * numbers on the BRANCHES (company-level number is null) — so those sends used
 * to resolve no_from_number and silently suppress. resolveSender now falls back
 * to the company's primary branch number. If NO branch has a number it must stay
 * null (we never invent one).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../lib/comms-sender.ts"),
  "utf8",
);

describe("resolveSender from-number fallback", () => {
  it("falls back to a branch number when none resolved", () => {
    assert.match(src, /if \(!from_number\)/);
    assert.match(src, /FROM branches[\s\S]*twilio_from_number IS NOT NULL/);
  });
  it("picks the primary/first active branch (comms_enabled first, then id)", () => {
    assert.match(src, /ORDER BY comms_enabled DESC, id ASC/);
  });
  it("never invents a number — stays null → no_from_number", () => {
    // fallback only assigns from the query result; reason still flags no_from_number
    assert.match(src, /from_number = \(fb\.rows\[0\] as any\)\?\.twilio_from_number \?\? null/);
    assert.match(src, /!from_number \? "no_from_number"/);
  });
});
