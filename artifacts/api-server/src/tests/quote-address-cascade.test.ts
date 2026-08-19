/**
 * [quote-address-cascade 2026-08-19] Maribel: "it's not cascading from the
 * quote, so we can't see the city and for some reason doesnt assign the zone
 * automatically."
 *
 * The quote builder stores the address as ONE text column, because that is how
 * the office types it. Convert then carried the string forward whole: the client
 * got it in `address` with city/state/zip NULL, and the job got it in
 * `address_street` with no city, no state, no zip and NO ZONE. A converted quote
 * produced a customer with no town on file and a grey, unroutable tile.
 *
 * Cynthiia Lopezz (CL-1533) is the shape exactly — `clients.address` reading
 * "17878 Argos Court, Tinley Park, IL 60477" with three empty columns beside it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAddressLine, fillAddressGaps } from "../lib/parse-address.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

describe("parseAddressLine", () => {
  it("CL-1533, the record that started this", () => {
    assert.deepEqual(parseAddressLine("17878 Argos Court, Tinley Park, IL 60477"), {
      street: "17878 Argos Court", city: "Tinley Park", state: "IL", zip: "60477",
    });
  });

  it("handles a unit number in the street", () => {
    assert.deepEqual(parseAddressLine("559 West Surf Street 307, Chicago, IL 60657"), {
      street: "559 West Surf Street 307", city: "Chicago", state: "IL", zip: "60657",
    });
  });

  it("handles ZIP+4", () => {
    assert.equal(parseAddressLine("1 Main St, Springfield, IL 62704-1234").zip, "62704");
  });

  it("state without a zip", () => {
    assert.deepEqual(parseAddressLine("596 West Hawthorne Place, Chicago, IL"), {
      street: "596 West Hawthorne Place", city: "Chicago", state: "IL", zip: null,
    });
  });

  it("zip stuck to the city, no state typed", () => {
    assert.deepEqual(parseAddressLine("2453 139th Street, Blue Island 60406"), {
      street: "2453 139th Street", city: "Blue Island", state: null, zip: "60406",
    });
  });

  it("street and city only", () => {
    assert.deepEqual(parseAddressLine("420 Hickory Lane, Palos Hills"), {
      street: "420 Hickory Lane", city: "Palos Hills", state: null, zip: null,
    });
  });

  it("a bare street stays a bare street", () => {
    assert.deepEqual(parseAddressLine("17878 Argos Court"), {
      street: "17878 Argos Court", city: null, state: null, zip: null,
    });
  });

  it("drops a trailing country so it is not read as the city", () => {
    assert.equal(parseAddressLine("1 Main St, Chicago, IL 60601, USA").city, "Chicago");
  });

  it("never mistakes a unit for a town", () => {
    // "Apt 4" has a digit; treating it as the city would print it on the card
    // and route the cleaner nowhere.
    assert.equal(parseAddressLine("1 Main St, Apt 4").city, null);
  });

  it("a two-letter word that is not a state is treated as a city", () => {
    assert.equal(parseAddressLine("1 Main St, Hometown, ZZ").state, null);
  });

  it("returns the whole string as the street rather than guessing", () => {
    const r = parseAddressLine("somewhere behind the big oak");
    assert.equal(r.street, "somewhere behind the big oak");
    assert.equal(r.city, null);
  });

  it("empty in, empty out", () => {
    assert.deepEqual(parseAddressLine(null), { street: null, city: null, state: null, zip: null });
  });
});

describe("fillAddressGaps — what is already stored always wins", () => {
  it("never overwrites a component the office typed", () => {
    const r = fillAddressGaps(
      { street: "17878 Argos Court", city: "Orland Park", state: "IL", zip: "60467" },
      "17878 Argos Court, Tinley Park, IL 60477",
    );
    assert.equal(r.city, "Orland Park", "a corrected city must survive a stale one-line copy");
    assert.equal(r.zip, "60467");
  });

  it("fills only the blanks", () => {
    const r = fillAddressGaps({ street: "17878 Argos Court", city: null, state: null, zip: null },
      "17878 Argos Court, Tinley Park, IL 60477");
    assert.deepEqual(r, { street: "17878 Argos Court", city: "Tinley Park", state: "IL", zip: "60477" });
  });
});

describe("convert writes the components and the zone", () => {
  const quotes = read("../routes/quotes.ts");
  const client = read("../lib/materialize-client.ts");

  it("the job INSERT carries all four components", () => {
    const ins = quotes.slice(quotes.indexOf("INSERT INTO jobs ("), quotes.indexOf("RETURNING id"));
    for (const col of ["address_street", "address_city", "address_state", "address_zip"]) {
      assert.ok(ins.includes(col), `${col} must cascade — a street with no town is not an address`);
    }
  });

  it("the job INSERT assigns a zone", () => {
    const ins = quotes.slice(quotes.indexOf("INSERT INTO jobs ("), quotes.indexOf("RETURNING id"));
    assert.ok(ins.includes("zone_id"), "an unzoned job is a grey tile the board cannot route");
    assert.ok(quotes.includes("resolveZoneForZip(companyId, jobAddr.zip)"));
  });

  it("the client record gets the components too", () => {
    assert.ok(client.includes("address, city, state, zip"));
    assert.ok(client.includes("parseAddressLine(q.address"));
  });

  it("the client's own address wins over the quote's one-liner", () => {
    const block = quotes.slice(quotes.indexOf("const jobAddr = fillAddressGaps("));
    assert.ok(block.includes("clientAddrRow?.city"), "a corrected customer address is canonical");
  });

  it("an unresolvable zone is null, never guessed", () => {
    assert.ok(quotes.includes("jobAddr.zip ? await resolveZoneForZip") , "no zip, no zone");
  });
});
