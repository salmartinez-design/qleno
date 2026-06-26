/** Send a Stripe card-on-file link from a won estimate (reuses save_card flow). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("estimate card-on-file link", () => {
  const route = read("../routes/estimates.ts");
  const ui = read("../../../qleno/src/pages/estimate-builder.tsx");
  it("ensure-client links/creates a client from the estimate contact", () => {
    assert.match(route, /router\.post\("\/:id\/ensure-client"/);
    assert.match(route, /INSERT INTO clients \(company_id, first_name, last_name, email, phone, client_type, payment_method\)/);
    assert.match(route, /UPDATE estimates SET client_id = \$\{clientId\}/);
  });
  it("builder sends the save_card link via payment-links", () => {
    assert.match(ui, /async function sendCardOnFile/);
    assert.match(ui, /\/api\/estimates\/\$\{savedId\}\/ensure-client/);
    assert.match(ui, /purpose: "save_card"/);
    assert.match(ui, /Card on file/);
  });
});
