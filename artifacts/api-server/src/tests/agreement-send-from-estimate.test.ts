/** Send the commercial service agreement from a won estimate + seed the template. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("send agreement from estimate", () => {
  const route = read("../routes/estimates.ts");
  const mig = read("../phes-data-migration.ts");
  const form = read("../routes/form-templates.ts");
  const ui = read("../../../qleno/src/pages/estimate-builder.tsx");
  it("estimate endpoint creates submission + 'sent' event for the agreement template", () => {
    assert.match(route, /router\.post\("\/:id\/send-agreement"/);
    assert.match(route, /INSERT INTO form_submissions \(company_id, form_id, client_id, responses, status, sign_token/);
    assert.match(route, /VALUES \(\$\{companyId\}, \$\{submissionId\}, 'sent'/);
    assert.match(route, /signing_url: `\$\{appBaseUrl\(\)\}\/sign\/\$\{token\}`/);
  });
  it("migration seeds the Commercial Cleaning Service Agreement template", () => {
    assert.match(mig, /runAgreementTemplateSeed/);
    assert.match(mig, /COMMERCIAL CLEANING SERVICE AGREEMENT/);
    assert.match(mig, /INSERT INTO form_templates \(company_id, name, type, category, terms_body, requires_sign, is_active\)/);
  });
  it("builder send-from-estimate is wired + form-templates records 'sent'", () => {
    assert.match(ui, /async function sendAgreement/);
    assert.match(ui, /\/api\/estimates\/\$\{savedId\}\/send-agreement/);
    assert.match(ui, /Send agreement/);
    assert.match(form, /'sent', \$\{clientEmail \?\? null\}/);
  });
});
