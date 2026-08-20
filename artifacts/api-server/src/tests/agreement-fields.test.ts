import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMERCIAL_AGREEMENT_FIELDS } from "../lib/agreement-bodies.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

// [agreement-fields 2026-08-20] Both live commercial agreement templates in
// production carried the contract text and an EMPTY field list, so the signing
// page's "Your Information" step was a blank white gap and nobody was ever
// asked who was signing or in what role.
describe("commercial agreement fields", () => {
  it("the field list is real and well formed", () => {
    assert.ok(COMMERCIAL_AGREEMENT_FIELDS.length >= 5);
    for (const f of COMMERCIAL_AGREEMENT_FIELDS) {
      assert.ok(f.id && f.label && f.variable, `field missing id/label/variable: ${JSON.stringify(f)}`);
      assert.match(f.variable, /^[a-z][a-z0-9_]*$/);
    }
    const ids = COMMERCIAL_AGREEMENT_FIELDS.map(f => f.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate field id");
    const vars = COMMERCIAL_AGREEMENT_FIELDS.map(f => f.variable);
    assert.equal(new Set(vars).size, vars.length, "duplicate variable");
  });

  it("asks who is signing and in what role", () => {
    const vars = COMMERCIAL_AGREEMENT_FIELDS.filter(f => f.required).map(f => f.variable);
    for (const v of ["client_company", "full_name", "signer_title", "address", "phone", "email"]) {
      assert.ok(vars.includes(v), `required field missing: ${v}`);
    }
  });

  it("does not restate what the estimate governs", () => {
    // The commercial contract incorporates the estimate by reference. Asking the
    // customer to restate frequency, scope or price here would let a signed
    // agreement contradict the estimate it points at.
    const vars = COMMERCIAL_AGREEMENT_FIELDS.map(f => f.variable);
    for (const v of ["service_frequency", "scope_of_work", "rate", "price"]) {
      assert.ok(!vars.includes(v), `field should not be collected at signing: ${v}`);
    }
  });

  it("uses the variable names the signing page prefills", () => {
    const page = read("../../../qleno/src/pages/sign.tsx");
    for (const f of COMMERCIAL_AGREEMENT_FIELDS) {
      if (["signer_title", "billing_email", "access_notes"].includes(f.variable)) continue;
      assert.match(page, new RegExp(`\\b${f.variable}:`), `sign.tsx does not prefill ${f.variable}`);
    }
  });

  it("the signing page will not continue past a blank required field", () => {
    const page = read("../../../qleno/src/pages/sign.tsx");
    assert.match(page, /const missingRequired = fields\.filter/);
    assert.match(page, /disabled=\{missingRequired\.length > 0\}/);
  });

  it("the boot migration fills only a template that has no fields", () => {
    const mig = read("../phes-data-migration.ts");
    assert.match(mig, /\[agreement-fields 2026-08-20\]/);
    assert.match(mig, /jsonb_typeof\(schema\) <> 'array' OR jsonb_array_length\(schema\) = 0/);
    assert.match(mig, /AND category = 'commercial'\n\s*AND is_active = true/);
  });

  it("seed-defaults hands a new tenant the same list", () => {
    const route = read("../routes/form-templates.ts");
    assert.match(route, /schema: COMMERCIAL_AGREEMENT_FIELDS as any/);
    assert.ok(!/category: "commercial",\s*\n\s*schema: \[\] as any/.test(route));
  });
});
