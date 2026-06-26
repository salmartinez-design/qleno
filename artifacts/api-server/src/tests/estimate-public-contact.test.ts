/**
 * Hosted estimate contact: branch phone (when set) else company phone + company
 * email — never the old hardcoded Schaumburg fallback. Source-assertion guard.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("hosted estimate contact (branch-aware, not hardcoded)", () => {
  const route = read("../routes/estimates.ts");
  const pub = read("../../../qleno/src/pages/estimate-public.tsx");

  it("public route returns company + branch contact", () => {
    assert.match(route, /c\.phone AS company_phone, c\.email AS company_email/);
    assert.match(route, /LEFT JOIN branches bz ON bz\.id = e\.branch_id/);
    assert.match(route, /bz\.name AS branch_name, bz\.phone AS branch_phone/);
  });
  it("page uses branch→company contact and drops the Schaumburg hardcode", () => {
    assert.match(pub, /est\.branch_phone \|\| est\.company_phone \|\| null/);
    assert.match(pub, /est\.company_email \|\| null/);
    assert.doesNotMatch(pub, /847.*538.*3729/);
    assert.doesNotMatch(pub, /schaumburg@phes\.io/);
  });
});
