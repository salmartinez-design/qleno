/**
 * Multi-recipient estimates.
 *
 * Stub-DB. Pins: cc_emails column + migration, the normalizeEmails parser
 * (comma/semicolon/array, validate, dedupe, drop primary, cap), and that the
 * drip CCs every email touch while SMS stays single-recipient.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { estimatesTable } from "@workspace/db/schema";
import { normalizeEmails } from "../routes/estimates.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("multi-recipient — schema + migration", () => {
  it("estimates.cc_emails exists", () => {
    const col = (estimatesTable as any).cc_emails;
    assert.ok(col, "cc_emails should exist");
    assert.equal(col.name, "cc_emails");
  });
  it("migration adds it idempotently", () => {
    assert.match(read("../phes-data-migration.ts"), /ALTER TABLE estimates ADD COLUMN IF NOT EXISTS cc_emails TEXT/);
  });
});

describe("normalizeEmails", () => {
  it("parses comma / semicolon / whitespace", () => {
    assert.equal(normalizeEmails("a@x.com, b@y.com; c@z.com"), "a@x.com,b@y.com,c@z.com");
  });
  it("accepts an array too", () => {
    assert.equal(normalizeEmails(["A@X.com", "b@y.com"]), "a@x.com,b@y.com");
  });
  it("lowercases, dedupes, and drops invalid tokens", () => {
    assert.equal(normalizeEmails("A@X.com, a@x.com, notanemail, b@y.com"), "a@x.com,b@y.com");
  });
  it("excludes the primary recipient", () => {
    assert.equal(normalizeEmails("primary@x.com, cc@y.com", "primary@x.com"), "cc@y.com");
  });
  it("returns null when empty", () => {
    assert.equal(normalizeEmails(""), null);
    assert.equal(normalizeEmails("garbage only"), null);
  });
});

describe("multi-recipient — drip + UI wiring", () => {
  const engine = read("../services/followUpService.ts");
  it("email sender accepts + applies a CC list", () => {
    assert.match(engine, /cc\?: string\[\]/);
    assert.match(engine, /\{ cc: ccList \}/);
  });
  it("estimate touch reads cc_emails and passes it to the email send", () => {
    assert.match(engine, /SELECT contact_name, contact_email, cc_emails/);
    assert.match(engine, /emailBrand, unsub \?\? undefined, ccEmails\)/);
  });
  it("SMS stays single-recipient (recipientPhone only)", () => {
    assert.match(engine, /sendSmsVia\(sender, recipientPhone, body\)/);
  });
  it("builder persists cc_emails + renders the CC field", () => {
    const ui = read("../../../qleno/src/pages/estimate-builder.tsx");
    assert.match(ui, /cc_emails: ccEmails\.join\(","\)/);
    assert.match(ui, /CC — also email these people/);
  });
});
