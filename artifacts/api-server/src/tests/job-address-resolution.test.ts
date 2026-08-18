// [addr-city-state 2026-08-08] Jess Wilhite (CL-1520), booked online 8/8.
//
// The customer typed the wrong address. The office corrected the client record to
// "333 North Jefferson Street, Chicago, IL 60661". The job card kept showing
// "333 North Jefferson Street, Brownsburg, IN 60661" — an address that exists
// NOWHERE: stale city and state from the job, corrected zip from the client.
// Maribel: "the zip code was updated but not the state and city."
//
// Two cooperating bugs:
//
//  1. Every address comparison in jobs.ts tested street + zip only. A job
//     differing ONLY in city/state read as "identical to the client address", so
//     the edit was written at CLIENT level and the job's own stale
//     address_city / address_state were left untouched — and the cascade that
//     would have rewritten them skipped it for the same reason.
//
//  2. dispatch.ts resolved each component with its own COALESCE(job, client), so
//     a job holding SOME fields rendered a hybrid of two different addresses.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

const jobs = read("../routes/jobs.ts");
const dispatch = read("../routes/dispatch.ts");

// The PATCH /:id/address handler only.
const addrRoute = jobs.slice(jobs.indexOf('router.patch("/:id/address"'));

describe("job vs client address: comparisons include city and state", () => {
  it("override auto-detection compares all four components", () => {
    // Scope to the boolean expression itself. A wider slice would sweep in the
    // ctx SELECT, which names j_city/j_state as aliases and would make this pass
    // against the very code it's meant to catch.
    const expr = addrRoute.slice(
      addrRoute.indexOf("const autoPickedJobOverride"),
      addrRoute.indexOf("let mode:"),
    );
    assert.ok(expr.length > 0, "autoPickedJobOverride must exist");
    for (const part of ["j_addr", "j_city", "j_state", "j_zip"]) {
      assert.ok(
        expr.includes(part),
        `override detection must compare ${part} — city/state were the missing pair`,
      );
    }
  });

  it("the cascade preview counts city/state differences", () => {
    const preview = addrRoute.slice(addrRoute.indexOf("AS has_override"), addrRoute.indexOf("AS is_same"));
    assert.ok(preview.includes("j.address_city"));
    assert.ok(preview.includes("j.address_state"));
  });

  it("the cascade WRITE matches the preview's test exactly", () => {
    // If these two drift, the office is shown one count in the prompt and a
    // different set of jobs is actually rewritten.
    const write = addrRoute.slice(addrRoute.indexOf("const sameOnly"));
    const clause = write.slice(0, write.indexOf("const cascaded"));
    assert.ok(clause.includes("address_city"));
    assert.ok(clause.includes("address_state"));
    assert.ok(clause.includes("address_zip"));
    assert.ok(clause.includes("address_street"));
  });
});

describe("dispatch resolves an address as a unit", () => {
  const block = dispatch.slice(
    dispatch.indexOf("[addr-city-state 2026-08-08]"),
    dispatch.indexOf("job_address_street:"),
  );

  it("no component falls back independently", () => {
    // The bug shape: COALESCE(NULLIF(jobs.address_city,''), clients.city) — each
    // field choosing its own source, so two addresses could blend into one.
    assert.ok(block.length > 0, "the unit-resolution block must exist");
    assert.ok(
      !/COALESCE\(NULLIF\(\$\{jobsTable\.address_/.test(block),
      "per-field COALESCE job→client is what produced the hybrid address",
    );
  });

  it("all four components switch on the same signal", () => {
    // [partial-override 2026-08-18] The signal is now the shared
    // JOB_HAS_OWN_ADDRESS expression (lib/job-address.ts) rather than a
    // hand-repeated CASE. What matters is unchanged and is what this asserts:
    // every arm switches on the SAME thing, so no component can pick its own
    // source and blend two addresses.
    const cases = block.match(/CASE WHEN \$\{JOB_HAS_OWN_ADDRESS\}/g) ?? [];
    assert.equal(cases.length, 5, "client_zip + address + city + state + zip");
  });
});

describe("a street with nothing else is not an override", () => {
  // [partial-override 2026-08-18] Maribel, second report on the same card:
  // "still happening. it doesnt show the full address." The booking and quote
  // flows write a street and no city/state/zip; because the components resolve
  // as a unit, that partial snapshot suppressed the CLIENT's city, state and
  // zip too. Cynthiia Lopezz (CL-1533, job 21015) rendered "17878 Argos Court"
  // while her profile read "17878 Argos Court, Tinley Park, IL 60477".
  const jobAddress = read("../lib/job-address.ts");

  it("requires a city or a zip beyond the street", () => {
    const fn = jobAddress.slice(jobAddress.indexOf("export function jobHasOwnAddress"));
    assert.ok(fn.includes("address_street"), "street is still necessary");
    assert.ok(
      /address_city[\s\S]*OR[\s\S]*address_zip/.test(fn),
      "and one component beyond it — otherwise it is an incomplete copy, not a second location",
    );
  });

  it("dispatch uses the shared signal rather than its own copy", () => {
    assert.ok(dispatch.includes("jobHasOwnAddress(jobsTable)"));
    assert.ok(
      !/CASE WHEN NULLIF\(BTRIM\(\$\{jobsTable\.address_street\}\), ''\) IS NOT NULL\s*\n\s*THEN \$\{jobsTable\.address_/.test(dispatch),
      "the old street-only signal must not survive anywhere in the resolver",
    );
  });
});
