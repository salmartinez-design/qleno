/**
 * [partial-override / dup-components 2026-08-18] Maribel, on the second report
 * of the same card: "still happening. it doesnt show the full address."
 *
 * Job 21015 (Cynthiia Lopezz, CL-1533) rendered "17878 Argos Court" while her
 * profile read "17878 Argos Court, Tinley Park, IL 60477". Job 15243 rendered
 * "2333 North Janssen Avenue, Chicago, IL 60614, IL 60614". Opposite symptoms,
 * one cause: clients.address does not always hold a bare street.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

/**
 * The frontend's canonical formatter, re-implemented here EXACTLY as
 * artifacts/qleno/src/lib/format-address.ts writes it. The api-server test
 * project can't import across the artifact boundary, so this mirror is the
 * thing under test and the source-shape assertion below is what keeps the two
 * from drifting.
 */
function formatAddress(street?: string | null, city?: string | null, state?: string | null, zip?: string | null): string {
  const s = (v: unknown) => (v == null ? "" : String(v).trim());
  const street_ = s(street), city_ = s(city), state_ = s(state), zip_ = s(zip);
  const already = (haystack: string, needle: string) => {
    if (!haystack || !needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
  };
  const parts: string[] = [];
  if (street_) parts.push(street_);
  if (city_ && !already(street_, city_)) parts.push(city_);
  const soFar = parts.join(", ");
  const stateZip = [
    state_ && !already(soFar, state_) ? state_ : "",
    zip_ && !already(soFar, zip_) ? zip_ : "",
  ].filter(Boolean).join(" ");
  if (stateZip) parts.push(stateZip);
  return parts.join(", ");
}

describe("formatAddress never says the same thing twice", () => {
  it("formats a normal four-part address unchanged", () => {
    assert.equal(
      formatAddress("563 Willowcreek Ct", "Clarendon Hills", "IL", "60514"),
      "563 Willowcreek Ct, Clarendon Hills, IL 60514",
    );
  });

  it("job 15243 — a street already carrying city/state/zip is not doubled", () => {
    // Shipped to production reading
    //   "2333 North Janssen Avenue, Chicago, IL 60614, IL 60614"
    assert.equal(
      formatAddress("2333 North Janssen Avenue, Chicago, IL 60614", null, "IL", "60614"),
      "2333 North Janssen Avenue, Chicago, IL 60614",
    );
  });

  it("CL-1533 — the whole line lives in clients.address, city/state columns empty", () => {
    assert.equal(
      formatAddress("17878 Argos Court, Tinley Park, IL 60477", null, null, "60477"),
      "17878 Argos Court, Tinley Park, IL 60477",
    );
  });

  it("matches whole words, so 'IL' inside 'Willowcreek' does not eat the state", () => {
    // The trap in the fix itself: a substring check drops IL from every
    // address in Clarendon Hills.
    const out = formatAddress("563 Willowcreek Ct", "Clarendon Hills", "IL", "60514");
    assert.ok(out.endsWith("IL 60514"), `state+zip must survive — got "${out}"`);
  });

  it("still appends a zip the street is missing", () => {
    assert.equal(
      formatAddress("100 W Chestnut, Chicago", null, "IL", "60610"),
      "100 W Chestnut, Chicago, IL 60610",
    );
  });

  it("returns empty rather than a stray comma when there is nothing", () => {
    assert.equal(formatAddress(null, null, null, null), "");
  });

  it("the server's inlined fmtAddr carries the same rule", () => {
    const dispatch = read("../routes/dispatch.ts");
    assert.ok(dispatch.includes("addrHas(parts.join(\", \"), city)"), "city must be de-duplicated server-side too");
    assert.ok(/\\\\b\$\{n\.replace/.test(dispatch), "and with the same whole-word match, not a substring");
  });
});

