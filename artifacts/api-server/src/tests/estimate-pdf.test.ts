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

  it("embeds a company logo when one is provided", async () => {
    // 1x1 transparent PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const buf = await renderEstimatePdf({
      ...base, logo: png, billingMode: "flat", flatPriceUnit: "month", scopeNote: null,
      items: [{ name: "Restrooms", pricing_type: "flat", frequency: "Semi-monthly", quantity: 1, unit_rate: 0, amount: 0 }],
    });
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  });

  it("route fetches the logo + streams inline; builder previews after saving", () => {
    const route = read("../routes/estimates.ts");
    const builder = read("../../../qleno/src/pages/estimate-builder.tsx");
    assert.match(route, /router\.get\("\/:id\/pdf"/);
    assert.match(route, /setHeader\("Content-Type", "application\/pdf"\)/);
    assert.match(route, /c\.logo_url AS company_logo/);
    assert.match(route, /const logo = await fetchLogoBuffer\(est\.company_logo\)/);
    assert.match(route, /renderEstimatePdf\(\{\s*companyName: est\.company_name \|\| "Estimate", logo,/);
    // PDF + Send must persist current edits first (no stale preview/send).
    assert.match(builder, /async function downloadPdf\(\) \{[\s\S]*?const savedId = await save\(\);/);
    assert.match(builder, /async function markSent\(\) \{[\s\S]*?const savedId = await save\(\);/);
    assert.match(builder, /PDF preview/);
  });
});
