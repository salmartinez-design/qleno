/**
 * [quote-address-whole 2026-08-21]
 *
 * Maribel, on Fidelma Orourke's card: "not displaying the whole address here".
 * The card rendered "7901 Braeloch Court" and stopped. No town, no state, no
 * zip. It was never a display bug - the quote itself only ever held the street.
 *
 * The quote builder runs its own Google Places listener (it does not use the
 * shared useAddressAutocomplete hook). Google hands back street, city, state
 * and zip as separate components; the handler kept the street and dropped the
 * other three:
 *
 *     setAddress(street || formatted);          // <- the whole bug
 *
 * quotes.address is a single text column and is the only address carrier from
 * the quote to the converted job, so those three components were gone for good.
 * 173 of the 454 quotes written since the 7/1 cutover contain no comma at all.
 * The 2026-08-19 [quote-address-cascade] fix taught the CONVERT step to split
 * the line into four job columns, but it can only split what it is given - a
 * street-only quote still produced a job with no city and no zone.
 *
 * These tests pin the contract between the two halves: the builder writes the
 * canonical one-line shape, and parseAddressLine reads all four back out.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseAddressLine } from "../lib/parse-address.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER = resolve(HERE, "../../../qleno/src/pages/quote-builder.tsx");

/** Mirrors the builder's compose step. */
const compose = (street: string, city: string, state: string, zip: string) =>
  [street, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");

/** Mirrors the builder's withZip() helper. */
function withZip(line: string, zip: string): string {
  const a = line.trim().replace(/,\s*$/, "");
  const z = zip.trim();
  if (!a || !z) return a;
  if (/\b\d{5}(-\d{4})?$/.test(a)) return a;
  return /,\s*[A-Za-z]{2}$/.test(a) ? `${a} ${z}` : `${a}, ${z}`;
}

describe("what the builder writes, the parser reads back", () => {
  test("a Google pick round-trips all four components", () => {
    const line = compose("7901 Braeloch Court", "Palos Heights", "IL", "60463");
    assert.equal(line, "7901 Braeloch Court, Palos Heights, IL 60463");
    const p = parseAddressLine(line);
    assert.equal(p.street, "7901 Braeloch Court");
    assert.equal(p.city, "Palos Heights");
    assert.equal(p.state, "IL");
    assert.equal(p.zip, "60463");
  });

  test("a Google pick with no zip still keeps city and state", () => {
    const p = parseAddressLine(compose("123 Main St", "Oak Lawn", "IL", ""));
    assert.equal(p.street, "123 Main St");
    assert.equal(p.city, "Oak Lawn");
    assert.equal(p.state, "IL");
    assert.equal(p.zip, null);
  });

  test("the Zip box lands beside a state, not in the city slot", () => {
    // Appending ", 60463" here would read "IL" as the city and
    // "7901 Braeloch Court, Palos Heights" as the street.
    const p = parseAddressLine(withZip("7901 Braeloch Court, Palos Heights, IL", "60463"));
    assert.equal(p.street, "7901 Braeloch Court");
    assert.equal(p.city, "Palos Heights");
    assert.equal(p.state, "IL");
    assert.equal(p.zip, "60463");
  });

  test("the Zip box lands after a bare city", () => {
    const p = parseAddressLine(withZip("7901 Braeloch Court, Palos Heights", "60463"));
    assert.equal(p.street, "7901 Braeloch Court");
    assert.equal(p.city, "Palos Heights");
    assert.equal(p.zip, "60463");
  });

  test("a hand-typed street plus the Zip box keeps the zip", () => {
    const p = parseAddressLine(withZip("7901 Braeloch Court", "60463"));
    assert.equal(p.street, "7901 Braeloch Court");
    assert.equal(p.zip, "60463");
  });

  test("withZip never doubles a zip that is already there", () => {
    const line = "7901 Braeloch Court, Palos Heights, IL 60463";
    assert.equal(withZip(line, "60463"), line);
  });

  test("the shipped bug: street-only yields nothing to recover", () => {
    const p = parseAddressLine("7901 Braeloch Court");
    assert.equal(p.street, "7901 Braeloch Court");
    assert.equal(p.city, null);
    assert.equal(p.state, null);
    assert.equal(p.zip, null);
  });
});

describe("the builder source keeps all four components", () => {
  // Strip line comments first - the fix's own comment quotes the broken call
  // verbatim to explain it, and a naive scan matches its own explanation.
  const src = readFileSync(BUILDER, "utf8")
    .split(String.fromCharCode(10))
    .filter((l) => !l.trim().startsWith("//"))
    .join(String.fromCharCode(10));

  test("the street-only write is gone", () => {
    assert.ok(
      !/setAddress\(street \|\| formatted\)/.test(src),
      "quote-builder.tsx is writing the street alone again - this is the Fidelma Orourke bug",
    );
  });

  test("the pick handler reads city and state, not just street and zip", () => {
    assert.match(src, /const city = get\("locality"\)/);
    assert.match(src, /const state = shortGet\("administrative_area_level_1"\)/);
    assert.match(src, /setAddress\(composed \|\|/);
  });

  test("the save payload folds the Zip box in", () => {
    assert.match(src, /address: withZip\(address \|\| client\?\.address \|\| "", zipCode\)/);
  });
});
