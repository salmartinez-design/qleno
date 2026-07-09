/** Live sign flow (form_submissions) gains the DocuSign-grade audit trail. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("live sign audit trail", () => {
  const sign = read("../routes/sign.ts");
  const ui = read("../../../qleno/src/pages/sign.tsx");
  const mig = read("../phes-data-migration.ts");
  it("records viewed, requires consent, records signed/sealed, serves certificate", () => {
    assert.match(sign, /SET viewed_at = now\(\) WHERE sign_token = \$\{token\} AND viewed_at IS NULL/);
    assert.match(sign, /'viewed'/);
    assert.match(sign, /Signature and consent are required/);
    assert.match(sign, /'signed'/);
    assert.match(sign, /'sealed'/);
    assert.match(sign, /router\.get\("\/:token\/certificate\.pdf"/);
  });
  it("frontend sends consent + offers the certificate", () => {
    assert.match(ui, /ip_address: "client", agreed/);
    assert.match(ui, /\/api\/sign\/\$\{token\}\/certificate\.pdf/);
    assert.match(ui, /Certificate of Completion/);
  });
  it("migration adds form_submissions audit columns", () => {
    assert.match(mig, /form_submissions\.viewed_at/);
    assert.match(mig, /form_submissions\.consent_at/);
  });
});
