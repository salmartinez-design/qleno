/**
 * Estimate PDF: renderEstimatePdf produces a real PDF Buffer for both flat and
 * itemized estimates; the route streams it; the builder has a PDF preview button.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderEstimatePdf } from "../lib/estimate-pdf.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

const base = {
  companyName: "Phes", estimateNumber: "EST-1001", status: "draft",
  title: "Office Cleaning", introNote: "Thanks for the opportunity.",
  contactName: "Brenda Graham", propertyName: "616 S Maplewood", serviceAddress: "616 S Maplewood Ave, Chicago, IL 60612",
  subtotal: 150, discount: 0, total: 150, terms: "Net-15.", validUntil: "2026-07-26",
};

describe("estimate PDF", () => {
  it("renders a flat-price estimate to a valid PDF buffer", async () => {
    const buf = await renderEstimatePdf({
      ...base, billingMode: "flat", flatPriceUnit: "visit", scopeNote: "Full janitorial each visit.",
      items: [{ name: "Restrooms", pricing_type: "flat", frequency: "Bi-weekly", quantity: 1, unit_rate: 0, amount: 0 }],
    });
    assert.ok(Buffer.isBuffer(buf) && buf.length > 800);
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  it("renders an itemized estimate to a valid PDF buffer", async () => {
    const buf = await renderEstimatePdf({
      ...base, billingMode: "itemized", flatPriceUnit: "visit", scopeNote: null,
      items: [{ name: "Floors", pricing_type: "hourly", frequency: "Weekly", quantity: 1.5, unit_rate: 50, amount: 75 }],
    });
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  it("route streams the PDF inline; builder has the preview button", () => {
    const route = read("../routes/estimates.ts");
    const builder = read("../../../qleno/src/pages/estimate-builder.tsx");
    assert.match(route, /router\.get\("\/:id\/pdf"/);
    assert.match(route, /setHeader\("Content-Type", "application\/pdf"\)/);
    assert.match(route, /renderEstimatePdf\(/);
    assert.match(builder, /async function downloadPdf/);
    assert.match(builder, /PDF preview/);
  });
});
