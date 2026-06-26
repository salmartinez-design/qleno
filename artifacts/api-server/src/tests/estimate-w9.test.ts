/** Fillable IRS W-9: renderW9 fills the official template; routes save + serve it. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderW9 } from "../lib/w9-pdf.ts";
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

describe("company W-9", () => {
  it("renders the official W-9 to a real PDF (EIN + SSN paths)", async () => {
    const a = await renderW9({ legalName: "Phes Cleaning LLC", businessName: "Phes", classification: "llc", llcClass: "S", ein: "12-3456789", address: "9850 S Cicero Ave", cityStateZip: "Oak Lawn, IL 60453" });
    assert.equal(a.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(a.length > 50000);
    const b = await renderW9({ legalName: "Jane Doe", classification: "individual", ssn: "123456789" });
    assert.equal(b.subarray(0, 5).toString("latin1"), "%PDF-");
  });
  it("routes save + serve the W-9; migration adds tax columns", () => {
    const route = read("../routes/companies.ts");
    const mig = read("../phes-data-migration.ts");
    assert.match(route, /router\.put\("\/w9"/);
    assert.match(route, /router\.get\("\/w9\.pdf"/);
    assert.match(route, /reason: "no_ein"/);
    assert.match(mig, /companies\.w9_ein/);
  });
  it("settings page exists + is routed", () => {
    const page = read("../../../qleno/src/pages/company/w9.tsx");
    const app = read("../../../qleno/src/App.tsx");
    assert.match(page, /export default function CompanyW9Page/);
    assert.match(page, /\/api\/companies\/w9\.pdf/);
    assert.match(app, /component=\{CompanyW9Page\}/);
  });
});
