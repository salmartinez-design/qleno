/** DocuSign-grade agreements: audit events + Certificate of Completion. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderAgreementCertificate } from "../lib/agreement-certificate.ts";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("agreement e-sign + audit trail", () => {
  it("renders a Certificate of Completion PDF", async () => {
    const buf = await renderAgreementCertificate({
      companyName: "Phes", agreementTitle: "Commercial Cleaning Service Agreement", envelopeId: "QL-ABCD1234",
      signerName: "Danni Varenhorst", signerEmail: "d@x.com", status: "completed", contentHash: "a3f1", consent: true,
      events: [{ type: "sent", at: "2026-03-10T15:14:00Z" }, { type: "signed", at: "2026-03-10T17:05:00Z", ip: "1.2.3.4", userAgent: "Chrome" }, { type: "sealed", at: "2026-03-10T17:05:01Z" }],
    });
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(buf.length > 1500);
  });
  it("send records 'sent', sign requires consent + records signed/sealed, certificate endpoint exists", () => {
    const route = read("../routes/agreement-templates.ts");
    assert.match(route, /event_type, actor_email, meta\)\s*\n\s*VALUES \(\$\{req\.auth!\.companyId\}, \$\{agreement\.id\}, 'sent'/);
    assert.match(route, /typed_name and consent required/);
    assert.match(route, /'signed', \$\{row\.signer_email \?\? null\}, \$\{ip_address\}, \$\{ua\}/);
    assert.match(route, /'sealed'/);
    assert.match(route, /router\.get\("\/agreements\/:id\/certificate\.pdf"/);
  });
  it("migration adds the audit table + consent columns", () => {
    const mig = read("../phes-data-migration.ts");
    assert.match(mig, /CREATE TABLE IF NOT EXISTS agreement_events/);
    assert.match(mig, /client_agreements\.consent_at/);
  });
});
