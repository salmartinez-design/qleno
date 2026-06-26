/** Review/edit agreement before send + per-estimate tracking. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("agreement review + track", () => {
  const route = read("../routes/estimates.ts");
  const sign = read("../routes/sign.ts");
  const mig = read("../phes-data-migration.ts");
  const ui = read("../../../qleno/src/pages/estimate-builder.tsx");
  it("draft + list endpoints; send stores edited body + estimate link", () => {
    assert.match(route, /router\.get\("\/:id\/agreement-draft"/);
    assert.match(route, /router\.get\("\/:id\/agreements"/);
    assert.match(route, /INSERT INTO form_submissions \(company_id, form_id, client_id, estimate_id, responses, status, sign_token, sent_at, sent_to, expires_at, submitted_by, terms_body_override\)/);
  });
  it("sign flow uses the per-send edited body", () => {
    assert.match(sign, /terms_body_override: formSubmissionsTable\.terms_body_override/);
    assert.match(sign, /\(submission as any\)\.terms_body_override \|\| submission\.terms_body/);
    assert.match(mig, /form_submissions\.terms_body_override/);
    assert.match(mig, /form_submissions\.estimate_id/);
  });
  it("builder: review modal, send, tracker, More menu", () => {
    assert.match(ui, /async function openAgreement/);
    assert.match(ui, /async function submitAgreement/);
    assert.match(ui, /AGREEMENT TEXT — EDITABLE/);
    assert.match(ui, /function AgreementTracking/);
    assert.match(ui, /setMoreOpen/);
  });
});
